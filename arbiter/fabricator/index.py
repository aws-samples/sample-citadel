if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()

import json
import logging
from datetime import datetime, timezone
from typing import Any
from strands import Agent, tool, models
from strands_tools import file_write, http_request, shell
import os
from tools_config import load_config_from_dynamodb, create_tool_desc
from design_assessment_gate import check_design_assessment, DesignAssessmentMissingError
import boto3
from botocore.config import Config

def _cross_region_prefix(region: str) -> str:
    if region.startswith('us-'): return 'us'
    if region.startswith('eu-'): return 'eu'
    if region == 'ap-southeast-2': return 'au'
    if region.startswith('ap-'): return 'apac'
    if region.startswith('me-'): return 'me'
    if region.startswith('ca-'): return 'ca'
    if region.startswith('sa-'): return 'sa'
    return 'us'

_REGION = os.environ.get('AWS_REGION', 'us-west-2')
_MODEL_PREFIX = _cross_region_prefix(_REGION)
FABRICATOR_MODEL_ID = f"{_MODEL_PREFIX}.anthropic.claude-sonnet-4-6"

logger = logging.getLogger(__name__)

os.environ.setdefault("BYPASS_TOOL_CONSENT", "true")


_registry_client = None


def _get_registry_client():
    """Lazy boto3 client for bedrock-agentcore-control Registry APIs.

    QB-013-1 pattern: construct at first call so module import is cheap.
    """
    global _registry_client
    if _registry_client is None:
        _registry_client = boto3.client('bedrock-agentcore-control')
    return _registry_client


def _reset_registry_client_for_test() -> None:
    """Test-only hook — forces the next call to rebuild the cached client."""
    global _registry_client
    _registry_client = None


def _find_existing_record_id(registry_id: str, agent_id: str) -> str | None:
    """Return the recordId of an existing Registry record named ``agent_id``.

    Idempotency support for ``store_agent_config_registry``: SQS redeliveries
    and re-triggers must not create duplicate Registry records for the same
    agent name. Mirrors ``resolveRecordId`` / ``listResources`` in
    ``backend/src/services/registry-service.ts`` — list CUSTOM records and
    match on the record name. Uses the server-side ``name`` filter to bound
    the result set, then verifies an EXACT name match (the filter may be a
    prefix / substring match) and paginates via ``nextToken``.

    Returns the matched recordId, or ``None`` when no record with that exact
    name exists. Defensive ``isinstance`` guards keep the loop bounded if the
    API surfaces an unexpected (non-dict) shape so the caller falls back to
    the create path rather than hanging or raising.
    """
    client = _get_registry_client()
    next_token = None
    while True:
        kwargs: dict[str, Any] = {
            "registryId": registry_id,
            "descriptorType": "CUSTOM",
            "name": agent_id,
        }
        if next_token:
            kwargs["nextToken"] = next_token
        response = client.list_registry_records(**kwargs)
        if not isinstance(response, dict):
            return None
        for summary in response.get("records", []):
            if isinstance(summary, dict) and summary.get("name") == agent_id:
                return summary.get("recordId")
        next_token = response.get("nextToken")
        if not isinstance(next_token, str) or not next_token:
            break
    return None


def _write_app_meta_row(
    record_id: str,
    agent_id: str,
    agent_description: str,
    requested_by: str,
    org_id: str,
) -> bool:
    """Write the AppsTable #META row for a freshly-created Registry agent record.

    Mirrors backend/src/utils/apps-table-meta.ts upsertAppMeta. Eventually-consistent:
    failures log and return False; the reconciler script catches drift.

    Args:
        record_id: Registry recordId returned by create_registry_record (12-char alphanumeric).
        agent_id: Caller-supplied agent name (used as #META row name field).
        agent_description: Plain-text human description.
        requested_by: AppSync caller identity threaded from the SQS event, or 'fabricator'.
        org_id: Caller's org from the JWT claim, or '' for transition window.

    Returns:
        True on success, False on any failure (logged).
    """
    apps_table = os.environ.get('APPS_TABLE')
    if not apps_table:
        logger.warning('_write_app_meta_row: APPS_TABLE env var not set; skipping')
        return False
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    try:
        boto3.client('dynamodb').update_item(
            TableName=apps_table,
            Key={'appId': {'S': record_id}},
            UpdateExpression=(
                'SET #orgId = :orgId, #name = :name, #description = :description, '
                '#status = :status, #workflowIds = :workflowIds, '
                '#routingConfig = :routingConfig, #createdBy = :createdBy, '
                '#createdAt = :createdAt, #updatedAt = :updatedAt, '
                '#version = :version, #sortId = :sortId'
            ),
            ExpressionAttributeNames={
                '#orgId': 'orgId',
                '#name': 'name',
                '#description': 'description',
                '#status': 'status',
                '#workflowIds': 'workflowIds',
                '#routingConfig': 'routingConfig',
                '#createdBy': 'createdBy',
                '#createdAt': 'createdAt',
                '#updatedAt': 'updatedAt',
                '#version': 'version',
                '#sortId': 'sortId',
            },
            ExpressionAttributeValues={
                ':orgId': {'S': org_id or ''},
                ':name': {'S': agent_id or ''},
                ':description': {'S': agent_description or ''},
                ':status': {'S': 'DRAFT'},
                ':workflowIds': {'L': []},
                ':routingConfig': {'S': ''},
                ':createdBy': {'S': requested_by or 'fabricator'},
                ':createdAt': {'S': now},
                ':updatedAt': {'S': now},
                ':version': {'N': '1'},
                ':sortId': {'S': 'METADATA'},
            },
        )
        return True
    except Exception as e:  # noqa: BLE001 — eventually-consistent: never propagate
        logger.warning(
            f'_write_app_meta_row failed (eventually-consistent, reconciler will recover): {e}'
        )
        return False

# ~7 day TTL (epoch seconds) keeps the fabrication-jobs table self-pruning.
FABRICATION_JOBS_TTL_SECONDS = 7 * 24 * 60 * 60


def _write_fabrication_status(
    orchestration_id: str,
    agent_use_id: str,
    status: str,
    agent_id: str | None = None,
    error_message: str | None = None,
    agent_name: str | None = None,
) -> bool:
    """Upsert a per-agent fabrication status row in the durable jobs table.

    Mirrors the ingestion jobs-table pattern: the table
    (``citadel-fabrication-jobs-${env}``) is keyed by orchestrationId (PK) /
    agentUseId (SK). process_event calls this at the START (PROCESSING), on
    SUCCESS (COMPLETED + agentId) and on EXCEPTION (FAILED + errorMessage).

    Backward-compatible and best-effort: when ``FABRICATION_JOBS_TABLE`` is
    unset the write is skipped (logged); any failure is logged and swallowed
    so a status-write error NEVER changes fabrication success/failure
    behavior. Never an empty except.

    Returns True on a successful write, False when skipped or on failure.
    """
    table = os.environ.get("FABRICATION_JOBS_TABLE")
    if not table:
        logger.info(
            "_write_fabrication_status: FABRICATION_JOBS_TABLE unset; "
            "skipping status=%s for %s/%s",
            status, orchestration_id, agent_use_id,
        )
        return False

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    set_parts = ["#status = :status", "#updatedAt = :updatedAt", "#ttl = :ttl"]
    names = {"#status": "status", "#updatedAt": "updatedAt", "#ttl": "ttl"}
    import time as _time
    values: dict[str, Any] = {
        ":status": {"S": status},
        ":updatedAt": {"S": now},
        ":ttl": {"N": str(int(_time.time()) + FABRICATION_JOBS_TTL_SECONDS)},
    }
    # submittedAt: stamp the first write with a real submit time so the queue
    # view never falls back to epoch-0 (1970). if_not_exists preserves a
    # producer-set value (e.g. the PENDING row) on later writes.
    set_parts.append("submittedAt = if_not_exists(submittedAt, :submittedAt)")
    values[":submittedAt"] = {"S": now}
    # agentName: thread the human-readable name (== agent_use_id for intake)
    # so the resolver can render it instead of 'Unknown Agent'. if_not_exists
    # never clobbers a producer-set name (the UI-direct path's PENDING row).
    if agent_name is not None:
        set_parts.append("agentName = if_not_exists(agentName, :agentName)")
        values[":agentName"] = {"S": agent_name}
    if agent_id is not None:
        set_parts.append("#agentId = :agentId")
        names["#agentId"] = "agentId"
        values[":agentId"] = {"S": agent_id}
    if error_message is not None:
        set_parts.append("#errorMessage = :errorMessage")
        names["#errorMessage"] = "errorMessage"
        values[":errorMessage"] = {"S": error_message[:1000]}

    try:
        boto3.client("dynamodb").update_item(
            TableName=table,
            Key={
                "orchestrationId": {"S": orchestration_id},
                "agentUseId": {"S": agent_use_id},
            },
            UpdateExpression="SET " + ", ".join(set_parts),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        return True
    except Exception as e:  # noqa: BLE001 — best-effort: never change outcome
        logger.warning(
            "_write_fabrication_status failed (status=%s, %s/%s): %s",
            status, orchestration_id, agent_use_id, e,
        )
        return False


# Retry configuration for Bedrock API calls — exponential backoff with jitter
BEDROCK_RETRY_CONFIG = Config(
    retries={
        'max_attempts': 3,
        'mode': 'adaptive',  # adaptive mode uses exponential backoff with jitter
    },
    read_timeout=3600,
)

def get_tool_fabricator_prompt():
    """System prompt for the Tool Fabricator agent"""
    TOOL_FABRICATOR_PROMPT = """
    <role>
    You are the Tool Fabricator Agent. Your sole responsibility is to generate custom Python tool functions using the @tool decorator from the Strands SDK and persist them to storage.
    </role>

    <mandatory_tool_structure>
    Every tool you create MUST follow this pattern:

    from strands import tool

    @tool
    def tool_name(param: type) -> return_type:
        \"""Clear description of what the tool does.
        
        Args:
            param: Description of parameter
            
        Returns:
            Description of return value
        \"""
        # Implementation here
        return result

    <rules>
    - Tool function MUST use @tool decorator
    - MUST have clear docstring with Args and Returns sections
    - MUST have type hints
    - NO tests, NO example usage code
    - Keep implementation simple and focused
    - Use standard library when possible
    - NO external API calls unless absolutely necessary
    </rules>
    </mandatory_tool_structure>

    <critical_workflow>
    For EVERY tool request, you MUST execute ALL FOUR steps using your available tools:
    
    STEP 1: Design the tool mentally (determine name, parameters, return type, implementation)
    
    STEP 2: Call file_write tool to save it to /tmp/[tool_name].py
    
    STEP 3: Call upload_tool_to_s3 tool with the file path
    
    STEP 4: Call store_tool_config_registry tool with:
       - file_name: "/tmp/[tool_name].py"
       - tool_id: the tool function name (e.g., "calculate_percentage")
       - tool_schema: OpenAPI-compliant JSON schema like:
         {
           "type": "object",
           "properties": {
             "param_name": {
               "type": "string",
               "description": "Parameter description"
             }
           },
           "required": ["param_name"]
         }
       - tool_description: brief one-sentence description
    
    CRITICAL: The tool is NOT registered in AgentCore Registry and CANNOT be used until store_tool_config_registry is called.
    If you skip this step, the tool will be lost and unusable.
    
    YOU MUST ACTUALLY CALL ALL THREE TOOLS (file_write, upload_tool_to_s3, store_tool_config_registry) IN SEQUENCE. Do not just describe what you would do.
    After calling each tool, verify it succeeded before moving to the next step.
    </critical_workflow>

    <example_execution>
    User request: "Create a tool that validates email addresses"
    
    Your actions (YOU MUST DO ALL OF THESE IN ORDER):
    
    Step 1 - Design the tool:
    - Tool name: validate_email
    - Parameters: email (string)
    - Returns: boolean
    
    Step 2 - Generate the complete tool code as a string
    
    Step 3 - CALL file_write tool (REQUIRED):
    file_write(
        path="/tmp/validate_email.py",
        content='''from strands import tool

    @tool
    def validate_email(email: str) -> bool:
        \"""Validate if a string is a valid email address.
        
        Args:
            email: Email address to validate
            
        Returns:
            True if valid email, False otherwise
        \"""
        import re
        pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
        return bool(re.match(pattern, email))
    '''
        )
        ✓ Step 3 complete - file written
        
        Step 4 - CALL upload_tool_to_s3 tool (REQUIRED):
        upload_tool_to_s3(file_path="/tmp/validate_email.py")
        ✓ Step 4 complete - file uploaded to S3
        
        Step 5 - CALL store_tool_config_registry tool (REQUIRED - MOST CRITICAL STEP):
        store_tool_config_registry(
            file_name="/tmp/validate_email.py",
            tool_id="validate_email",
            tool_schema={
                "type": "object",
                "properties": {
                    "email": {
                        "type": "string",
                        "description": "Email address to validate"
                    }
                },
                "required": ["email"]
            },
            tool_description="Validates if a string is a valid email address"
        )
        ✓ Step 5 complete - tool registered in Registry
        
        Step 6 - Verify all three tools were called:
        ✓ file_write - YES
        ✓ upload_tool_to_s3 - YES  
        ✓ store_tool_config_registry - YES
        
        ✅ TOOL CREATION COMPLETE - Tool is now discoverable and usable by other agents
        
        CRITICAL: You must call ALL THREE tools (file_write, upload_tool_to_s3, store_tool_config_registry) for every tool creation request.
        If you skip store_tool_config_registry, the tool will be created but NOT registered, making it invisible to the system.
        </example_execution>

        <tool_code_example>
        from strands import tool

        @tool
        def calculate_percentage(value: float, total: float) -> float:
            \"""Calculate the percentage of a value relative to a total.
            
            Args:
                value: The value to calculate percentage for
                total: The total value to compare against
                
            Returns:
                The percentage as a float
            \"""
            if total == 0:
                return 0.0
            return (value / total) * 100.0
        </tool_code_example>

        <reminder>
        ⚠️ MANDATORY: You have THREE tools that MUST ALL be called for EVERY tool creation ⚠️
        
        1. file_write - Save the tool code to /tmp/[tool_name].py
        2. upload_tool_to_s3 - Upload the file to S3 storage
        3. store_tool_config_registry - Register the tool in AgentCore Registry
        
        ❌ FAILURE MODE: If you only call file_write and upload_tool_to_s3 but skip store_tool_config_registry,
        the tool will NOT be registered in the Registry and CANNOT be discovered or used by other agents.
        
        ✅ SUCCESS CRITERIA: The tool creation is ONLY complete when ALL THREE tools have been called successfully.
        
        Do not just return text describing what you did - you must ACTUALLY CALL all three tools.
        After each tool call, verify it succeeded before proceeding to the next step.
        
        VERIFICATION CHECKLIST:
        □ Called file_write with tool code
        □ Called upload_tool_to_s3 with file path
        □ Called store_tool_config_registry with tool_id, schema, and description
        
        Only after all three checkboxes are complete is the tool ready for use.
        </reminder>

        <binding_aware_tool_generation>
        When the tool request includes binding metadata (integration or data store bindings),
        you MUST generate code that uses scoped credentials from environment variables.

        For DATA STORE bindings:
        - The tool will run in a subprocess with scoped AWS credentials injected as environment variables.
        - Use the appropriate AWS SDK client for the data store type (e.g., boto3 DynamoDB client for DYNAMODB, S3 client for S3).
        - Do NOT hardcode credentials — use the default boto3 credential chain which picks up the scoped env vars.
        - Implement only the operations specified in the binding (e.g., get_item, query for DYNAMODB).

        For INTEGRATION bindings:
        - The tool will run with scoped credentials that allow access to the integration's secrets.
        - Retrieve integration credentials from AWS Secrets Manager or SSM Parameter Store using the scoped credentials.
        - Implement HTTP calls with proper authentication based on the integration's auth method:
          * API_KEY: Include the key as a header or query parameter
          * OAUTH2: Use Bearer token in Authorization header
          * BASIC_AUTH: Use base64-encoded credentials in Authorization header
          * BEARER_TOKEN: Use token in Authorization header
          * IAM_ROLE: Use SigV4 signing for AWS service calls

        When calling store_tool_config_registry, pass the binding metadata:
        - integration_bindings: list of integration binding dicts from the request
        - datastore_bindings: list of data store binding dicts from the request
        </binding_aware_tool_generation>
    """
    return TOOL_FABRICATOR_PROMPT

def get_agent_fabricator_prompt():
    """System prompt for the Agent Fabricator agent"""
    tool_configs = load_config_from_dynamodb()
    worker_tools_list = '\n'.join(create_tool_desc(tool_configs))

    AGENT_FABRICATOR_PROMPT = f"""
    <role>
    You are the Fabricator Agent in a multi-agent system. Your sole responsibility is to generate Python code for new Strands agents that execute tasks defined by a Supervisor Agent. You do not execute tasks—you create the agents that will.
    </role>

    <architecture>
    Supervisor → requests new agent capability
    ↓
    Fabricator (YOU) → generates agent code
    ↓
    Evaluator → validates compliance before deployment
    </architecture>

    <mandatory_code_structure>
    Every agent you create MUST follow the code template.
    the agent will be called by the supervisor by using the "handler" function.
    if you call the main entry point anything other than "handler" it will not execute.

    <code_template>
    from strands import Agent, models

    def handler(input_param):
        \"""Clear docstring: purpose, inputs, outputs, constraints\"""
        bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            region_name="us-west-2"
        )
        agent = Agent(bedrock_model, tools=[...])
        result = agent("task prompt")
        return result
    </code_template>

    <non_negotiable_rules>
    - Function MUST be named `handler`
    - MUST use `models.BedrockModel` from strands package
    - MUST be a single, importable Python file
    - MUST include module-level docstring
    - NO tests, NO UI, NO user interaction code
    </non_negotiable_rules>
    </mandatory_code_structure>

    <tool_selection_hierarchy>
    Follow this priority when choosing tools:

    <priority_1_strands_builtin_tools>
    Use these first if they meet the requirement:
    - file_read, file_write, editor - File operations
    - shell - OS commands
    - http_request - API calls
    - python_repl - Python code execution
    - calculator - Math operations
    - use_aws - AWS services
    - retrieve - Bedrock Knowledge Base
    - memory, mem0_memory, environment - Persistent storage
    - journal, speak - Logging/output
    - generate_image, image_reader - Image operations
    - think - Complex reasoning
    - current_time, sleep, stop - Utilities
    - swarm, workflow, batch - Orchestration
    - use_llm - customized system prompts for specialized tasks
    </priority_1_strands_builtin_tools>

    <priority_2_worker_tools>
    If no Strands tool fits, check Worker Tools List:
    {worker_tools_list}

    Read the function code and write it into the agent as shown in examples below.
    </priority_2_worker_tools>

    <priority_3_custom_tools>
    Only create custom tools if Priorities 1 and 2 cannot satisfy the requirement.

    IMPORTANT: DO NOT write custom tool code yourself. Instead, use the create_custom_tool function:
    1. Call create_custom_tool with a detailed description of what the tool should do
    2. The Tool Fabricator will generate the tool code for you
    3. Extract the tool function code from the response
    4. Include the tool code directly in your agent file

    Example usage:
    tool_code = create_custom_tool("Create a tool that validates email addresses and returns True if valid, False otherwise")
    # Then include the returned tool code in your agent
    </priority_3_custom_tools>
    </tool_selection_hierarchy>

    <agent_with_custom_tool_pattern>
    When you need a custom tool, request it from the Tool Fabricator and include the generated code:

    <workflow>
    1. Identify that you need a custom tool
    2. Call create_custom_tool("description of what the tool should do")
    3. Parse the tool code from the Tool Fabricator's response
    4. Include the tool code in your agent file
    5. Use the tool in your agent
    </workflow>

    <example>
    from strands import Agent, tool, models

    # Tool code generated by Tool Fabricator (included directly in agent file)
    @tool
    def validate_email(email: str) -> bool:
        \"""Validate if a string is a valid email address.
        
        Args:
            email: Email address to validate
            
        Returns:
            True if valid email, False otherwise
        \"""
        import re
        pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{{2,}}$'
        return bool(re.match(pattern, email))

    def handler(email_address: str) -> str:
        \"""Agent that validates email addresses using custom tool\"""
        bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            region_name="us-west-2"
        )
        agent = Agent(bedrock_model, tools=[validate_email])
        result = agent(f"Is this a valid email: {{email_address}}?")
        return result
    </example>
    </agent_with_custom_tool_pattern>

    <governance_compliance>
    Your generated agents MUST:
    - Use /tmp/ for all file writes before S3 upload
    - Be deterministic (no random behavior unless explicitly required)
    - Include meaningful logging via journal or speak tools

    Your generated agents MUST NOT:
    - Use unbounded recursion
    - Use unrestricted shell execution
    - Expose credentials in code
    - Use self-modifying code
    </governance_compliance>

    <autonomous_operation>
    - DO NOT ask clarifying questions
    - DO make reasonable assumptions and document them
    - DO infer missing details logically
    - DO include assumptions in your AGENT DESIGN SUMMARY
    </autonomous_operation>

    <persistence_workflow>
    After generating the agent code, you MUST persist the agent by calling these tools in order:

    STEP 1: Call file_write to save the agent code to /tmp/[agent_name].py

    STEP 2: Call upload_agent_to_s3 with the file path to upload to S3 storage

    STEP 3: Call store_agent_config_registry with:
       - file_name: "/tmp/[agent_name].py"
       - agent_id: the agent identifier (e.g., "email_validator_agent")
       - llm_tool_schema: OpenAPI-compliant JSON schema describing the handler's input parameters
       - agent_description: brief one-sentence description of what the agent does
       - app_id: (optional) the app identifier if the agent is scoped to a specific app

    CRITICAL: The agent is NOT registered in AgentCore Registry and CANNOT be discovered or
    invoked by the Supervisor until store_agent_config_registry is called. Skipping this
    step means the fabricated agent is lost.

    Fabricated agents are created with initial status DRAFT (mapped to internal state
    "inactive"), which means they require activation before use. Do not attempt to set
    the status yourself — store_agent_config_registry handles this automatically.

    STEP 4: Call complete_task to signal fabrication is done.

    VERIFICATION CHECKLIST:
    □ Called file_write with agent code to /tmp/
    □ Called upload_agent_to_s3 with the file path
    □ Called store_agent_config_registry with agent_id, schema, and description
    □ Called complete_task to finalize

    YOU MUST ACTUALLY CALL ALL FOUR TOOLS. Do not just describe what you would do.
    </persistence_workflow>

    <output_format>
    Provide your response in EXACTLY this format:

    <section name="agent_design_summary">
    Purpose: [One sentence describing what the agent does]
    Input: [Type and description of handler parameter]
    Output: [Type and description of return value]
    Tools Required: [List of tools from priority order]
    Assumptions Made: [Any inferences you made from the request]
    Risk Rating: [low/medium/high based on tool permissions needed]
    Policy Considerations: [Any governance flags for Evaluator]
    </section>

    <section name="filename">
    agent_name.py
    </section>

    <section name="code">
    Provide ONLY the Python code. NO backticks, NO markdown formatting.
    the main entry function must be 'def handler'
    </section>

    <section name="metadata">
    {{
    "agent_name": "descriptive_agent_name",
    "purpose": "Brief description",
    "tools_used": ["tool1", "tool2"],
    "custom_tools_defined": ["custom_tool_name"],
    "requires_external_permissions": false,
    "risk_rating": "low",
    "s3_path": "s3://agents/agent_name.py",
    "registry_record": {{
        "agent_id": "agent_name",
        "handler_function": "handler",
        "created_by": "fabricator",
        "version": "1.0"
        }}
    }}
    </section>
    </output_format>

    <examples>
    <example_1 name="Agent Using Strands Built-in Tool">
    from strands import Agent, models
    from strands_tools import calculator

    def handler(x: int) -> str:
        \"""Calculate the square root of a number.
        Args:
            x: Integer to calculate square root of

        Returns:
            String containing the result
        \"""
        bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            region_name="us-west-2"
        )
        agent = Agent(bedrock_model, tools=[calculator])
        result = agent(f"What is the square root of {{x}}?")
        return result
    </example_1>

    <example_2 name="Agent Using Custom Tool">
    from strands import Agent, tool, models

    @tool
    def word_count(text: str) -> int:
        \"""Count the number of words in provided text.
        Args:
            text: String to count words in

        Returns:
            Integer count of words
        \"""
        return len(text.split())

    def handler(text: str) -> str:
        \"""Count words in the provided text string.
        Args:
            text: Input string to analyze

        Returns:
            Agent response with word count
        \"""
        bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            region_name="us-west-2"
        )
        agent = Agent(bedrock_model, tools=[word_count])
        result = agent(f"How many words are in this text: '{{text}}'")
        return result
    </example_2>
    </examples>

    <checklist>
    Before submitting, verify:
    - Agent function is named handler
    - Uses models.BedrockModel from strands import
    - Follows tool priority hierarchy
    - Includes complete docstrings
    - No test code included
    - Single file, importable as module
    - Uses /tmp/ for file operations
    - All 4 output sections present
    - Code has NO markdown backticks
    - Metadata JSON is valid
    - Called upload_agent_to_s3 to store the agent file in S3
    - Called store_agent_config_registry to register the agent in AgentCore Registry
    </checklist>

    <reminder>
    You are generating production code. Prioritize clarity, safety, and compliance over cleverness.
    Always make sure the main entry point for the agent is called handler.
    Import statement: from strands import Agent, tool, models

    IMPORTANT: If you need a custom tool, DO NOT create it yourself. Instead, call the create_custom_tool function with a description of what the tool should do. The Tool Fabricator will generate the tool code for you, and you can then include it in your agent code.

    CRITICAL: Every fabricated agent MUST be persisted via store_agent_config_registry (which writes to AgentCore Registry, not DynamoDB). The agent will not be discoverable until this tool is called.
    </reminder>
    """
    return AGENT_FABRICATOR_PROMPT

def publish_fabrication_event(orchestration_id: str, event_type: str, agent_id: str = None, error: str = None, app_id: str = None):
    """Publish fabrication event to EventBridge
    
    Args:
        orchestration_id: The orchestration ID for the fabrication request
        event_type: The type of event ('agent.fabricated' or 'agent.fabrication.failed')
        agent_id: The ID of the created agent (optional, for success events)
        error: Error message (optional, for failure events)
        app_id: The app ID to associate with the event (optional)
    
    Returns:
        The response from EventBridge put_events call
    """
    client = boto3.client('events')
    COMPLETION_BUS_NAME = os.environ.get('COMPLETION_BUS_NAME')
    event_detail = {
        'orchestration_id': orchestration_id,
    }
    
    if agent_id:
        event_detail['agent_use_id'] = agent_id
    
    if app_id:
        event_detail['appId'] = app_id
    
    if error:
        event_detail['error'] = error
    else:
        event_detail['data'] = 'Agent successfully created'
    
    event = {
        'Source': event_type,
        'DetailType': event_type,
        'EventBusName': COMPLETION_BUS_NAME,
        'Detail': json.dumps(event_detail)
    }
    
    response = client.put_events(Entries=[event])
    print(f"Published {event_type} event: {response}")
    return response

def publish_intake_progress(session_id: str, agent_index: int, total_agents: int, agent_name: str, failed: bool = False):
    """Publish implementation progress back to the intake EventBridge bus."""
    client = boto3.client('events')
    bus = os.environ.get('COMPLETION_BUS_NAME')
    if not bus or not session_id or session_id == '0':
        return
    pct = min(int(((agent_index + 1) / total_agents) * 100), 100) if not failed else -1
    summary = f"{'Failed' if failed else 'Built'}: {agent_name} ({agent_index + 1}/{total_agents})"
    client.put_events(Entries=[{
        'Source': 'agent_intake.implementation',
        'DetailType': 'intake.progress.updated',
        'EventBusName': bus,
        'Detail': json.dumps({
            'sessionId': session_id,
            'phase': 'implementation',
            'completionPercentage': pct,
            'changeSummary': summary,
        }),
    }])
    print(f"Published intake progress: {pct}% — {summary}")

def upload_to_s3(file_path, folder):
    """Upload a file to S3"""
    # Check env var FIRST so missing-bucket is a pure failure with zero
    # AWS calls (QB-013-1). Constructing boto3.client('s3') triggers
    # credential resolution, which fails in credential-less test envs.
    bucket_name = os.environ.get("AGENT_BUCKET_NAME", None)
    if bucket_name is None:
        raise ValueError("AGENT_BUCKET_NAME environment variable is not set")
    s3 = boto3.client('s3')
    print(f"storing {file_path}")
    filename = file_path.split("/")[-1]
    s3.upload_file(file_path, bucket_name, f"{folder}/{filename}")

@tool
def upload_agent_to_s3(file_path):
    """Upload a agent file to S3"""
    upload_to_s3(file_path, "agents")

@tool
def upload_tool_to_s3(file_path):
    """Upload a tool file to S3"""
    upload_to_s3(file_path, "tools")

@tool
def get_worker_tool(tool_name: str) -> str:
    """Get tool code from s3
    
    Args:
        tool_name: Name of the tool file (e.g., 'my_tool.py')
        
    Returns:
        str: The tool code content from S3
        
    Raises:
        ValueError: If AGENT_BUCKET_NAME environment variable is not set
    """
    s3 = boto3.client('s3')
    bucket_name = os.environ.get("AGENT_BUCKET_NAME", None)
    
    if bucket_name is None:
        raise ValueError("AGENT_BUCKET_NAME environment variable is not set")
    
    # Construct the S3 key for the tool in the tools/ folder
    s3_key = f"tools/{tool_name}"
    
    print(f"Retrieving tool from s3://{bucket_name}/{s3_key}")
    
    try:
        response = s3.get_object(Bucket=bucket_name, Key=s3_key)
        tool_code = response['Body'].read().decode('utf-8')
        print(f"Successfully retrieved tool: {tool_name}")
        return tool_code
    except Exception as e:
        print(f"Error retrieving tool {tool_name}: {str(e)}")
        raise

@tool
def store_agent_config_dynamo(file_name: str, agent_id: str, llm_tool_schema: Any, agent_description: str, app_id: str = None):
    """Store agent configuration in DynamoDB.
    
    Requirements:
    - AGENT_CONFIG_TABLE_NAME environment variable must be set with the DynamoDB table name
    - DynamoDB table must use 'agentId' as the primary key
    
    Args:
        file_name (str): The filename where the agent implementation is stored
        agent_id (str): Unique identifier for the agent (used as primary key in DynamoDB)
        llm_tool_schema (Any): OpenAPI schema structure defining the agents parameters
                               Must follow OpenAPI format with properties, required fields, and types
                               Example: {
                                 "properties": {
                                   "param_name": {
                                     "description": "Parameter description",
                                     "type": "string"
                                   }
                                 },
                                 "required": ["param_name"],
                                 "type": "object"
                               }
        agent_description (str): Human-readable description of what the agent does
        
    Returns:
        bool: True if configuration was successfully stored
        
    Raises:
        ValueError: If AGENT_CONFIG_TABLE_NAME environment variable is not set
    """
    try:
        print(f"[store_agent_config_dynamo] Starting - agent_id: {agent_id}, file_name: {file_name}")
        
        dynamodb = boto3.resource('dynamodb')
        table_name = os.environ.get("AGENT_CONFIG_TABLE", None)
        
        print(f"[store_agent_config_dynamo] AGENT_CONFIG_TABLE env var: {table_name}")
        
        if table_name is None:
            error_msg = "AGENT_CONFIG_TABLE environment variable is not set"
            print(f"[store_agent_config_dynamo] ERROR: {error_msg}")
            raise ValueError(error_msg)

        # if llm_tool_schema is str then json loads it
        if isinstance(llm_tool_schema, str):
            print(f"[store_agent_config_dynamo] Converting llm_tool_schema from string to dict")
            llm_tool_schema = json.loads(llm_tool_schema)
        
        print(f"[store_agent_config_dynamo] llm_tool_schema type: {type(llm_tool_schema)}")
        print(f"[store_agent_config_dynamo] llm_tool_schema content: {json.dumps(llm_tool_schema, indent=2)}")

        table = dynamodb.Table(table_name)
        
        # Auto-generate agent manifest from available information (Req 15.5)
        manifest = {
            'name': agent_id,
            'description': agent_description,
            'version': 1,
            'tools': [],
        }

        item = {
            'agentId': agent_id,
            'config': {
                "name": agent_id,
                "filename": file_name.split('/')[-1],
                "schema": llm_tool_schema,
                "version": 1,
                "description": agent_description,
                "action": {
                    "type": "sqs",
                    "target": os.environ.get("WORKER_QUEUE_URL", "MISSING")
                },
            },
            'state': 'inactive',
            'categories': ['worker'],
            'manifest': manifest,
        }

        if app_id:
            item['appId'] = app_id
        
        print(f"[store_agent_config_dynamo] Attempting to put_item: {json.dumps(item, indent=2, default=str)}")
        
        response = table.put_item(Item=item)
        
        print(f"[store_agent_config_dynamo] SUCCESS - DynamoDB response: {response}")
        return True
        
    except Exception as e:
        print(f"[store_agent_config_dynamo] EXCEPTION: {type(e).__name__}: {str(e)}")
        import traceback
        print(f"[store_agent_config_dynamo] TRACEBACK: {traceback.format_exc()}")
        raise

@tool
def store_tool_config_dynamo(
    file_name: str,
    tool_id: str,
    tool_schema: Any,
    tool_description: str,
    integration_bindings: list | None = None,
    datastore_bindings: list | None = None,
    app_id: str = None,
):
    """Store tool configuration in DynamoDB.
    
    Requirements:
    - TOOL_CONFIG_TABLE_NAME environment variable must be set with the DynamoDB table name
    - DynamoDB table must use 'toolId' as the primary key
    
    Args:
        file_name (str): The filename where the tool implementation is stored
        tool_id (str): Unique identifier for the tool (used as primary key in DynamoDB)
        tool_schema (Any): OpenAPI schema structure defining the tools parameters
                               Must follow OpenAPI format with properties, required fields, and types
                               Example: {
                                 "properties": {
                                   "param_name": {
                                     "description": "Parameter description",
                                     "type": "string"
                                   }
                                 },
                                 "required": ["param_name"],
                                 "type": "object"
                               }
        tool_description (str): Human-readable description of what the tool does
        integration_bindings (list | None): Optional list of integration binding dicts,
            each with integrationId, integrationType, and optional operations
        datastore_bindings (list | None): Optional list of data store binding dicts,
            each with dataStoreId, dataStoreType, and optional operations
        
    Returns:
        bool: True if configuration was successfully stored
        
    Raises:
        ValueError: If TOOL_CONFIG_TABLE_NAME environment variable is not set
    """
    try:
        print(f"[store_tool_config_dynamo] Starting - tool_id: {tool_id}, file_name: {file_name}")
        
        dynamodb = boto3.resource('dynamodb')
        table_name = os.environ.get("TOOL_CONFIG_TABLE", None)
        
        print(f"[store_tool_config_dynamo] TOOL_CONFIG_TABLE env var: {table_name}")
        
        if table_name is None:
            error_msg = "TOOL_CONFIG_TABLE environment variable is not set"
            print(f"[store_tool_config_dynamo] ERROR: {error_msg}")
            raise ValueError(error_msg)

        # if tool_schema is str then json loads it
        if isinstance(tool_schema, str):
            print(f"[store_tool_config_dynamo] Converting tool_schema from string to dict")
            tool_schema = json.loads(tool_schema)
        
        print(f"[store_tool_config_dynamo] tool_schema type: {type(tool_schema)}")
        print(f"[store_tool_config_dynamo] tool_schema content: {json.dumps(tool_schema, indent=2)}")

        table = dynamodb.Table(table_name)
        
        item = {
            'toolId': tool_id,
            'config': {
                "name": tool_id,
                "filename": file_name.split('/')[-1],
                "schema": tool_schema,
                "version": 1,
                "description": tool_description,
            },
            'state': 'active'
        }

        if integration_bindings:
            item['integrationBindings'] = integration_bindings
        if datastore_bindings:
            item['dataStoreBindings'] = datastore_bindings
        if app_id:
            item['appId'] = app_id
        
        print(f"[store_tool_config_dynamo] Attempting to put_item: {json.dumps(item, indent=2, default=str)}")
        
        response = table.put_item(Item=item)
        
        print(f"[store_tool_config_dynamo] SUCCESS - DynamoDB response: {response}")
        return True
        
    except Exception as e:
        print(f"[store_tool_config_dynamo] EXCEPTION: {type(e).__name__}: {str(e)}")
        import traceback
        print(f"[store_tool_config_dynamo] TRACEBACK: {traceback.format_exc()}")
        raise

@tool
def store_agent_config_registry(
    file_name: str,
    agent_id: str,
    llm_tool_schema: Any,
    agent_description: str,
    app_id: str = None,
    requested_by: str = "fabricator",
    org_id: str = "",
    source_project_id: str | None = None,
) -> bool:
    """Store agent configuration in AgentCore Registry.

    Creates a new agent record in the AgentCore Registry via CreateRegistryRecord.
    The human-readable description is stored verbatim in the record's description
    field so the UI can render it as text (QB-013-2). The full executable config,
    manifest, categories, state, the requester user id (as ``createdBy``), and
    the caller's organization id (as ``orgId``, Phase 2b) are serialized as JSON
    and stored in the CUSTOM descriptor's inlineContent.
    After creation the record is left in its post-create DRAFT
    (pending-activation) state so it requires activation before use (DRAFT
    maps to internal state "inactive" for fabricator-created records, per
    Requirement 8.3). The Fabricator does NOT call UpdateRegistryRecordStatus
    to re-assert DRAFT — CreateRegistryRecord already leaves the record in
    DRAFT, and the registry rejects a DRAFT->DRAFT transition with
    ValidationException.

    Requirements:
    - REGISTRY_ID environment variable must be set with the Registry ID.

    Args:
        file_name: The filename where the agent implementation is stored.
        agent_id: Unique identifier for the agent (used as the record name so
            downstream consumers can resolve records by this id).
        llm_tool_schema: OpenAPI schema structure defining the agent's parameters.
            May be a dict or a JSON string.
        agent_description: Human-readable description of what the agent does.
            Written verbatim into the record's description field.
        app_id: Optional app id to associate with the agent.
        requested_by: The requester user id — stamped into the record's custom
            metadata as ``createdBy``. Defaults to ``"fabricator"`` for legacy
            callers that don't thread the value through.
        org_id: The caller's organization id — stamped into custom metadata as
            ``orgId`` (Phase 2b). Defaults to ``""`` to mirror the resolver's
            defensive null fallback; callers should pass the value threaded
            from the SQS event's ``org_id`` field.

    Returns:
        bool: True if configuration was successfully stored.

    Raises:
        ValueError: If REGISTRY_ID environment variable is not set.
        Exception: Re-raises any error from the Registry API after logging and
            publishing an agent.fabrication.failed event to EventBridge.
    """
    try:
        print(
            f"[store_agent_config_registry] Starting - agent_id: {agent_id}, "
            f"file_name: {file_name}"
        )

        registry_id = os.environ.get("REGISTRY_ID")
        print(f"[store_agent_config_registry] REGISTRY_ID env var: {registry_id}")

        if not registry_id:
            error_msg = "REGISTRY_ID environment variable is not set"
            print(f"[store_agent_config_registry] ERROR: {error_msg}")
            raise ValueError(error_msg)

        # Normalize the schema — strings arrive from the LLM as JSON text.
        if isinstance(llm_tool_schema, str):
            print(
                "[store_agent_config_registry] Converting llm_tool_schema "
                "from string to dict"
            )
            llm_tool_schema = json.loads(llm_tool_schema)

        print(
            f"[store_agent_config_registry] llm_tool_schema type: "
            f"{type(llm_tool_schema)}"
        )

        # Source-project tagging (identifiability): when a real source project
        # id is supplied, append a ' (Project: <id>)' suffix to the human
        # description so the catalog can attribute the fabricated agent to the
        # intake session it came from, and stash the raw id in custom metadata
        # for grouping. '0'/empty/None are treated as "no project" so legacy
        # / UI-direct fabrications stay unchanged. The suffix is idempotent —
        # never duplicated if the description already carries it.
        base_description = agent_description or ""
        display_description = base_description
        normalized_project_id = (
            source_project_id
            if source_project_id and source_project_id != "0"
            else None
        )
        if normalized_project_id:
            suffix = f" (Project: {normalized_project_id})"
            if not display_description.endswith(suffix):
                display_description = f"{display_description}{suffix}"

        # Executable agent config — stashed under custom metadata so the cache
        # sync / resolvers can parse it verbatim without colliding with the
        # human description.
        config = {
            "name": agent_id,
            "filename": file_name.split('/')[-1],
            "schema": llm_tool_schema,
            "version": 1,
            "description": display_description,
            "action": {
                "type": "sqs",
                "target": os.environ.get("WORKER_QUEUE_URL", "MISSING"),
            },
        }

        # Auto-generate agent manifest.
        manifest = {
            "name": agent_id,
            "description": display_description,
            "version": 1,
            "tools": [],
        }

        # Custom metadata — serialized into the CUSTOM descriptor inlineContent.
        # state is recorded as "inactive" to match Requirement 8.3; the record
        # is left in its post-create DRAFT (pending-activation) state — no
        # UpdateRegistryRecordStatus call is made (a DRAFT->DRAFT transition is
        # rejected by the registry). The full ``config``
        # dict and requester ``createdBy`` are preserved here so that moving
        # the executable config out of the top-level description doesn't lose
        # information (QB-013-2 post-boto3-1.42 refactor). Phase 2b stamps the
        # caller's ``orgId`` so the registry-service mapper can extract it.
        custom_metadata = {
            "categories": ["worker"],
            "icon": "",
            "state": "inactive",
            "manifest": manifest,
            "config": config,
            "createdBy": requested_by,
            "orgId": org_id,
        }
        if app_id:
            custom_metadata["appId"] = app_id
        if normalized_project_id:
            custom_metadata["sourceProjectId"] = normalized_project_id

        print(
            f"[store_agent_config_registry] Creating Registry record for agent: "
            f"{agent_id}"
        )

        # Idempotency guard (pipeline-reliability hardening): SQS redeliveries
        # and re-triggers must NOT create a duplicate Registry record for the
        # same agent name. Look the name up first (mirrors resolveRecordId /
        # listResources in backend/src/services/registry-service.ts). When a
        # record already exists we SKIP CreateRegistryRecord, still refresh the
        # AppsTable #META mirror for that existing record, and return True so
        # the re-trigger is a no-op rather than a duplicate fabrication.
        existing_record_id = _find_existing_record_id(registry_id, agent_id)
        if existing_record_id is not None:
            print(
                f"[store_agent_config_registry] Record with name '{agent_id}' "
                f"already exists (recordId={existing_record_id}); skipping "
                f"CreateRegistryRecord to keep fabrication idempotent"
            )
            _write_app_meta_row(
                record_id=existing_record_id,
                agent_id=agent_id,
                agent_description=display_description,
                requested_by=requested_by,
                org_id=org_id,
            )
            return True

        # CreateRegistryRecord does NOT accept a recordId — the service generates
        # one. We use the agentId as the record name so records can be located
        # by name in subsequent operations.
        response = _get_registry_client().create_registry_record(
            registryId=registry_id,
            name=agent_id,
            description=display_description,
            descriptorType="CUSTOM",
            descriptors={
                "custom": {
                    "inlineContent": json.dumps(custom_metadata, default=str),
                },
            },
        )

        # Extract recordId from the ARN returned by CreateRegistryRecord.
        record_arn = response.get("recordArn", "")
        record_id = record_arn.rsplit("/", 1)[-1] if "/" in record_arn else agent_id

        # Phase 3 Step 2: synchronously mirror the new Registry record into
        # AppsTable as a #META row so listApps (which reads from
        # AppsTable.OrgIndex) sees the agent immediately, without waiting
        # for the reconciler. Eventually-consistent — DDB failures log and
        # are swallowed; the Registry write above is the source of truth.
        _write_app_meta_row(
            record_id=record_id,
            agent_id=agent_id,
            agent_description=display_description,
            requested_by=requested_by,
            org_id=org_id,
        )

        print(
            f"[store_agent_config_registry] Record created (recordId={record_id}); "
            f"leaving record in its post-create DRAFT (pending-activation) state"
        )

        # No status update here: CreateRegistryRecord already leaves the record
        # in DRAFT (the pre-activation state), which is the intended
        # 'requires activation before use' behavior for fabricator-created
        # agents (Requirement 8.3; DRAFT maps to internal state "inactive").
        # The AgentCore registry REJECTS a redundant DRAFT->DRAFT transition
        # with ValidationException ('Invalid target status: DRAFT'), so calling
        # UpdateRegistryRecordStatus(status="DRAFT") here would make this
        # function raise and publish agent.fabrication.failed even though the
        # record was created successfully. The record is therefore left as-is;
        # activation to a usable state happens later via the catalog.

        print(f"[store_agent_config_registry] SUCCESS - Registry response: {response}")
        return True

    except Exception as e:
        print(
            f"[store_agent_config_registry] EXCEPTION: "
            f"{type(e).__name__}: {str(e)}"
        )
        import traceback
        print(f"[store_agent_config_registry] TRACEBACK: {traceback.format_exc()}")
        # Publish fabrication failure event to EventBridge. Failures here are
        # non-fatal — we still re-raise the original error.
        try:
            publish_fabrication_event(
                orchestration_id="0",
                event_type="agent.fabrication.failed",
                agent_id=agent_id,
                error=str(e),
                app_id=app_id,
            )
        except Exception as pub_err:
            print(
                f"[store_agent_config_registry] Failed to publish failure event: "
                f"{pub_err}"
            )
        raise


@tool
def store_tool_config_registry(
    file_name: str,
    tool_id: str,
    tool_schema: Any,
    tool_description: str,
    integration_bindings: list | None = None,
    datastore_bindings: list | None = None,
    app_id: str = None,
    requested_by: str = "fabricator",
    org_id: str = "",
) -> bool:
    """Store tool configuration in AgentCore Registry.

    Creates a new tool record in the AgentCore Registry via CreateRegistryRecord.
    The human-readable description is stored verbatim in the record's description
    field so the UI can render it as text (QB-013-2). The full executable config,
    categories, state, integrationBindings, dataStoreBindings, the requester
    user id (as ``createdBy``), and the caller's organization id (as ``orgId``,
    Phase 2b) are serialized as JSON and stored in the CUSTOM descriptor's
    inlineContent. Tool records deliberately do NOT carry a ``manifest`` key —
    that is the agent/tool type discriminator (commit 0a42938) and must be
    preserved. After creation the record status is moved to PUBLISHED so the
    tool is immediately usable (PUBLISHED maps to internal state "active" for
    fabricator-created tools, per Requirement 8.4).

    Requirements:
    - REGISTRY_ID environment variable must be set with the Registry ID.

    Args:
        file_name: The filename where the tool implementation is stored.
        tool_id: Unique identifier for the tool (used as the record name so
            downstream consumers can resolve records by this id).
        tool_schema: OpenAPI schema structure defining the tool's parameters.
            May be a dict or a JSON string.
        tool_description: Human-readable description of what the tool does.
            Written verbatim into the record's description field.
        integration_bindings: Optional list of integration binding dicts,
            each with integrationId, integrationType, and optional operations.
            Preserved verbatim in custom metadata.
        datastore_bindings: Optional list of data store binding dicts,
            each with dataStoreId, dataStoreType, and optional operations.
            Preserved verbatim in custom metadata.
        app_id: Optional app id to associate with the tool.
        requested_by: The requester user id — stamped into the record's custom
            metadata as ``createdBy``. Defaults to ``"fabricator"`` for legacy
            callers that don't thread the value through.
        org_id: The caller's organization id — stamped into custom metadata as
            ``orgId`` (Phase 2b). Defaults to ``""`` to mirror the resolver's
            defensive null fallback; callers should pass the value threaded
            from the SQS event's ``org_id`` field.

    Returns:
        bool: True if configuration was successfully stored.

    Raises:
        ValueError: If REGISTRY_ID environment variable is not set.
        Exception: Re-raises any error from the Registry API after logging and
            publishing a tool.fabrication.failed event to EventBridge.
    """
    try:
        print(
            f"[store_tool_config_registry] Starting - tool_id: {tool_id}, "
            f"file_name: {file_name}"
        )

        registry_id = os.environ.get("REGISTRY_ID")
        print(f"[store_tool_config_registry] REGISTRY_ID env var: {registry_id}")

        if not registry_id:
            error_msg = "REGISTRY_ID environment variable is not set"
            print(f"[store_tool_config_registry] ERROR: {error_msg}")
            raise ValueError(error_msg)

        # Normalize the schema — strings arrive from the LLM as JSON text.
        if isinstance(tool_schema, str):
            print(
                "[store_tool_config_registry] Converting tool_schema "
                "from string to dict"
            )
            tool_schema = json.loads(tool_schema)

        print(
            f"[store_tool_config_registry] tool_schema type: "
            f"{type(tool_schema)}"
        )

        # Executable tool config — stashed under custom metadata so the cache
        # sync / resolvers can parse it verbatim without colliding with the
        # human description.
        config = {
            "name": tool_id,
            "filename": file_name.split('/')[-1],
            "schema": tool_schema,
            "version": 1,
            "description": tool_description,
        }

        # Custom metadata — serialized into the CUSTOM descriptor inlineContent.
        # state is recorded as "active" to match Requirement 8.4; status is
        # set to PUBLISHED below via UpdateRegistryRecordStatus. The full
        # ``config`` dict and requester ``createdBy`` are preserved here so
        # that moving the executable config out of the top-level description
        # doesn't lose information (QB-013-2 post-boto3-1.42 refactor). Note
        # that tool records intentionally do NOT carry a ``manifest`` key —
        # that's the agent/tool type discriminator (commit 0a42938). Phase 2b
        # stamps the caller's ``orgId`` so the registry-service mapper can
        # extract it.
        custom_metadata = {
            "categories": [],
            "icon": "",
            "state": "active",
            "config": config,
            "createdBy": requested_by,
            "orgId": org_id,
        }
        if integration_bindings:
            custom_metadata["integrationBindings"] = integration_bindings
        if datastore_bindings:
            custom_metadata["dataStoreBindings"] = datastore_bindings
        if app_id:
            custom_metadata["appId"] = app_id

        print(
            f"[store_tool_config_registry] Creating Registry record for tool: "
            f"{tool_id}"
        )

        # CreateRegistryRecord does NOT accept a recordId — the service generates
        # one. We use the toolId as the record name so records can be located
        # by name in subsequent operations.
        response = _get_registry_client().create_registry_record(
            registryId=registry_id,
            name=tool_id,
            description=tool_description or "",
            descriptorType="CUSTOM",
            descriptors={
                "custom": {
                    "inlineContent": json.dumps(custom_metadata, default=str),
                },
            },
        )

        # Extract recordId from the ARN returned by CreateRegistryRecord.
        record_arn = response.get("recordArn", "")
        record_id = record_arn.rsplit("/", 1)[-1] if "/" in record_arn else tool_id

        print(
            f"[store_tool_config_registry] Record created (recordId={record_id}), "
            f"setting status to PUBLISHED"
        )

        # Published status => internal state "active" for fabricator-created tools
        # (Requirement 8.4). Unlike agents, tools are immediately usable after
        # fabrication.
        _get_registry_client().update_registry_record_status(
            registryId=registry_id,
            recordId=record_id,
            status="PUBLISHED",
            statusReason="Initial status set by Fabricator",
        )

        print(f"[store_tool_config_registry] SUCCESS - Registry response: {response}")
        return True

    except Exception as e:
        print(
            f"[store_tool_config_registry] EXCEPTION: "
            f"{type(e).__name__}: {str(e)}"
        )
        import traceback
        print(f"[store_tool_config_registry] TRACEBACK: {traceback.format_exc()}")
        # Publish fabrication failure event to EventBridge. Failures here are
        # non-fatal — we still re-raise the original error.
        try:
            publish_fabrication_event(
                orchestration_id="0",
                event_type="tool.fabrication.failed",
                agent_id=tool_id,
                error=str(e),
                app_id=app_id,
            )
        except Exception as pub_err:
            print(
                f"[store_tool_config_registry] Failed to publish failure event: "
                f"{pub_err}"
            )
        raise


def create_tool_fabricator(store_tool_tool=None):
    """Create and return the Tool Fabricator agent.

    Args:
        store_tool_tool: Optional override for the registry storage tool,
            used to bind a ``requested_by`` value via a closure wrapper
            (see ``process_event``). Defaults to the module-level
            ``store_tool_config_registry`` which uses the legacy
            ``"fabricator"`` default.
    """
    if store_tool_tool is None:
        store_tool_tool = store_tool_config_registry

    bedrock_model = models.BedrockModel(
        model_id=FABRICATOR_MODEL_ID,
        max_tokens=32768,
        region_name="us-west-2",
        boto_client_config=BEDROCK_RETRY_CONFIG,
    )
    
    tool_fabricator = Agent(
        bedrock_model,
        tools=[file_write, http_request, shell, upload_tool_to_s3, store_tool_tool],
        system_prompt=get_tool_fabricator_prompt()
    )
    
    return tool_fabricator

# Tool for Agent Fabricator to request custom tool creation
@tool
def create_custom_tool(
    tool_description: str,
    integration_bindings: list | None = None,
    datastore_bindings: list | None = None,
) -> str:
    """Request the Tool Fabricator to create a custom tool.
    
    Args:
        tool_description: Detailed description of what the tool should do
        integration_bindings: Optional list of integration binding dicts
        datastore_bindings: Optional list of data store binding dicts
        
    Returns:
        The generated tool code as a string
    """
    print(f"Agent Fabricator requesting custom tool: {tool_description}")
    
    # Create the Tool Fabricator agent
    tool_fabricator = create_tool_fabricator()

    # Enrich the description with binding context if provided
    enriched_description = tool_description
    if integration_bindings or datastore_bindings:
        binding_context_parts = []
        if integration_bindings:
            for binding in integration_bindings:
                parts = [f"Integration type: {binding.get('integrationType', 'unknown')}"]
                if binding.get('operations'):
                    parts.append(f"Operations: {', '.join(binding['operations'])}")
                if binding.get('authMethod'):
                    parts.append(f"Auth method: {binding['authMethod']}")
                binding_context_parts.append('; '.join(parts))
        if datastore_bindings:
            for binding in datastore_bindings:
                parts = [f"Data store type: {binding.get('dataStoreType', 'unknown')}"]
                if binding.get('operations'):
                    parts.append(f"Operations: {', '.join(binding['operations'])}")
                binding_context_parts.append('; '.join(parts))
        binding_context = "\n".join(binding_context_parts)
        enriched_description = (
            f"{tool_description}\n\n"
            f"BINDING CONTEXT (use scoped credentials from environment variables):\n"
            f"{binding_context}\n\n"
            f"When calling store_tool_config_registry, pass these bindings:\n"
            f"integration_bindings={json.dumps(integration_bindings) if integration_bindings else 'None'}\n"
            f"datastore_bindings={json.dumps(datastore_bindings) if datastore_bindings else 'None'}"
        )

    # Call the Tool Fabricator agent
    result = tool_fabricator(f"Create a custom tool with the following requirements: {enriched_description}")
    
    print(f"Tool Fabricator response: {result}")
    return result

def create_agent_fabricator(complete_task, store_agent_tool=None):
    """Create and return the Agent Fabricator agent.

    Args:
        complete_task: The per-request completion tool (closure over the
            current orchestration context).
        store_agent_tool: Optional override for the registry storage tool,
            used to bind a ``requested_by`` value via a closure wrapper
            (see ``process_event``). Defaults to the module-level
            ``store_agent_config_registry`` which uses the legacy
            ``"fabricator"`` default.
    """
    if store_agent_tool is None:
        store_agent_tool = store_agent_config_registry

    bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            max_tokens=32768,
            region_name="us-west-2",
            boto_client_config=BEDROCK_RETRY_CONFIG,
    )
    
    agent_fabricator = Agent(
        bedrock_model,
        tools=[file_write, http_request, shell, get_worker_tool, create_custom_tool,
            upload_agent_to_s3, store_agent_tool, complete_task],
        system_prompt=get_agent_fabricator_prompt()
    )
    
    return agent_fabricator

def process_event(event, context, request_type=None):
    # Get values with defaults for direct requests
    orchestration_id = event.get("orchestration_id", "0")
    agent_use_id = event.get("agent_use_id", "unknown")
    requested_by = event.get("requested_by") or "fabricator"
    # Phase 2b: caller's org, stamped into registry custom metadata so
    # registry-service can scope reads. '' mirrors the resolver's defensive
    # null fallback so absent-org events still fabricate rather than block.
    org_id = event.get("org_id") or ""
    request = event.get("agent_input", {})
    agent_name = event.get('node', 'fabricator')
    agent_index = event.get("agent_index", 0)
    total_agents = event.get("total_agents", 1)

    TASK = request.get("taskDetails", None)
    
    # Extract binding metadata from the fabrication request
    integration_bindings = request.get("integrationBindings", None)
    datastore_bindings = request.get("dataStoreBindings", None)
    
    if TASK is None:
        print(f"Error: No taskDetails found in event: {event}")
        raise ValueError("taskDetails is required in agent_input")

    # US-ARB-017 precondition gate. Forward-compatible: no-op when projectId
    # is not present in agent_input (today's reality since Citadel has no
    # Project<->App linkage). When projectId is present, refuse fabrication
    # unless the referenced AgentDesignAssessment row exists and is
    # completed (or grandfathered=True).
    project_id = request.get('projectId') or request.get('project_id')
    # PR 4 fallback: if the TS resolver didn't propagate projectId (older
    # apps, or records created directly against the registry bypassing
    # AgentApp), attempt to resolve it from the registry record's
    # customDescriptorContent via the PR 1 catalog bridge. Graceful degrade
    # if the client is unavailable (keeps fabricator resilient in
    # partial-deploy environments).
    if project_id is None:
        registry_id = os.environ.get('REGISTRY_ID')
        record_id = (
            request.get('agentId')
            or request.get('recordId')
            or request.get('agent_id')
        )
        if registry_id and record_id:
            try:
                from catalog.registry_client import get_source_project_id
                project_id = get_source_project_id(registry_id, record_id)
                if project_id:
                    logger.info(
                        'fabricator: resolved projectId=%s from registry record %s/%s',
                        project_id, registry_id, record_id,
                    )
            except ImportError:
                # catalog Layer not attached (unexpected post-PR-2 but keep
                # fallback safe).
                logger.warning(
                    'fabricator: catalog.registry_client unavailable; '
                    'skipping projectId fallback'
                )
            except Exception as exc:  # noqa: BLE001 - intentional broad catch
                logger.warning(
                    'fabricator: projectId fallback raised %s; '
                    'continuing with project_id=None',
                    exc,
                )
    grandfathered = bool(request.get('grandfathered', False))
    try:
        check_design_assessment(project_id, grandfathered=grandfathered)
    except DesignAssessmentMissingError as exc:
        # Surface as an explicit error back to the caller. SQS events with
        # no ack will naturally retry -- caller must either supply a valid
        # projectId + completed assessment or set grandfathered=True.
        print(f"fabrication refused: {exc}")
        raise

    try:
        # Durable status: mark this agent PROCESSING at the start. Best-effort
        # — a status-write failure never changes fabrication behavior.
        _write_fabrication_status(
            orchestration_id, agent_use_id, "PROCESSING", agent_name=agent_use_id
        )

        # since this needs variable injection, keep within handler method scope.
        @tool
        def complete_task():
            """Finally, call this to indicate the task has been completed"""
            client = boto3.client('events')
            COMPLETION_BUS_NAME = os.environ.get('COMPLETION_BUS_NAME')
            
            # Publish intake implementation progress
            publish_intake_progress(orchestration_id, agent_index, total_agents, agent_use_id)
            
            # Publish fabrication success event
            publish_fabrication_event(
                orchestration_id=orchestration_id,
                event_type='agent.fabricated',
                agent_id=agent_use_id
            )
            
            # Check if this is a direct request (orchestration_id == '0') or part of an orchestration
            if orchestration_id == '0':
                # Direct request from UI - send agent.fabricated event
                completion_event = {
                    'Source': 'agent.fabricated',
                    'DetailType': 'agent.fabricated',
                    'EventBusName': COMPLETION_BUS_NAME,
                    'Detail': json.dumps({
                        'orchestration_id': orchestration_id,
                        'data': 'Capability has been created',
                        'agent_use_id': agent_use_id,
                        'node': agent_name
                    })
                }
            else:
                # Part of orchestration - send task.completion event
                completion_event = {
                    'Source': 'task.completion',
                    'DetailType': 'task.completion',
                    'EventBusName': COMPLETION_BUS_NAME,
                    'Detail': json.dumps({
                        'orchestration_id': orchestration_id,
                        'data': 'Capability has been created, try to invoke it again.',
                        'agent_use_id': agent_use_id,
                        'node': agent_name
                    })
                }

            print("Completed")

            response = client.put_events(
                Entries=[
                    completion_event
                ]
            )
            print(f"event posted: {response}")
            return f"event posted: {completion_event}"

        if request_type == "tool-creation":
            # Bind requested_by into a closure-wrapped @tool so the LLM
            # invocation path records the event's requester in custom
            # metadata's createdBy field. org_id (Phase 2b) is bound the same
            # way so the registry record's orgId reflects the caller's org.
            @tool
            def store_tool_config_registry_bound(
                file_name: str,
                tool_id: str,
                tool_schema: Any,
                tool_description: str,
                integration_bindings: list | None = None,
                datastore_bindings: list | None = None,
                app_id: str = None,
            ) -> bool:
                """Store tool configuration in AgentCore Registry."""
                return store_tool_config_registry(
                    file_name=file_name,
                    tool_id=tool_id,
                    tool_schema=tool_schema,
                    tool_description=tool_description,
                    integration_bindings=integration_bindings,
                    datastore_bindings=datastore_bindings,
                    app_id=app_id,
                    requested_by=requested_by,
                    org_id=org_id,
                )

            # Create and invoke the Tool Fabricator
            tool_fabricator = create_tool_fabricator(store_tool_tool=store_tool_config_registry_bound)
            # Enrich the task description with binding context for the LLM
            enriched_task = TASK
            if integration_bindings or datastore_bindings:
                binding_context_parts = []
                if integration_bindings:
                    for binding in integration_bindings:
                        parts = [f"Integration type: {binding.get('integrationType', 'unknown')}"]
                        if binding.get('operations'):
                            parts.append(f"Operations: {', '.join(binding['operations'])}")
                        if binding.get('authMethod'):
                            parts.append(f"Auth method: {binding['authMethod']}")
                        binding_context_parts.append('; '.join(parts))
                if datastore_bindings:
                    for binding in datastore_bindings:
                        parts = [f"Data store type: {binding.get('dataStoreType', 'unknown')}"]
                        if binding.get('operations'):
                            parts.append(f"Operations: {', '.join(binding['operations'])}")
                        binding_context_parts.append('; '.join(parts))
                binding_context = "\n".join(binding_context_parts)
                enriched_task = (
                    f"{TASK}\n\n"
                    f"BINDING CONTEXT (use scoped credentials from environment variables):\n"
                    f"{binding_context}\n\n"
                    f"When calling store_tool_config_registry, pass these bindings:\n"
                    f"integration_bindings={json.dumps(integration_bindings) if integration_bindings else 'None'}\n"
                    f"datastore_bindings={json.dumps(datastore_bindings) if datastore_bindings else 'None'}"
                )
            tool_fabricator(enriched_task)
        else:
            # Bind requested_by into a closure-wrapped @tool so the LLM
            # invocation path records the event's requester in custom
            # metadata's createdBy field. org_id (Phase 2b) is bound the same
            # way so the registry record's orgId reflects the caller's org.
            @tool
            def store_agent_config_registry_bound(
                file_name: str,
                agent_id: str,
                llm_tool_schema: Any,
                agent_description: str,
                app_id: str = None,
            ) -> bool:
                """Store agent configuration in AgentCore Registry."""
                return store_agent_config_registry(
                    file_name=file_name,
                    agent_id=agent_id,
                    llm_tool_schema=llm_tool_schema,
                    agent_description=agent_description,
                    app_id=app_id,
                    requested_by=requested_by,
                    org_id=org_id,
                    source_project_id=orchestration_id,
                )

            # Create the Agent Fabricator with access to create_custom_tool
            agent_fabricator = create_agent_fabricator(
                complete_task,
                store_agent_tool=store_agent_config_registry_bound,
            )
            agent_fabricator(TASK)

        # Durable status: fabrication dispatch completed without raising — mark
        # COMPLETED and stamp the agent name/recordId. Best-effort.
        _write_fabrication_status(
            orchestration_id, agent_use_id, "COMPLETED",
            agent_id=agent_use_id, agent_name=agent_use_id
        )

    except Exception as e:
        print(f"Fabrication failed: {str(e)}")
        # Durable status: mark FAILED + errorMessage before re-raising. The
        # status write is best-effort and must not mask the original error.
        _write_fabrication_status(
            orchestration_id, agent_use_id, "FAILED",
            error_message=str(e), agent_name=agent_use_id
        )
        # Publish intake progress failure
        publish_intake_progress(orchestration_id, agent_index, total_agents, agent_use_id, failed=True)
        # Publish fabrication failure event
        publish_fabrication_event(
            orchestration_id=orchestration_id,
            event_type='agent.fabrication.failed',
            error=str(e)
        )
        raise

    # Fallback: ensure progress is published even if the LLM didn't call complete_task
    publish_intake_progress(orchestration_id, agent_index, total_agents, agent_use_id)


def lambda_handler(event, context):
    print(f"processing event {event}")
    for record in event['Records']:
        message_body = json.loads(record['body'])
        # print(f"Parsed message body: {json.dumps(message_body, indent=2)}")
        
        # Extract request type from SQS messageAttributes
        request_type = None
        if 'messageAttributes' in record and 'requestType' in record['messageAttributes']:
            request_type = record['messageAttributes']['requestType'].get('stringValue')
            print(f"Request type from messageAttributes: {request_type}")
        
        process_event(message_body, context, request_type=request_type)

if __name__ == "__main__":
    # Grab a record from your lambda and invoke, configuration will vary drastically
    process_event(
        {'agent_input': {'taskDetails': 'Create a capability to prepare and serve cheesecake dessert items'}, 'orchestration_id': 'ed3b70b6-37c6-47fa-8f50-4eac0908345e',
            'agent_use_id': 'tooluse_L9uWo8_KR4mT70-876lzSA', 'node': 'fabricator'}, {}
    )
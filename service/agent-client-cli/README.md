# Agent 1 CLI Client

Interactive command-line interface for Agent 1 - Assessment & Evaluation with AWS IAM authentication for multi-turn conversations.

## Installation

```bash
pip install boto3
```

## Setup

### Configure AWS Credentials

The CLI uses your AWS credentials for authentication. Set them up using:

```bash
aws configure
```

Or set environment variables:
```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_DEFAULT_REGION=ap-southeast-2
```

## Usage

### Interactive Mode

Start an interactive chat session with Agent 1:

```bash
python agent_cli_interactive.py \
  --agent-arn arn:aws:bedrock-agentcore:ap-southeast-2:941384789627:runtime/agent1_assessment-XXXXX
```

## Arguments

- `--agent-arn` (required): ARN of the Agent 1 runtime to invoke
- `--region` (optional): AWS region (default: ap-southeast-2)

**Interactive Commands:**
- Type your message and press Enter to chat
- `exit` or `quit` - End the session
- `clear` - Clear the screen
- `info` - Show session information
- `help` - Show assessment dimensions
- `Ctrl+C` - Interrupt and exit

**Example Session:**
```
✅ AWS credentials found

================================================================================
🤖 Agent 1 - Assessment & Evaluation Interactive Chat
================================================================================
Agent ARN: arn:aws:bedrock-agentcore:ap-southeast-2:941384789627:runtime/agent1_assessment-XXXXX
Session ID: session-a1b2c3d4e5f67890abcdef1234567890
Region: ap-southeast-2

💡 Try asking about:
  - 'What technical information do you need for assessment?'
  - 'Show me the business assessment categories'
  - 'Help me understand the governance requirements'
================================================================================

[Turn 1] You: Hello, I would like to start an assessment

🤖 Agent: Hello! I'm ready to help you with your agentic AI readiness assessment...

[Turn 2] You: What technical information do you need?

🤖 Agent: I'll need to understand several technical aspects...

[Turn 3] You: help

📋 Assessment Dimensions:
   • Technical Feasibility (30%): Architecture, integration, data strategy
   • Governance & Compliance (25%): Risk management, regulatory requirements
   • Business Feasibility (25%): Objectives, stakeholder buy-in, culture
   • Commercial & Economics (20%): Budget, ROI, cost modeling

[Turn 4] You: exit

👋 Ending session. Goodbye!
```

## Features

- ✅ Multi-turn conversations with persistent session
- ✅ Agent 1 specific guidance and help commands
- ✅ Auto-generated session IDs
- ✅ Built-in commands (exit, clear, info, help)
- ✅ Assessment dimension reference
- ✅ Keyboard interrupt handling
- ✅ Turn counter for conversation tracking
- ✅ AWS IAM authentication via boto3

## Getting Agent ARNs

To get the ARN of your deployed Agent 1:

```bash
# Using agentcore CLI
agentcore status --agent agent1_assessment --region ap-southeast-2

# From deployment output
cd /path/to/agent1_assessment
grep "agent_arn:" .bedrock_agentcore.yaml
```

## Assessment Capabilities

Agent 1 specializes in:

### **Technical Feasibility Assessment (30%)**
- Current architecture evaluation
- Integration landscape analysis
- Data strategy and readiness
- Security and identity assessment
- Performance and scalability review

### **Governance & Compliance Assessment (25%)**
- AI governance framework evaluation
- Regulatory compliance requirements
- Risk management capabilities
- Audit and traceability needs

### **Business Feasibility Assessment (25%)**
- Business objectives alignment
- Stakeholder engagement analysis
- Organizational culture readiness
- Change management capabilities

### **Commercial & Economics Assessment (20%)**
- Budget and investment planning
- Cost modeling and estimation
- ROI expectations and analysis
- Resource allocation planning

## Example Prompts

Try these prompts with Agent 1:

```bash
# Technical Assessment
"What technical information do you need to assess our readiness?"
"Can you show me the technical assessment categories?"
"We have a microservices architecture on AWS. What else do you need to know?"

# Business Assessment  
"Help me understand what business information you need"
"What stakeholder information is important for the assessment?"
"Show me the business assessment guidelines"

# Governance Assessment
"What compliance requirements should we consider?"
"Can you explain the governance assessment categories?"
"We need to comply with GDPR. How does that affect our assessment?"

# Commercial Assessment
"What budget information do you need?"
"Help me understand the cost modeling requirements"
"Show me the commercial assessment framework"
```

## Technical Details

### AWS IAM Authentication

The CLI uses boto3 with your configured AWS credentials:

1. Checks for AWS credentials using `boto3.Session().get_credentials()`
2. Creates `bedrock-agentcore` client with specified region
3. Uses `invoke_agent_runtime` API with IAM authentication
4. Handles session management and response parsing

### API Request Format

**Service:** `bedrock-agentcore`
**Method:** `invoke_agent_runtime`

**Parameters:**
```python
{
    'agentRuntimeArn': 'arn:aws:bedrock-agentcore:region:account:runtime/agent1_assessment-XXXXX',
    'runtimeSessionId': 'session-uuid',
    'payload': '{"prompt": "Your message here"}',
    'qualifier': 'DEFAULT'
}
```

## Example Output

Interactive session example:

```bash
python agent_cli_interactive.py --agent-arn arn:aws:bedrock-agentcore:ap-southeast-2:941384789627:runtime/agent1_assessment-XXXXX

✅ AWS credentials found

================================================================================
🤖 Agent 1 - Assessment & Evaluation Interactive Chat
================================================================================
Agent ARN: arn:aws:bedrock-agentcore:ap-southeast-2:941384789627:runtime/agent1_assessment-XXXXX
Session ID: session-a1b2c3d4e5f67890abcdef1234567890
Region: ap-southeast-2
================================================================================

[Turn 1] You: Hello, I would like to start an assessment

🤖 Agent: Hello! I'm Agent 1, your AI transformation assessment specialist. I'll help evaluate your organization's readiness across technical, governance, business, and commercial dimensions...

[Turn 2] You: exit

👋 Ending session. Goodbye!
```

## Troubleshooting

**AWS credentials not configured:**
```
❌ AWS credentials not configured
Run 'aws configure' to set up your credentials
```
Solution: Run `aws configure` and provide your AWS access key, secret key, and region.

**Agent not found:**
```
❌ Error: An error occurred (ResourceNotFoundException) when calling the InvokeAgentRuntime operation
```
Solution: Verify the agent ARN is correct and the agent is deployed.

**Access denied:**
```
❌ Error: An error occurred (AccessDeniedException) when calling the InvokeAgentRuntime operation
```
Solution: Ensure your AWS credentials have permissions to invoke bedrock-agentcore agents.

**Region mismatch:**
```
❌ Error: Could not connect to the endpoint URL
```
Solution: Verify the region in the agent ARN matches the `--region` parameter.

## Required AWS Permissions

Your AWS credentials need these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:InvokeAgentRuntime"
      ],
      "Resource": "arn:aws:bedrock-agentcore:*:*:runtime/agent1_assessment-*"
    }
  ]
}
```

from bedrock_agentcore import BedrockAgentCoreApp, RequestContext
from strands import Agent
from strands.agent.conversation_manager import SummarizingConversationManager
from strands.telemetry import StrandsTelemetry
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from collections import OrderedDict
import base64
import json
import os

load_dotenv()

# Langfuse tracing
_lf_pk = os.getenv("LANGFUSE_PUBLIC_KEY", "")
_lf_sk = os.getenv("LANGFUSE_SECRET_KEY", "")
_lf_url = os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
if _lf_pk and _lf_sk:
    _auth = base64.b64encode(f"{_lf_pk}:{_lf_sk}".encode()).decode()
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    _telemetry = StrandsTelemetry()
    _telemetry.tracer_provider.add_span_processor(
        SimpleSpanProcessor(OTLPSpanExporter(
            endpoint=f"{_lf_url}/api/public/otel/v1/traces",
            headers={"Authorization": f"Basic {_auth}"},
        ))
    )

from config import AGENT_MODEL
from tools.extract import extract_information, get_assessment_summary, update_assessment_field, get_next_assessment_question
from tools.design import (
    generate_technical_design, get_design_structure, get_design_section, update_design_section,
    infer_resourcing_inputs, generate_resourcing_report, get_resourcing_report, update_resourcing_report,
)
from tools.plan import generate_business_plan, generate_commercial_plan, get_planning_doc, update_planning_doc
from tools.fabricate import plan_fabrication, confirm_fabrication_plan, list_factory_agents
from tools.state import get_intake_state, update_intake_progress
from tools.kb import kb_query as _kb_query
from strands.tools import tool


@tool
def query_knowledge_base(query: str, session_id: str) -> str:
    """Search the uploaded documents for specific information.
    Use this when the user says information is in a document, or to verify/clarify something from the uploads.

    Args:
        query: What to search for
        session_id: The session ID

    Returns:
        Relevant content from uploaded documents.
    """
    return _kb_query(query, session_id)

app = BedrockAgentCoreApp()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

SYSTEM_PROMPT = """You are an agentification consultant at the Agentic AI Factory.
Your job is to determine whether a business process is worth agentifying, and if so, produce a technical design for it.

SESSION: {session_id}
SESSION STATE: {state_summary}

If the user is resuming, pick up from where the session left off based on the state above.
If the user says information is in an uploaded document, or you need to look something up from the uploads, call query_knowledge_base(query=<what to find>, session_id="{session_id}") directly.

--- PHASE 1: ASSESSMENT ---

Goal: gather enough information to make a confident Go / No-Go / Conditional-Go recommendation.

If the user uploads a document:
  Call extract_information(session_id="{session_id}") — this fills as many fields as possible from the document.
  Then call get_assessment_summary to see what was found and what's still missing.

Whether or not a document was uploaded:
  Call get_next_assessment_question(session_id="{session_id}") to find the next unanswered field.
  Ask the user about it conversationally — don't read out the field name, ask it naturally.
  When the user answers, call update_assessment_field with the exact pillar/section/field keys from get_next_assessment_question.
  Then call update_intake_progress(session_id="{session_id}", phase="assessment", progress=<completion_pct from get_next_assessment_question>, change_summary=<one line>).
  Then call get_next_assessment_question again. Repeat until it returns "complete".

When get_next_assessment_question returns "complete" (or you judge you have enough for a sound recommendation):
  Call get_assessment_summary to review everything.
  Present your Go / No-Go / Conditional-Go recommendation with clear rationale covering business fit, technical feasibility, and org readiness.
  A No-Go is a valid and valuable outcome — don't push for Go.

On confirmed Go:
  Call update_intake_progress(session_id="{session_id}", phase="assessment", progress=100, change_summary="Go confirmed").

--- PHASE 2: DESIGN ---

On user confirmation to proceed:
  Call generate_technical_design(session_id="{session_id}").
  This runs the full design generation and publishes its own progress events — it may take a minute.
  When it returns, summarise what was produced for the user.
  Call update_intake_progress(session_id="{session_id}", phase="design", progress=100, change_summary="Technical design complete").

--- PHASE 3: DESIGN EDITING ---

If the user wants to change something in the Technical Design:
  Call get_design_structure(session_id="{session_id}") to show them the sections.
  Ask which section they want to change (or infer it from their message).
  Call get_design_section(session_id="{session_id}", section_id=<id>) to show them the current content.
  Confirm the edit with the user, then call update_design_section(session_id="{session_id}", section_id=<id>, edit_instruction=<clear description of the change>).
  When it returns, summarise what changed.
  Call update_intake_progress(session_id="{session_id}", phase="design", progress=100, change_summary="Design section updated").

--- PHASE 4: RESOURCING ---

If the user asks for a resourcing estimate or effort estimate:
  Call infer_resourcing_inputs(session_id="{session_id}") to extract agents, integrations, and HITL points from the design.
  Present the inferred list to the user as a readable table showing each agent with its size (S/M/L) and reason, each integration with its size, and the HITL point count.
  Ask the user to confirm or correct any sizing, and ask how many UI touchpoints the project has.
  Once confirmed, call generate_resourcing_report(session_id="{session_id}", agents=<confirmed JSON>, integrations=<confirmed JSON>, hitl_points=<int>, ui_touchpoints=<int>).
  Summarise the result for the user.
  Call update_intake_progress(session_id="{session_id}", phase="planning", progress=33, change_summary="Resourcing report complete").

If the user wants to edit the resourcing estimate (change sizes, day values, counts, overhead, etc.):
  Call get_resourcing_report(session_id="{session_id}") to read the current state.
  Call update_resourcing_report(session_id="{session_id}", edit_instruction=<plain-language description of the change>).
  Summarise the updated estimate.

--- PHASE 5: BUSINESS PLAN ---

If the user asks for a business plan:
  Call generate_business_plan(session_id="{session_id}").
  Summarise what was produced.
  Call update_intake_progress(session_id="{session_id}", phase="planning", progress=66, change_summary="Business plan complete").
  If the user wants to edit it, call get_planning_doc(session_id="{session_id}", doc_type="business") then update_planning_doc(session_id="{session_id}", doc_type="business", edit_instruction=<instruction>).

--- PHASE 6: COMMERCIAL PLAN ---

If the user asks for a commercial plan or budget estimate:
  Ask if they have a specific developer day rate to use, or confirm using the default.
  Call generate_commercial_plan(session_id="{session_id}", day_rate=<rate or 0 for default>).
  Summarise what was produced.
  Call update_intake_progress(session_id="{session_id}", phase="planning", progress=100, change_summary="Commercial plan complete").
  If the user wants to edit it, call get_planning_doc(session_id="{session_id}", doc_type="commercial") then update_planning_doc(session_id="{session_id}", doc_type="commercial", edit_instruction=<instruction>).

--- PHASE 7: FABRICATION ---

If the user wants to build / deploy the agents from the technical design:
  Call plan_fabrication(session_id="{session_id}").
  Present the plan to the user as a table showing each agent with its action (Build / Reuse / External) and reason.
  Ask the user to confirm or adjust the plan (e.g. mark something as external, skip an agent).
  Once confirmed, call confirm_fabrication_plan(session_id="{session_id}", plan_json=<confirmed plan JSON>).
  Tell the user what was queued, what will be reused, and what needs manual setup.
  Call update_intake_progress(session_id="{session_id}", phase="implementation", progress=0, change_summary="Fabrication started — agents queued for build").

If the user asks what agents have been built or what's in the factory:
  Call list_factory_agents() and present the results.

--- INTERACTIVE RESPONSES ---

When you need the user to choose between options (yes/no, select a value, confirm/reject), include an actions block at the END of your message using this exact format:

```actions
[{{"label": "Button text", "value": "The message to send if clicked"}}, ...]
```

Examples:
- Yes/No: ```actions\n[{{"label": "✅ Yes, proceed", "value": "Yes, proceed"}}, {{"label": "❌ No, revise", "value": "No, let me revise"}}]\n```
- Day rate: ```actions\n[{{"label": "💰 $1,200/day", "value": "Use $1,200 per day"}}, {{"label": "💰 $1,500/day", "value": "Use $1,500 per day"}}, {{"label": "✏️ Custom", "value": "I want to specify a custom day rate"}}]\n```
- Confirmation: ```actions\n[{{"label": "👍 Looks good, continue", "value": "Looks good, continue"}}, {{"label": "✏️ I want to make changes", "value": "I want to make changes"}}]\n```

Always include emoji icons in button labels. Always include actions when asking for confirmation or selection. The user can still type freely instead of clicking.

Be a consultant, not a form-filler. Have a natural conversation.
Never mention tool names or field keys to the user.
"""


class LRUCache(OrderedDict):
    """Bounded LRU cache using OrderedDict."""
    def __init__(self, maxsize=100):
        super().__init__()
        self.maxsize = maxsize
    def __getitem__(self, key):
        self.move_to_end(key)
        return super().__getitem__(key)
    def __setitem__(self, key, value):
        if key in self:
            self.move_to_end(key)
        super().__setitem__(key, value)
        if len(self) > self.maxsize:
            self.popitem(last=False)

_agent_cache = LRUCache(maxsize=100)


def get_agent(session_id: str) -> Agent:
    if session_id not in _agent_cache:
        # Load current state to bake into system prompt
        state = json.loads(get_intake_state(session_id=session_id))
        state_summary = (
            f"Current phase: {state['phase']} | "
            f"Assessment: {state['assessment_progress']}% | "
            f"Design: {state['design_progress']}% | "
            f"Planning: {state['planning_progress']}% | "
            f"Implementation: {state['implementation_progress']}%"
        )
        _agent_cache[session_id] = Agent(
            model=AGENT_MODEL,
            conversation_manager=SummarizingConversationManager(
                summary_ratio=0.3,
                preserve_recent_messages=10,
            ),
            tools=[
                extract_information,
                get_assessment_summary,
                get_next_assessment_question,
                update_assessment_field,
                query_knowledge_base,
                generate_technical_design,
                get_design_structure,
                get_design_section,
                update_design_section,
                infer_resourcing_inputs,
                generate_resourcing_report,
                get_resourcing_report,
                update_resourcing_report,
                generate_business_plan,
                generate_commercial_plan,
                get_planning_doc,
                update_planning_doc,
                get_intake_state,
                update_intake_progress,
                plan_fabrication,
                confirm_fabrication_plan,
                list_factory_agents,
            ],
            system_prompt=SYSTEM_PROMPT.format(session_id=session_id, state_summary=state_summary),
        )
    return _agent_cache[session_id]


@app.entrypoint
async def invoke(payload, context: RequestContext):
    """Agent Intake (single agent) — agentification consulting"""
    session_id = payload.get("session_id", "")
    user_message = payload.get("prompt", "Hello!")

    agent = get_agent(session_id)

    messages = [{"text": user_message}]

    document_key = payload.get('sessionAttributes', {}).get('metadata', {}).get('document_upload_key')
    if document_key:
        messages = [{"text": f"I've uploaded a document. {user_message}".strip()}]

    stream = agent.stream_async(messages)
    async for event in stream:
        if "data" in event:
            yield event["data"]


if __name__ == "__main__":
    app.run()

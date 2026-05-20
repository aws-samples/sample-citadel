# Agent Intake — Unified Intake Orchestrator Design

## 1. Overview

The Agent Intake is a single-chat consulting experience that takes a user from "I have a business process" to "here is the delivery plan to agentify it." It replaces the previous 4-agent sequential pipeline with a unified orchestrator managing 4 specialist sub-agents.

The user talks to one entity throughout. Agent handoffs are invisible.

## 2. Agent Framework: What → Why → How → When

Each sub-agent has a distinct consulting role:

| Phase | Agent | Question Answered | Output |
|-------|-------|-------------------|--------|
| Assessment | Agentification Consultant | **What** is the process and **should** we agentify it? | Go / No-Go / Conditional-Go recommendation |
| HLD | Solution Architect | **Why** this architecture? What agents, what boundaries? | High-level design: agents, orchestration, integrations, HITL |
| DTD | Detailed Design Specialist | **How** exactly do we build it? | Technical spec: APIs, data models, infrastructure, security |
| Task Breakdown | Delivery Lead | **When** does each piece get built and who does it? | Delivery plan: epics, stories, sequencing, rollout |

### Assessment Agent — The Go/No-Go Gate

The assessment agent is a business consultant, not a data extractor. Its sole purpose is to determine whether the process is a good candidate for agentification and whether there is enough information to proceed to design.

It evaluates three things:
- **Business fit** — Is the problem real, significant, and worth solving?
- **Technical feasibility** — Is the process automatable? Are systems accessible?
- **Org readiness** — Are the guardrails understood? Is there executive commitment?

When sufficient information is gathered, it produces a structured recommendation (Go / No-Go / Conditional-Go) and gates entry to the HLD phase. The HLD agent has direct access to the raw documents via the knowledge base — the assessment does not need to pre-extract technical details.

### HLD, DTD, Task Breakdown Agents

These agents query the knowledge base directly for technical details from uploaded documents. They build on each other's outputs and the user's conversational input.

## 3. Architecture

### 3.1 Single AgentCore Runtime

```
AgentCore Runtime: agent_intake
├── Orchestrator Agent (Haiku 4.5)
│   ├── @tool assessment_agent   (Sonnet 4.6)
│   ├── @tool hld_agent          (Sonnet 4.6)
│   ├── @tool dtd_agent          (Sonnet 4.6)
│   └── @tool task_breakdown_agent (Sonnet 4.6)
├── Shared Tools
│   ├── document.py       (S3 read/write with versioning)
│   ├── knowledge_base.py (Bedrock KB retrieval, scoped by session_id)
│   └── state.py          (DynamoDB phase state + EventBridge events)
```

### 3.2 Session Identity

`session_id` is the single identifier used everywhere:
- DynamoDB state key
- S3 document path prefix (`{session_id}/assessment/`, `{session_id}/design/`, etc.)
- KB metadata filter (`session_id` attribute on ingested documents)
- Sub-agent conversation history prefix in S3

### 3.3 Message Flow

```
User message
    → AppSync GraphQL
        → Lambda resolver
            → AgentCore Runtime (agent_intake)
                → Orchestrator reads DynamoDB state
                → Routes to active phase's sub-agent
                → Sub-agent processes, updates documents, updates progress
                → Response streamed back to user
                → EventBridge events drive frontend progress updates
```

## 4. Assessment Templates

Three slim JSON templates stored in S3 at `{session_id}/assessment/{pillar}.json`. Purpose: track the minimum information needed for a go/no-go decision.

**Business (11 required fields across 3 sections):**
- `qualification`: process_name, executive_sponsor, problem_statement, annual_impact, volume_and_frequency
- `process_fit`: repetitive_rules_based, digital_inputs, decision_points, current_pain
- `success`: kpis, poc_criteria

**Technical (4 required fields, 1 section):**
- `feasibility`: core_systems, api_accessible, data_formats, automation_blockers

**Governance (4 required fields, 2 sections):**
- `guardrails`: hitl_requirements, compliance_constraints
- `org_readiness`: sponsor_commitment, risk_tolerance

**Total: 19 required fields.** Completion is calculated deterministically (filled required fields / total required fields). The assessment agent uses `get_next_assessment_gap` to iterate one field at a time: get gap → query KB → write result.

## 5. State Management

### 5.1 Phase State (DynamoDB)

**Table:** `citadel-session-memory-{env}`

| pk | sk | Fields |
|----|-----|--------|
| `{session_id}` | `intake:latest` | `phase`, `assessment_progress`, `hld_progress`, `dtd_progress`, `task_breakdown_progress`, `last_updated` |
| `{session_id}` | `intake:{phase}:{timestamp}` | Snapshot with 90-day TTL |

### 5.2 Phase Transitions

- Orchestrator calls `transition_phase` when a phase is complete
- Transitions are user-confirmed — orchestrator asks before moving on
- Backward transitions supported (e.g., HLD → assessment for fundamental changes)

### 5.3 EventBridge Events

| Event | Detail Type | When |
|-------|-------------|------|
| Progress update | `intake.progress.updated` | Sub-agent updates progress |
| Phase transition | `intake.phase.transitioned` | Orchestrator changes active phase |

## 6. Document Management

All documents stored in S3 with versioning. Each has a companion `.meta.json` tracking active version and change history.

**Bucket:** `citadel-sessions-{env}-{account}-{region}`

```
{session_id}/
├── assessment/
│   ├── assessment_report.md + .meta.json
│   ├── business.json            # assessment template data
│   ├── technical.json
│   └── governance.json
├── design/
│   ├── high_level_design.md + .meta.json
│   ├── detailed_technical_design.md + .meta.json
│   ├── resource_plan.md + .meta.json
│   ├── budget_estimate.md + .meta.json
│   ├── risk_assessment.md + .meta.json
│   └── timeline.md + .meta.json
├── delivery/
│   └── delivery_plan.md + .meta.json
└── uploads/                     # ingested source documents
```

## 7. Knowledge Base

Documents uploaded by the user are ingested into a Bedrock Knowledge Base (CUSTOM inline data source) with `session_id` as a metadata attribute. All KB queries are filtered by `session_id` so sessions are fully isolated.

The HLD, DTD, and task breakdown agents query the KB directly — they do not depend on the assessment to pre-extract technical details.

## 8. Conversation Memory

Each sub-agent uses:
- `SummarizingConversationManager` (Haiku 4.5 summarizer, summary_ratio=0.3, preserve_recent=10)
- `S3SessionManager` storing history at `agent-sessions/session_{id}/agents/agent_{name}/messages/`

The orchestrator uses `SummarizingConversationManager` without S3 persistence (stateless between restarts is acceptable for the routing layer).

## 9. Observability

Langfuse tracing via OTLP using `SimpleSpanProcessor` (synchronous export, no buffering). All sub-agent tool calls are traced under the same global OpenTelemetry provider set at startup.

## 10. Infrastructure

### File Structure

```
service/agent_intake/
├── agent.py                    # Orchestrator (AgentCore entry point), Langfuse init
├── config.py                   # Model IDs, make_conversation_manager(), make_session_manager()
├── agents/
│   ├── assessment.py           # Go/No-Go gate (@tool)
│   ├── hld.py                  # Solution architect (@tool)
│   ├── dtd.py                  # Detailed design (@tool)
│   └── task_breakdown.py       # Delivery lead (@tool)
├── tools/
│   ├── document.py             # S3 docs + assessment template tools
│   ├── knowledge_base.py       # KB retrieval scoped by session_id
│   └── state.py                # DynamoDB + EventBridge
├── templates/
│   ├── assessment_business.json
│   ├── assessment_technical.json
│   └── assessment_governance.json
├── tests/
│   └── test_kb.py
├── .env / .env.example
├── Dockerfile
└── requirements.txt
```

### Environment Variables

```
AWS_REGION, AWS_PROFILE
SESSION_BUCKET
SESSION_MEMORY_TABLE
KNOWLEDGE_BASE_ID
INLINE_DATA_SOURCE_ID
EVENT_BUS_NAME
ORCHESTRATOR_MODEL, AGENT_MODEL, SUMMARIZATION_MODEL
LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
```

## 11. Migration Path

Existing agent1/agent2/agent3 runtimes remain untouched. `agent_intake` runs in parallel, with frontend routing updated to use it for new projects.

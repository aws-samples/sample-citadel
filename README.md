# Citadel

**A multi-agent platform for transforming enterprises into AI-ready organizations — built on AWS Bedrock AgentCore.**

Citadel helps an organization go from "we want to adopt AI" to "we have deployment-ready, governed, AWS-architected solution specifications" — guided end to end by a coordinated team of specialized AI agents rather than a single chatbot. It assesses readiness, designs solutions, plans the roadmap, and produces implementation specifications, while enforcing engineering governance at every step.

## The problem we started from

Enterprises adopting AI rarely fail for lack of models. They fail on the unglamorous parts: honestly assessing readiness, designing against proven architecture patterns, sequencing the work, controlling cost and risk, and proving that decisions were made deliberately and can be audited later. Most "AI assistants" produce a wall of text and leave all of that to the customer.

Citadel was built working backwards from a different outcome: a customer should be able to hand in their context and walk out with a defensible solution design, a phased plan, and specifications an engineering team (human or agent) can execute — with a governance trail that a CISO, an architect, and an auditor would all accept.

## What Citadel does

Citadel runs a four-stage workflow, each stage backed by purpose-built agents and tools:

1. **Assessment** — Evaluates organizational AI readiness across technical, governance, business, and commercial dimensions, using document ingestion and a conversational assessment rather than a static questionnaire.
2. **Design** — Generates high-level and detailed solution designs grounded in AWS architecture patterns.
3. **Planning** — Produces phased implementation roadmaps with resource allocation, risk mitigation, and KPI frameworks.
4. **Implementation** — Emits specifications along three paths: traditional development specs, AI-assisted specs, or agent-fabrication specs that Citadel itself can instantiate.

The differentiator is that the work is done by a *coordinated multi-agent system* — a Supervisor decomposes and routes, specialized workers execute under scoped credentials, and a governance layer holds the whole process to a standard.

## How it works

Citadel is a four-layer system plus a Python orchestration tier:

- **Service Layer** — AWS Bedrock **AgentCore Runtime** (the conversational intake agent), an **OpenSearch Serverless Knowledge Base** for document grounding, and an **AgentCore Gateway** exposing tools over MCP (Model Context Protocol).
- **Backend Layer** — **AppSync** GraphQL API with real-time WebSocket subscriptions, **Cognito** for auth and RBAC, **DynamoDB** for state, and **EventBridge** for event-driven coordination.
- **Gateway Layer** — Per-app **API Gateway** HTTP APIs with a shared Lambda authorizer and usage metrics, so published agent apps get their own authenticated endpoint.
- **Frontend Layer** — A **React 18 / Vite / Tailwind** single-page app (Radix + shadcn-style component system) served from **S3/CloudFront**, with live updates over AppSync subscriptions.
- **Arbiter (Python)** — The orchestration brain: a **Supervisor → Fabricator → Worker** pattern, a **StepRunner** DAG workflow engine (topological scheduling, conditional edges, retry with backoff), a **circuit breaker** for resilience, and **scoped STS credential vending** so each agent runs with least privilege.

State is event-driven and eventually consistent: EventBridge carries `citadel.*` events with correlation IDs, handlers are idempotent, and DynamoDB uses optimistic locking.

## Capabilities

**Agent Apps.** Build, configure, and publish multi-agent applications. Publishing provisions a dedicated API Gateway endpoint with API-key authentication, forwards requests to EventBridge for async processing, and tracks per-app request counts, latency percentiles, and error rates. Lifecycle: `DRAFT → ACTIVE → PUBLISHED`.

**Agent Fabrication.** A Fabricator dynamically generates agents and custom tools at runtime from specifications, registers them, and binds them to data stores and integrations.

**Agent Import.** Beyond fabricating agents it owns, Citadel *imports* foreign agents that already run on heterogeneous AWS substrates — AgentCore Runtime, Bedrock Agents, Lambda, HTTP/MCP endpoints, and ECS/EKS/EC2 services resolved to an HTTP endpoint — without owning or redeploying their infrastructure. A five-step wizard discovers candidates (paste an ARN/manifest, or an account-wide tag scan; same-account or cross-account via an operator-supplied read-only role + STS external id), determines capabilities across four tiers (Tier-0 manifest, Tier-1 heuristic, Tier-2 live sandboxed probe, and a Tier-3 LLM-proposed manifest from the Fabricator that is low-confidence and human-accept-gated), and normalizes each into the existing AgentCore Registry record model as a DRAFT, externally-owned record. Imported agents are invoked through a protocol-aware dispatcher (AgentCore Runtime / Bedrock Agent / Lambda / HTTP / MCP) with cross-account assumed credentials, Secrets-Manager-backed auth, and prompt-injection sanitization of untrusted output. Every import is governed: a system-generated ADR, an authority-unit grant, an explicit attestation step, a mode-aware activation gate, IAM trust-path introspection, and a reachability probe — and an imported MCP agent can optionally be published as a target on the shared AgentCore Gateway. Citadel orchestrates imported agents but never owns them: `origin.ownership='external'` is a hard invariant, so it never deploys, scales, or deletes a customer's infrastructure. See [docs/AGENT_IMPORT.md](docs/AGENT_IMPORT.md).

**Configurable Model Selection.** Operators choose which Bedrock foundation model each arbiter role — Supervisor, Fabricator, and the intake/extraction agents — uses, without code changes or redeploys. A daily sync discovers invokable models from the live Bedrock inventory into an operator-curated catalog; an admin-only UI sets a global default, per-slot defaults, and a data-locality policy; and a pure, region-aware resolver maps the choice to a cross-region inference profile at runtime, with a bulletproof fallback to a safe default so model configuration can never break agent dispatch. See [docs/MODEL_SELECTION.md](docs/MODEL_SELECTION.md).

**Visual Workflow Builder.** A drag-and-drop canvas (ReactFlow) compiles to DAGs executed by the StepRunner, including conditional branching and bounded retries. Designs round-trip through a blueprint catalog — save a canvas as a published blueprint, load it back, or import it into an app — and each node can pin a Bedrock model and extend its system prompt via size-capped execution overrides. Workflows publish and run from the canvas or from an app's Workflows tab, stream live per-node progress over GraphQL subscriptions, and expose full execution inspection (per-node status, durations, retries, and outputs). A seeded Echo Demo Workflow runs end to end out of the box.

**27 Data Store Adapters.** A unified `ConnectorAdapter` architecture spanning S3, DynamoDB, RDS, Aurora, Redshift, Snowflake, Databricks, and more — each provisioned with a scoped IAM role (`citadel-ds-{id}`) under least privilege.

**13 Integration Types.** Seven SaaS connectors (Confluence, Jira, ServiceNow, Slack, Microsoft, PagerDuty, Zendesk), three AgentCore types (AWS Lambda for custom logic, AWS Services via Smithy, external MCP servers), and three legacy connectors (SharePoint, Salesforce, GitHub — partially implemented). Credentials are vended through scoped, short-lived STS sessions and stored in Secrets Manager.

**AI-Accelerated Modernization Governance.** A first-class governance engine that makes the agent system *accountable*:
- Architecture Decision Records with locking and controlled reopen attempts, execution specifications with an approval lifecycle, interrogation rounds (with encrypted transcripts), agent design assessments, and program reviews against a structured checklist.
- A constitutional rule hierarchy, case law, authority units, and composition contracts that constrain what agents are permitted to do.
- IAM trust-path and drift analysis, decision tracing, mismatch heatmaps, escalation ledgers, and rollout-readiness checks — surfaced in dedicated governance UI views.
- Progressive enforcement modes — `permissive` (telemetry only) → `shadow` (block-in-logs) → `strict` (hard block) — with grandfathering so existing projects aren't broken by newly introduced gates.

**Access Control.** App-level RBAC (owner/editor/viewer) integrated with Cognito groups, plus platform roles (admin, project manager, architect, developer).

**Security by construction.** Least-privilege IAM via a central PolicyManager, KMS encryption at rest (including SSE-KMS-enforced transcript buckets that deny non-KMS writes), TLS in transit, field-scoped AppSync grants, input validation and credential redaction at the resolver boundary, and cdk-nag checks in the build.

## Value proposition

Citadel turns AI adoption from an open-ended consulting engagement into a **repeatable, governed, AWS-native workflow**. It compresses the path from intent to deployable specification, and — uniquely — it produces an auditable record of *why* each decision was made, which is what makes the output trustworthy enough to act on.

## Benefit to AWS Partners

- **Accelerate delivery.** Partners can take a customer from assessment to deployment-ready specs in a fraction of the usual time, with AWS architecture patterns baked in.
- **Standardize quality.** The governance engine enforces a consistent engineering bar across every engagement and every consultant, with evidence to back it.
- **Extend, don't rebuild.** The adapter and integration framework, plus runtime agent fabrication, let partners add customer-specific data sources, tools, and agents without forking the platform.
- **Productize expertise.** Partners can publish reusable agent apps and workflow blueprints as authenticated, metered endpoints — turning repeatable know-how into a deployable asset.

## Benefit to AWS customers

- **Faster, lower-risk AI adoption.** A guided, four-stage path replaces guesswork, with risk mitigation and KPIs built into the plan.
- **Architectures you can defend.** Designs follow AWS Well-Architected guidance across all six pillars, and every decision is recorded and traceable.
- **Governance without friction.** Progressive enforcement and grandfathering let teams adopt guardrails incrementally instead of all at once.
- **No lock-in to a black box.** Open architecture, 27 data store adapters, and standard integrations mean customers connect their existing estate rather than migrating into a silo.
- **Cost-aware by default.** On-demand DynamoDB, serverless compute, and scoped resources align spend with usage.

## Built on AWS, aligned to Well-Architected

Citadel is serverless-first and event-driven: AgentCore Runtime + Gateway, AppSync, Cognito, DynamoDB, EventBridge, Lambda, API Gateway, S3/CloudFront, KMS, Secrets Manager, and OpenSearch Serverless. The codebase applies all six Well-Architected pillars — operational excellence (structured logging, X-Ray, CDK automation), security (least privilege, encryption, scoped credentials), reliability (circuit breakers, idempotency, optimistic locking), performance, cost optimization, and sustainability.

## Architecture at a glance

```
Frontend (React/CloudFront)
        │  GraphQL + subscriptions
Backend (AppSync · Cognito · DynamoDB · EventBridge)
        │  events (citadel.*)
Arbiter (Supervisor → Fabricator → Worker · StepRunner DAG)
        │  MCP tools · scoped STS
Service (AgentCore Runtime · Gateway · Knowledge Base)
        │
Gateway (per-app API Gateway · authorizer · metrics)
```

Deployed as focused CDK stacks: `backend`, `services`, `arbiter`, `gateway`, `frontend`, `knowledge-base`, `governance`, and a self-mutating `pipeline`.

## Getting started

```bash
cp backend/.env.example backend/.env   # set AWS account + admin config
export AWS_PROFILE="your-aws-profile"
./deploy.sh --profile your-aws-profile
```

Prerequisites: AWS CLI, Node.js 24+, Python 3.14+, CDK 2.100+, and Finch (or Docker). See `docs/DEPLOYMENT.md` for the full guide.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** - Architecture overview, layer interactions, data flows
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** - Complete deployment guide
- **[docs/QUICK_START.md](docs/QUICK_START.md)** - 5-minute quick start
- **[docs/EVENTBRIDGE_CATALOG.md](docs/EVENTBRIDGE_CATALOG.md)** - EventBridge event catalog (all event types and schemas)
- **[docs/RESOLVER_GUIDE.md](docs/RESOLVER_GUIDE.md)** - Lambda resolver development guide
- **[docs/ADAPTER_GUIDE.md](docs/ADAPTER_GUIDE.md)** - Adapter development guide (adding datastores/integrations)
- **[docs/AGENT_APPS.md](docs/AGENT_APPS.md)** - Agent Apps platform architecture
- **[docs/BLUEPRINTS_WORKFLOWS.md](docs/BLUEPRINTS_WORKFLOWS.md)** - Workflow engine and DAG execution
- **[docs/WORKFLOW_USER_GUIDE.md](docs/WORKFLOW_USER_GUIDE.md)** - End-to-end workflow guide (blueprints, canvas, publish, run, inspect)
- **[docs/DATASTORES_INTEGRATIONS.md](docs/DATASTORES_INTEGRATIONS.md)** - Datastore and integration subsystem
- **[docs/AGENT_PERMISSIONS.md](docs/AGENT_PERMISSIONS.md)** - Agent scoped credentials
- **[docs/MODEL_SELECTION.md](docs/MODEL_SELECTION.md)** - Configurable per-agent model selection (catalog sync, runtime resolution, operator UI)
- **[docs/POLICY_MANAGER.md](docs/POLICY_MANAGER.md)** - IAM policy management
- **[docs/INTEGRATION_SETUP.md](docs/INTEGRATION_SETUP.md)** - Integration types setup
- **[docs/FRONTEND_TESTING_GUIDE.md](docs/FRONTEND_TESTING_GUIDE.md)** - Frontend integration testing

## FAQ

**Is this a single AI agent?** No. It's a coordinated multi-agent system implementing an Arbiter pattern, with a Supervisor that decomposes and routes work to specialized agents, each running under scoped, least-privilege credentials.

**Does it lock me into a proprietary stack?** No. It runs on standard AWS services and connects to your existing data and SaaS estate through 27 data store adapters and 13 integration types.

**How is the output trustworthy?** Every significant decision is recorded (ADRs, execution specs, program reviews) and governed by a constitutional rule hierarchy, with IAM trust-path analysis and decision tracing for audit.

**Can we adopt governance gradually?** Yes. Enforcement moves from permissive → shadow → strict, and grandfathering protects projects created before a gate existed.

**What's still maturing?** The three legacy connectors (SharePoint, Salesforce, GitHub) are partially implemented. Agent Import is built end to end (discover → describe → register → govern → invoke), with a few extensions deferred: REST/OpenAPI gateway publish (MCP gateway publish is built), a peered-VPC reachability prober for private/cross-account targets, gateway auth offload beyond NONE/API_KEY/BEARER, and invoke/discovery for the A2A / Step Functions / SageMaker protocols. Everything else described above is implemented in the codebase.

## Project status, contributing, and license

Citadel is an actively developed, deploy-ready platform. Contribution guidelines are in `CONTRIBUTING.md`, community standards in `CODE_OF_CONDUCT.md`, and licensing in `LICENSE`. Development follows strict TDD (Red-Green-Refactor) with property-based testing on adapters, resolvers, and orchestration logic.

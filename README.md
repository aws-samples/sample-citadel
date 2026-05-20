# Citadel

Multi-agent AI system for enterprise application development using AWS Bedrock AgentCore.

## Architecture

4-layer architecture:

- **Service Layer**: AgentCore Runtime (agent_intake_single) + Knowledge Base (OpenSearch Serverless) + AgentCore Gateway (MCP)
- **Backend Layer**: AppSync GraphQL API, Cognito, DynamoDB, EventBridge
- **Gateway Layer**: Per-app API Gateway HTTP APIs, Lambda authorizer, usage metrics
- **Frontend Layer**: React UI on S3/CloudFront

## Key Features

- **Agent Apps**: Build, configure, and publish multi-agent applications
- **App Publishing**: Provision per-app API Gateway endpoints with API key authentication
- **Data Stores**: 27 storage backend adapters (S3, DynamoDB, RDS, Aurora, Redshift, Snowflake, Databricks, etc.) with scoped IAM roles
- **Integrations**: 13 connector types — 7 SaaS (Confluence, Jira, ServiceNow, Slack, Microsoft, Zendesk, PagerDuty) + 3 legacy (SharePoint, Salesforce, GitHub) + 3 AgentCore (AWS Lambda, AWS Smithy, MCP Server)
- **Agent Fabrication**: Dynamically create agents at runtime using the Fabricator
- **Workflow Builder**: Visual drag-and-drop workflow canvas with blueprint templates
- **Access Control**: App-level RBAC (owner/editor/viewer) with Cognito group integration

## Prerequisites

- AWS CLI configured with credentials
- Node.js 24+
- Python 3.14+
- CDK 2.100.0
- Finch (or Docker)

## Quick Start

```bash
# 1. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env with your AWS account and admin credentials

# 2. Deploy
export AWS_PROFILE="your-aws-profile"
./deploy.sh --profile your-aws-profile
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for complete deployment guide.

## App Publishing

Published apps get their own API Gateway HTTP API endpoint with:
- **API Key Authentication**: Custom keys validated by a shared Lambda authorizer
- **EventBridge Integration**: Requests forwarded to the event bus for async processing
- **Usage Metrics**: Per-app request counts, latency percentiles, error rates
- **API Dashboard**: Frontend tab with endpoint URL, API key management, and metrics charts

Lifecycle: DRAFT → Activate → ACTIVE → Publish → PUBLISHED (with API endpoint)

## Integration Types

The platform supports 13 integration types:

**SaaS Connectors (7):** Confluence, Jira, ServiceNow, Slack, Microsoft, PagerDuty, Zendesk

**Legacy Connectors (3):** SharePoint, Salesforce, GitHub (not yet fully implemented)

**AgentCore Types (3):**

- **AWS Lambda** - Execute custom business logic as MCP tools
- **AWS Services (Smithy)** - Direct AWS service access (DynamoDB, S3, Lambda, SQS, SNS)
- **MCP Server** - Connect to external MCP-compatible servers

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for detailed integration setup.

## CDK Stacks

| Stack | Purpose |
|-------|---------|
| `citadel-backend-{env}` | AppSync API, Cognito, DynamoDB, Lambda resolvers, EventBridge |
| `citadel-services-{env}` | AgentCore Runtime, AgentCore Gateway, Knowledge Base, health monitor, tool sandbox |
| `citadel-arbiter-{env}` | Supervisor, Fabricator, Worker wrapper, Step Runner, credential vending |
| `citadel-gateway-{env}` | App publish handler, Lambda authorizer, metrics handler |
| `citadel-frontend-{env}` | React app on S3/CloudFront |
| `citadel-knowledge-base-{env}` | Bedrock Knowledge Base for document ingestion |
| `citadel-pipeline-{env}` | CI/CD CodePipeline (self-mutating, multi-env) |

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** - Architecture overview, layer interactions, data flows
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** - Complete deployment guide
- **[docs/QUICK_START.md](docs/QUICK_START.md)** - 5-minute quick start
- **[docs/EVENTBRIDGE_CATALOG.md](docs/EVENTBRIDGE_CATALOG.md)** - EventBridge event catalog (all event types and schemas)
- **[docs/RESOLVER_GUIDE.md](docs/RESOLVER_GUIDE.md)** - Lambda resolver development guide
- **[docs/ADAPTER_GUIDE.md](docs/ADAPTER_GUIDE.md)** - Adapter development guide (adding datastores/integrations)
- **[docs/AGENT_APPS.md](docs/AGENT_APPS.md)** - Agent Apps platform architecture
- **[docs/BLUEPRINTS_WORKFLOWS.md](docs/BLUEPRINTS_WORKFLOWS.md)** - Workflow engine and DAG execution
- **[docs/DATASTORES_INTEGRATIONS.md](docs/DATASTORES_INTEGRATIONS.md)** - Datastore and integration subsystem
- **[docs/AGENT_PERMISSIONS.md](docs/AGENT_PERMISSIONS.md)** - Agent scoped credentials
- **[docs/POLICY_MANAGER.md](docs/POLICY_MANAGER.md)** - IAM policy management
- **[docs/INTEGRATION_SETUP.md](docs/INTEGRATION_SETUP.md)** - Integration types setup
- **[docs/FRONTEND_TESTING_GUIDE.md](docs/FRONTEND_TESTING_GUIDE.md)** - Frontend integration testing

## Resource Naming

All resources use `citadel-*` prefix with environment suffix:
- **Stacks**: `citadel-{component}-{env}`
- **Agents**: `agent{N}_{name}_{env}`
- **Tables**: `citadel-{resource}-{env}`
- **Buckets**: `citadel-{resource}-{env}-{account}-{region}`
- **Per-app APIs**: `citadel-app-{appId}-{env}`
- **Scoped IAM roles**: `citadel-agent-{appId}`, `citadel-ds-{dataStoreId}`

## Cleanup

```bash
export ENVIRONMENT=dev
export AWS_PROFILE="your-profile"

# Delete stacks in reverse order
aws cloudformation delete-stack --stack-name citadel-frontend-${ENVIRONMENT}
aws cloudformation delete-stack --stack-name citadel-gateway-${ENVIRONMENT}
aws cloudformation delete-stack --stack-name citadel-arbiter-${ENVIRONMENT}
aws cloudformation delete-stack --stack-name citadel-services-${ENVIRONMENT}
aws cloudformation delete-stack --stack-name citadel-backend-${ENVIRONMENT}

# Clean local artifacts
./clean.sh
```

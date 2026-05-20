# Backend Layer - Citadel

AWS AppSync GraphQL API with real-time subscriptions, Cognito authentication, and CDK infrastructure for the Citadel platform.

## Architecture Overview

The Backend layer provides:
- **AWS AppSync GraphQL API** with real-time WebSocket subscriptions
- **Amazon Cognito** authentication with RBAC (Role-Based Access Control)
- **DynamoDB** for data persistence and state management
- **EventBridge** for agent coordination and event-driven architecture
- **Lambda resolvers** for custom business logic
- **S3 + CloudFront** for frontend hosting
- **CDK Infrastructure as Code** for deployment automation

## Technology Stack

- **API Gateway**: AWS AppSync (GraphQL with real-time subscriptions)
- **Authentication**: Amazon Cognito (User Pools + Identity Pools)
- **Database**: Amazon DynamoDB
- **Event Bus**: Amazon EventBridge
- **Compute**: AWS Lambda (Node.js 24.x, Python 3.14)
- **Frontend Hosting**: Amazon S3 + CloudFront
- **Infrastructure**: AWS CDK (TypeScript)

## Project Structure

```
backend/
├── bin/
│   └── app.ts                 # CDK app entry point
├── lib/
│   ├── backend-stack.ts       # Main infrastructure stack
│   ├── arbiter-stack.ts       # Agent orchestration stack
│   ├── services-stack.ts      # AgentCore services stack
│   ├── gateway-stack.ts       # Gateway registration stack
│   └── frontend-stack.ts      # Frontend hosting stack
├── src/
│   ├── adapters/              # Unified connector architecture
│   │   ├── base.ts            # ConnectorAdapter interface
│   │   ├── errors.ts          # ConnectorError hierarchy
│   │   ├── lifecycle.ts       # LifecycleManager (state machine)
│   │   ├── registry.ts        # UnifiedRegistry (all adapters)
│   │   └── integration/       # Integration adapter base class
│   ├── lambda/                # Lambda resolver functions
│   │   ├── adapters/          # Concrete datastore adapters (20 files)
│   │   ├── datastore-resolver.ts
│   │   ├── integration-resolver.ts
│   │   ├── agent-config-resolver.ts
│   │   ├── conversation-resolver.ts
│   │   └── ... (13 resolver files total)
│   ├── schema/
│   │   └── schema.graphql     # GraphQL schema definition
│   ├── types/
│   │   └── index.ts           # TypeScript type definitions
│   └── utils/                 # Shared utilities
│       ├── policy-manager.ts  # Scoped IAM role management
│       ├── policy-helpers.ts  # Dynamic permission computation
│       ├── credential-manager.ts
│       ├── lifecycle-validator.ts
│       ├── connector-registry.ts
│       ├── connection-tester.ts
│       ├── gateway-target-manager.ts
│       ├── auth.ts
│       ├── validation.ts
│       ├── events.ts
│       ├── dynamodb.ts
│       └── logger.ts
├── test/                      # Jest setup files
│   ├── setup.ts
│   └── integration-setup.ts
├── cdk.json                   # CDK configuration
├── package.json               # Dependencies and scripts
└── .env.example               # Environment variables template
```

Tests are colocated with source code in `__tests__/` directories adjacent to the files they test.

## Getting Started

### Prerequisites

- Node.js 18.x or later
- AWS CLI configured with appropriate credentials
- AWS CDK CLI installed globally: `npm install -g aws-cdk`

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your AWS account details
   ```

3. Bootstrap CDK (first time only):
   ```bash
   cdk bootstrap
   ```

### Development

1. Build the project:
   ```bash
   npm run build
   ```

2. Build Lambda functions:
   ```bash
   npm run build:lambda
   ```

3. Synthesize CloudFormation templates:
   ```bash
   npm run cdk:synth
   ```

4. Deploy infrastructure:
   ```bash
   npm run deploy
   ```

### Testing

- Unit tests: `npm test`
- Integration tests: `npm run test:integration`
- Linting: `npm run lint`
- Format code: `npm run format`

## GraphQL API

### Schema Overview

The GraphQL schema includes:

- **Queries**: Get projects, agent status, conversation history
- **Mutations**: Create/update projects, send messages, upload documents
- **Subscriptions**: Real-time updates for agent status, conversations, progress

### Key Types

- `Project`: Main project entity with status and progress tracking
- `AgentStatus`: Real-time agent processing status
- `ConversationMessage`: Bi-directional messaging between UI and agents
- `ProjectProgress`: Detailed progress tracking across all phases

### Authentication

All GraphQL operations require Cognito authentication. The API supports:

- **User Pool Authentication**: Primary authentication method
- **IAM Authentication**: For service-to-service communication

### Role-Based Access Control (RBAC)

Four user roles with different permissions:

1. **Admin**: Full system access
2. **Project Manager**: Project management and monitoring
3. **Architect**: Project interaction and agent communication
4. **Developer**: Read-only access to projects and implementations

## Real-time Features

### WebSocket Subscriptions

- `onAgentStatusUpdate`: Real-time agent processing updates
- `onConversationMessage`: Live messaging between UI and agents
- `onProjectProgress`: Progress updates across assessment, design, planning phases

### Event-Driven Architecture

EventBridge coordinates agent workflows:

- Project lifecycle events
- Agent task coordination
- Error handling and notifications
- Progress synchronization

## Database Schema

### DynamoDB Tables

1. **Projects Table** — Partition Key: `id`
2. **Conversations Table** — Partition Key: `projectId`, Sort Key: `timestamp`
3. **Agent Status Table** — Partition Key: `projectId`, Sort Key: `agentId`
4. **Agent Config Table** — Partition Key: `agentId`
5. **Tools Config Table** — Partition Key: `toolId`
6. **DataStores Table** — Partition Key: `dataStoreId`, GSI on `orgId`
7. **Integrations Table** — Partition Key: `PK`, Sort Key: `SK`
8. **Organizations Table** — Partition Key: `orgId`
9. **Orchestration Table** — Partition Key: `orchestrationId`

## Deployment

### CDK Stacks

1. **Backend Stack**: Core infrastructure (AppSync, Cognito, DynamoDB, Lambda resolvers)
2. **Services Stack**: AgentCore services, Bedrock blueprints, gateway user pool
3. **Arbiter Stack**: Agent orchestration (Supervisor, Fabricator, Worker wrapper Lambdas)
4. **Gateway Stack**: AgentCore Gateway registration via EventBridge
5. **Frontend Stack**: Static website hosting (S3, CloudFront)

### Environment Configuration

Set these environment variables:

```bash
AWS_REGION=us-east-1
CDK_DEFAULT_ACCOUNT=123456789012
CDK_DEFAULT_REGION=us-east-1
```

### CI/CD Pipeline with GitLab Integration

The pipeline stack now supports GitLab as a source repository using AWS CodeStar connections. This provides secure, OAuth-based integration without requiring personal access tokens.

#### Setting up GitLab Integration

1. **Create CodeStar Connection**:
   - Go to AWS CodePipeline console → Settings → Connections
   - Create a new connection for GitLab
   - Follow the OAuth authorization flow
   - Note the connection ARN

2. **Deploy Pipeline with GitLab**:
   ```typescript
   new PipelineStack(app, 'PipelineStack', {
     sourceRepository: 'your-gitlab-username/citadel',
     sourceBranch: 'main',
     useGitlab: true,
     gitlabConnectionArn: 'arn:aws:codestar-connections:region:account:connection/id',
   });
   ```

3. **Alternative GitHub Integration**:
   ```typescript
   new PipelineStack(app, 'PipelineStack', {
     sourceRepository: 'your-github-username/citadel',
     sourceBranch: 'main',
     githubToken: 'github-token-secret-name',
   });
   ```

For detailed deployment instructions, see the [deployment guide](../docs/DEPLOYMENT.md).

### Deployment Commands

```bash
# Deploy all stacks
npm run deploy

# Deploy specific stack
cdk deploy CitadelBackend

# Deploy pipeline stack
cdk deploy CitadelPipeline

# Destroy infrastructure
npm run cdk:destroy
```

## Service Layer Integration

The backend integrates with the Service Layer agents through:

- **EventBridge Events**: Trigger agent workflows
- **HTTP APIs**: Direct communication with agent services
- **Message Queues**: Asynchronous task processing

### Agent Communication Protocol

```json
{
  "projectId": "uuid",
  "agentId": "agent1|agent2|agent3|agent4",
  "messageType": "user_input|agent_response|system_notification",
  "payload": {
    "content": "string",
    "metadata": "object",
    "timestamp": "ISO8601"
  },
  "correlationId": "uuid"
}
```

## Monitoring and Logging

### CloudWatch Integration

- **API Logs**: All GraphQL operations logged
- **Lambda Logs**: Resolver function execution logs
- **X-Ray Tracing**: Distributed tracing enabled
- **Custom Metrics**: Agent performance and error rates

### Structured Logging

All logs use structured JSON format with:
- Timestamp and log level
- Request/correlation IDs
- User and project context
- Error details and stack traces

## Security

### Authentication & Authorization

- **Cognito User Pools**: User authentication
- **JWT Tokens**: Stateless authentication
- **Field-level Authorization**: GraphQL field protection
- **Resource-level Authorization**: Project access control

### Data Protection

- **Encryption at Rest**: DynamoDB and S3 encryption
- **Encryption in Transit**: HTTPS/WSS only
- **Input Validation**: All inputs sanitized and validated
- **CORS Configuration**: Restricted origins

## Performance Optimization

### Caching Strategy

- **CloudFront**: Static asset caching
- **AppSync Caching**: GraphQL response caching
- **DynamoDB**: Optimized query patterns

### Scalability

- **Auto Scaling**: DynamoDB on-demand billing
- **Lambda Concurrency**: Automatic scaling
- **Connection Management**: WebSocket connection pooling

## Troubleshooting

### Common Issues

1. **Deployment Failures**: Check AWS credentials and permissions
2. **GraphQL Errors**: Verify schema and resolver implementations
3. **Authentication Issues**: Check Cognito configuration
4. **Real-time Issues**: Verify WebSocket connections and subscriptions

### Debug Commands

```bash
# View CloudFormation events
cdk diff

# Check Lambda logs
aws logs tail /aws/lambda/ProjectResolverFunction --follow

# Test GraphQL endpoint
curl -X POST https://your-api.appsync-api.region.amazonaws.com/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "query { listProjects { items { id name } } }"}'
```

## Contributing

1. Follow TypeScript best practices
2. Add unit tests for new features
3. Update documentation for API changes
4. Use structured logging for debugging
5. Follow AWS security best practices

## License

This project is part of the Citadel platform.
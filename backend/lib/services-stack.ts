import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { NagSuppressions } from 'cdk-nag';
import * as path from 'path';

/**
 * Derive the Bedrock cross-region inference-profile prefix for a region.
 *
 * Mirrors arbiter/supervisor/index.py::_cross_region_prefix EXACTLY so the
 * TypeScript (CDK) and Python (runtime) sides stay consistent. The 'au.'
 * profile only exists in ap-southeast-2; every other region resolves to its
 * geographic code, defaulting to 'us' (valid in us-west-2).
 */
export function crossRegionPrefix(region: string): string {
  if (region.startsWith('us-')) return 'us';
  if (region.startsWith('eu-')) return 'eu';
  if (region === 'ap-southeast-2') return 'au';
  if (region.startsWith('ap-')) return 'apac';
  if (region.startsWith('me-')) return 'me';
  if (region.startsWith('ca-')) return 'ca';
  if (region.startsWith('sa-')) return 'sa';
  if (region.startsWith('af-')) return 'af';
  return 'us';
}

export interface ServicesStackProps extends cdk.StackProps {
  environment: string;
  agentEventBus: events.EventBus;
  documentBucket: s3.Bucket;
  // Optional AgentCore Registry handles so the intake runtime can read the
  // factory catalog (fabricated agents live in the Registry, not DynamoDB).
  // Optional + conditionally wired — mirrors the fabricator in arbiter-stack.ts
  // — so test paths that construct ServicesStack without a registry still work.
  registryArn?: string;
  registryId?: string;
}

export class ServicesStack extends cdk.Stack {
  public readonly sessionMemoryTable: dynamodb.Table;
  public readonly sessionBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
      super(scope, id, props);

      // Session Memory Table
      this.sessionMemoryTable = new dynamodb.Table(this, 'SessionMemoryTable', {
        tableName: `citadel-session-memory-${props.environment}`,
        partitionKey: { name: 'p_key', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 's_key', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        timeToLiveAttribute: 'ttl',
      });

      // Session Data Bucket
      const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
              bucketName: `citadel-services-s3-logs-${props.environment}-${this.account}-${this.region}`,
              encryption: s3.BucketEncryption.S3_MANAGED,
              blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
              enforceSSL: true,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
              autoDeleteObjects: true,
              lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
            });
      
            this.sessionBucket = new s3.Bucket(this, 'SessionBucket', {
                    bucketName: `citadel-sessions-${props.environment}-${this.account}-${this.region}`,
                    versioned: true,
                    encryption: s3.BucketEncryption.S3_MANAGED,
                    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                    enforceSSL: true,
                    serverAccessLogsBucket: accessLogsBucket,
                    serverAccessLogsPrefix: 'sessions/',
                    removalPolicy: cdk.RemovalPolicy.DESTROY,
                    autoDeleteObjects: true,
                    lifecycleRules: [
                      {
                        id: 'DeleteOldSessions',
                        enabled: true,
                        expiration: cdk.Duration.days(90),
                      },
                    ],
                  });

      // Schemas Bucket for Gateway Target OpenAPI schemas
      const schemasBucket = new s3.Bucket(this, 'SchemasBucket', {
              bucketName: `citadel-schemas-${props.environment}-${this.account}-${this.region}`,
              encryption: s3.BucketEncryption.S3_MANAGED,
              blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
              enforceSSL: true,
              serverAccessLogsBucket: accessLogsBucket,
              serverAccessLogsPrefix: 'schemas/',
              removalPolicy: cdk.RemovalPolicy.DESTROY,
              autoDeleteObjects: true,
            });

      // Deploy Confluence OpenAPI schema to S3
      new s3deploy.BucketDeployment(this, 'DeployConfluenceSchema', {
        sources: [s3deploy.Source.asset('src/schema')],
        destinationBucket: schemasBucket,
        include: ['confluence-openapi.json'],
      });

      // Cognito User Pool for AgentCore Gateway OAuth
      const gatewayUserPool = new cognito.UserPool(this, 'GatewayUserPool', {
              userPoolName: `citadel-gateway-${props.environment}`,
              selfSignUpEnabled: false,
              passwordPolicy: {
                minLength: 12,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
              },
              featurePlan: cognito.FeaturePlan.ESSENTIALS,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

      // cdk-nag: AwsSolutions-COG2 (MFA requirement) is inapplicable to a
      // machine-to-machine OAuth issuer. GatewayUserPool is used solely for
      // client-credentials token exchange by AgentCore Gateway; there is no
      // human login flow to enforce MFA on. Adding MFA would break M2M auth.
      NagSuppressions.addResourceSuppressions(gatewayUserPool, [
        {
          id: 'AwsSolutions-COG2',
          reason:
            'GatewayUserPool is a machine-to-machine OAuth 2.0 client_credentials issuer used ' +
            'by AgentCore Gateway for token exchange. MFA is inapplicable: there is no human ' +
            'login flow against this pool; only signed M2M token requests using clientId + ' +
            'clientSecret. Adding MFA would prevent the M2M auth flow from functioning.',
        },
      ]);

      // Cognito Domain for OAuth token endpoint
      const gatewayDomain = gatewayUserPool.addDomain('GatewayDomain', {
        cognitoDomain: {
          domainPrefix: `citadel-gateway-${props.environment}-${cdk.Stack.of(this).account}`,
        },
      });

      // Cognito User Pool Client (M2M) with client credentials flow
      const gatewayClient = gatewayUserPool.addClient('GatewayClient', {
        userPoolClientName: `gateway-m2m-client-${props.environment}`,
        generateSecret: true,
        authFlows: {
          userPassword: false,
          userSrp: false,
          custom: false,
        },
        oAuth: {
          flows: {
            clientCredentials: true,
          },
          scopes: [cognito.OAuthScope.custom('confluence/read')],
        },
      });

      // Resource Server for custom scopes
      const gatewayResourceServer = gatewayUserPool.addResourceServer('GatewayResourceServer', {
        identifier: 'confluence',
        scopes: [
          {
            scopeName: 'read',
            scopeDescription: 'Read access to Confluence via Gateway',
          },
        ],
      });

      // Ensure resource server is created before client
      gatewayClient.node.addDependency(gatewayResourceServer);

      // IAM Role for Gateway
      const gatewayRole = new iam.Role(this, 'GatewayRole', {
        roleName: `citadel-gateway-role-${props.environment}-${this.region}`,
        path: '/service-role/',
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        description: 'Execution role for AgentCore Gateway',
      });

      // AgentCore Gateway (CloudFormation L1 construct)
      const gateway = new bedrockagentcore.CfnGateway(this, 'AgentCoreGateway', {
        name: `citadel-gateway-${props.environment}`,
        authorizerType: 'CUSTOM_JWT',
        protocolType: 'MCP',
        roleArn: gatewayRole.roleArn,
        authorizerConfiguration: {
          customJwtAuthorizer: {
            allowedClients: [gatewayClient.userPoolClientId],
            discoveryUrl: `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${gatewayUserPool.userPoolId}/.well-known/openid-configuration`,
          },
        },
      });

      // Gateway Base Policy - GetGateway permission
      gatewayRole.addToPolicy(new iam.PolicyStatement({
        sid: 'GetGateway',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:GetGateway'],
        resources: [gateway.attrGatewayArn],
      }));

      // Gateway API Key Policy - Workload identity and secrets access
      gatewayRole.addToPolicy(new iam.PolicyStatement({
        sid: 'GetWorkloadAccessToken',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:GetWorkloadAccessToken'],
        resources: [
          `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:workload-identity-directory/default/workload-identity/${gateway.name}-*`,
        ],
      }));

      gatewayRole.addToPolicy(new iam.PolicyStatement({
        sid: 'GetResourceApiKey',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:GetResourceApiKey'],
        resources: [
          `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:token-vault/default`,
          `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:token-vault/default/apikeycredentialprovider/*`,
          `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:workload-identity-directory/default/workload-identity/${gateway.name}-*`,
        ],
      }));

      // Get Confluence domain from context or use default
      const confluenceDomain = this.node.tryGetContext('confluenceDomain') || 'snathanausamzn.atlassian.net';

      // Secrets Manager Secret for OAuth credentials (populated by Custom Resource)
      const gatewaySecret = new secretsmanager.Secret(this, 'GatewayOAuthSecret', {
        secretName: `citadel/gateway-oauth-${props.environment}`,
        description: 'OAuth credentials for AgentCore Gateway Confluence integration',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            client_id: 'placeholder',
            client_secret: 'placeholder',
            token_url: 'placeholder',
            confluence_domain: 'placeholder',
          }),
          generateStringKey: '_initial_secret',
        },
      });

      // Ensure gatewaySecret is created after gatewayDomain
      gatewaySecret.node.addDependency(gatewayDomain);

      // Lambda function to fetch Cognito client secret and update Secrets Manager
      const cognitoSecretHandler = new lambda.Function(this, 'CognitoSecretHandler', {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('src/lambda/cognito-secret-handler'),
        timeout: cdk.Duration.seconds(30),
        tracing: lambda.Tracing.ACTIVE, // O-03
        environment: {
          POWERTOOLS_SERVICE_NAME: 'citadel', // O-02
          POWERTOOLS_LOG_LEVEL: 'INFO',
        },
      });

      // Grant permissions to Lambda
      cognitoSecretHandler.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:DescribeUserPoolClient'],
        resources: [gatewayUserPool.userPoolArn],
      }));
 
      gatewaySecret.grantWrite(cognitoSecretHandler);

      // Custom Resource to sync Cognito client secret to Secrets Manager
      const cognitoSecretSync = new cr.AwsCustomResource(this, 'CognitoSecretSync', {
        onCreate: {
          service: 'Lambda',
          action: 'invoke',
          parameters: {
            FunctionName: cognitoSecretHandler.functionName,
            Payload: JSON.stringify({
              RequestType: 'Create',
              ResourceProperties: {
                UserPoolId: gatewayUserPool.userPoolId,
                ClientId: gatewayClient.userPoolClientId,
                SecretArn: gatewaySecret.secretArn,
                TokenUrl: `https://${gatewayDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com/oauth2/token`,
                ConfluenceDomain: confluenceDomain,
                Version: '2', // Increment to force update
              },
            }),
          },
          physicalResourceId: cr.PhysicalResourceId.of('CognitoSecretSync'),
        },
        onUpdate: {
          service: 'Lambda',
          action: 'invoke',
          parameters: {
            FunctionName: cognitoSecretHandler.functionName,
            Payload: JSON.stringify({
              RequestType: 'Update',
              ResourceProperties: {
                UserPoolId: gatewayUserPool.userPoolId,
                ClientId: gatewayClient.userPoolClientId,
                SecretArn: gatewaySecret.secretArn,
                TokenUrl: `https://${gatewayDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com/oauth2/token`,
                ConfluenceDomain: confluenceDomain,
                Version: '2', // Increment to force update
              },
            }),
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['lambda:InvokeFunction'],
            resources: [cognitoSecretHandler.functionArn],
          }),
        ]),
      });

      cognitoSecretSync.node.addDependency(gatewayClient);
      cognitoSecretSync.node.addDependency(gatewaySecret);

      // Grant Gateway role access to read OAuth secret
      gatewaySecret.grantRead(gatewayRole);

      // Grant Gateway role access to bedrock-agentcore-identity secrets
      gatewayRole.addToPolicy(new iam.PolicyStatement({
        sid: 'GetSecretValue',
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
        ],
        resources: [
          `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:bedrock-agentcore-identity!default/apikey/confluence-${props.environment}-*`,
        ],
      }));

      // Optional: Confluence Integration - Disabled for now
      // To enable: Create SSM parameters as described in CONFLUENCE_SETUP.md
      new cdk.CfnOutput(this, 'ConfluenceIntegrationStatus', {
        value: 'Disabled - Not configured',
        description: 'Confluence integration skipped (optional)',
      });

      // PDF Generator — invoked on-demand when user requests a download
      const pdfGeneratorFunction = new lambda.DockerImageFunction(this, 'HldPdfGenerator', {
        functionName: `citadel-pdf-generator-${props.environment}`,
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(__dirname, '../../../service/hld_pdf_generator'),
          {
            platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
            exclude: ['__pycache__', '*.pyc', '.env', 'tests', '.git', '*.md'],
          }
        ),
        timeout: cdk.Duration.minutes(5),
        memorySize: 2048,
        description: 'Generates PDF from markdown documents on demand',
        tracing: lambda.Tracing.ACTIVE,
        environment: {
          POWERTOOLS_SERVICE_NAME: 'citadel',
          POWERTOOLS_LOG_LEVEL: 'INFO',
        },
      });

      this.sessionBucket.grantReadWrite(pdfGeneratorFunction);

      // ── Knowledge Base (session documents) ──────────────────────────────────

      const kbCollectionName = `citadel-kb-${props.environment}`;

      const kbEncryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'KbEncryptionPolicy', {
        name: `citadel-kb-enc-${props.environment}`,
        type: 'encryption',
        policy: JSON.stringify({
          Rules: [{ ResourceType: 'collection', Resource: [`collection/${kbCollectionName}`] }],
          AWSOwnedKey: true,
        }),
      });

      const kbNetworkPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'KbNetworkPolicy', {
        name: `citadel-kb-net-${props.environment}`,
        type: 'network',
        policy: JSON.stringify([{
          Rules: [{ ResourceType: 'collection', Resource: [`collection/${kbCollectionName}`] }],
          AllowFromPublic: true,
        }]),
      });

      const kbCollection = new opensearchserverless.CfnCollection(this, 'KbCollection', {
        name: kbCollectionName,
        type: 'VECTORSEARCH',
      });
      kbCollection.addDependency(kbEncryptionPolicy);
      kbCollection.addDependency(kbNetworkPolicy);

      // IAM role for the KB
      const kbRole = new iam.Role(this, 'KbRole', {
        roleName: `citadel-kb-role-${props.environment}`,
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      });
      kbRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['aoss:APIAccessAll'],
        resources: [kbCollection.attrArn],
      }));
      kbRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
      }));
      this.sessionBucket.grantRead(kbRole);
      props.documentBucket.grantRead(kbRole);

      // Lambda role for index creation
      const kbIndexCreatorRole = new iam.Role(this, 'KbIndexCreatorRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      });
      kbIndexCreatorRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['aoss:APIAccessAll'],
        resources: [kbCollection.attrArn],
      }));

      // Data access policy — grants both KB role and index creator Lambda
      const kbDataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'KbDataAccessPolicy', {
        name: `citadel-kb-access-${props.environment}`,
        type: 'data',
        policy: JSON.stringify([{
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${kbCollectionName}`],
              Permission: ['aoss:CreateCollectionItems', 'aoss:DeleteCollectionItems', 'aoss:UpdateCollectionItems', 'aoss:DescribeCollectionItems'],
            },
            {
              ResourceType: 'index',
              Resource: [`index/${kbCollectionName}/*`],
              Permission: ['aoss:CreateIndex', 'aoss:DeleteIndex', 'aoss:UpdateIndex', 'aoss:DescribeIndex', 'aoss:ReadDocument', 'aoss:WriteDocument'],
            },
          ],
          Principal: [kbRole.roleArn, kbIndexCreatorRole.roleArn],
        }]),
      });
      kbDataAccessPolicy.addDependency(kbCollection);

      // Custom Resource Lambda — creates the vector index via signed HTTP to AOSS
      const kbIndexCreatorFn = new lambda.Function(this, 'KbIndexCreatorFn', {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: 'index.handler',
        role: kbIndexCreatorRole,
        timeout: cdk.Duration.minutes(10),
        code: lambda.Code.fromInline(`
import json, urllib3, hashlib, time, boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

INDEX_MAPPING = {
  "settings": {"index": {"knn": True}},
  "mappings": {"properties": {
    "vector":   {"type": "knn_vector", "dimension": 1024, "method": {"name": "hnsw", "space_type": "l2", "engine": "faiss"}},
    "text":     {"type": "text"},
    "metadata": {"type": "text"}
  }}
}

def handler(event, context):
  import cfnresponse
  try:
    if event['RequestType'] == 'Delete':
      cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
      return
    endpoint = event['ResourceProperties']['CollectionEndpoint']
    region   = event['ResourceProperties']['Region']
    session  = boto3.Session()
    creds    = session.get_credentials()
    http     = urllib3.PoolManager()
    body     = json.dumps(INDEX_MAPPING).encode()
    for attempt in range(6):
      try:
        url = f"{endpoint}/session-documents-index"
        req = AWSRequest(method='PUT', url=url, data=body)
        req.headers['Content-Type'] = 'application/json'
        req.headers['x-amz-content-sha256'] = hashlib.sha256(body).hexdigest()
        SigV4Auth(creds, 'aoss', region).add_auth(req)
        r = http.request('PUT', url, headers=dict(req.headers), body=req.body)
        if r.status in [200, 201]: break
        if r.status == 403 and attempt < 5: time.sleep(60); continue
        raise Exception(f"Status {r.status}: {r.data}")
      except Exception as e:
        if attempt < 5: time.sleep(60)
        else: raise
    time.sleep(30)
    cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
  except Exception as e:
    cfnresponse.send(event, context, cfnresponse.FAILED, {'Error': str(e)})
`),
      });

      const kbCreateIndex = new cdk.CustomResource(this, 'KbCreateIndex', {
        serviceToken: kbIndexCreatorFn.functionArn,
        properties: {
          CollectionEndpoint: kbCollection.attrCollectionEndpoint,
          Region: this.region,
        },
      });
      kbCreateIndex.node.addDependency(kbDataAccessPolicy);

      // Bedrock Knowledge Base
      const sessionKb = new bedrock.CfnKnowledgeBase(this, 'SessionKb', {
        name: `citadel-kb-sessions-${props.environment}`,
        description: 'Session documents KB for agent_intake_single',
        roleArn: kbRole.roleArn,
        knowledgeBaseConfiguration: {
          type: 'VECTOR',
          vectorKnowledgeBaseConfiguration: {
            embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          },
        },
        storageConfiguration: {
          type: 'OPENSEARCH_SERVERLESS',
          opensearchServerlessConfiguration: {
            collectionArn: kbCollection.attrArn,
            vectorIndexName: 'session-documents-index',
            fieldMapping: { vectorField: 'vector', textField: 'text', metadataField: 'metadata' },
          },
        },
      });
      sessionKb.node.addDependency(kbCreateIndex);

      // Custom (inline) data source for agent_intake_single ingest_knowledge_base_documents
      const sessionKbDataSource = new bedrock.CfnDataSource(this, 'SessionKbDataSource', {
        knowledgeBaseId: sessionKb.attrKnowledgeBaseId,
        name: 'session-documents-inline',
        dataSourceConfiguration: {
          type: 'CUSTOM',
        },
      });

      // Publish KB ID to SSM for cross-stack consumption (document-upload-resolver)
      new ssm.StringParameter(this, 'KbIdParam', {
        parameterName: `/citadel/knowledge-base-id-${props.environment}`,
        stringValue: sessionKb.attrKnowledgeBaseId,
      });

      // PDF Created Notifier — fires an EventBridge event when a PDF lands in S3
      const pdfCreatedNotifier = new lambda.Function(this, 'HldPdfCreatedNotifierV2', {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'pdf-created-notifier.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          POWERTOOLS_SERVICE_NAME: 'citadel',
          POWERTOOLS_LOG_LEVEL: 'INFO',
        },
        timeout: cdk.Duration.seconds(30),
        tracing: lambda.Tracing.ACTIVE,
      });

      // Grant EventBridge permissions
      props.agentEventBus.grantPutEventsTo(pdfCreatedNotifier);

      // Add S3 event notification for PDF creation
      this.sessionBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(pdfCreatedNotifier),
        { suffix: '/design/high_level_design.pdf' }
      );

      // ── Server-side Document Ingestion (Phase 1) ────────────────────────────
      // Authoritative jobs table tracking each document's ingestion lifecycle.
      // PK projectId / SK documentKey; GSI 'status-index' lets the poller find
      // non-terminal rows by status. On-demand billing + PITR per conventions.
      const ingestionTable = new dynamodb.Table(this, 'DocumentIngestionTable', {
        tableName: `citadel-document-ingestion-${props.environment}`,
        partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'documentKey', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      ingestionTable.addGlobalSecondaryIndex({
        indexName: 'status-index',
        partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      });

      // Publish the table name for cross-stack consumers (the document-upload
      // resolver in BackendStack reads it as source of truth in a later phase).
      new ssm.StringParameter(this, 'DocumentIngestionTableParam', {
        parameterName: `/citadel/document-ingestion-table-${props.environment}`,
        stringValue: ingestionTable.tableName,
      });

      const kbIdParamName = `/citadel/knowledge-base-id-${props.environment}`;
      const dsIdParamName = `/citadel/knowledge-base-datasource-id-${props.environment}`;
      const ssmParamArns = [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${kbIdParamName}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${dsIdParamName}`,
      ];

      // ingest-start: S3 ObjectCreated -> create jobs row + start Bedrock ingestion.
      const ingestStartFunction = new lambda.Function(this, 'DocumentIngestStartFunction', {
        functionName: `citadel-document-ingest-start-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'document-ingestion-start.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          INGESTION_TABLE: ingestionTable.tableName,
          KB_ID_PARAM: kbIdParamName,
          DS_ID_PARAM: dsIdParamName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          DOCUMENT_BUCKET: props.documentBucket.bucketName,
          POWERTOOLS_SERVICE_NAME: 'citadel',
          POWERTOOLS_LOG_LEVEL: 'INFO',
        },
        timeout: cdk.Duration.minutes(2),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
      });

      // ingest-start writes the jobs row...
      ingestionTable.grantWriteData(ingestStartFunction);
      // ...and starts/reads Bedrock ingestion on the session KB (explicitly scoped).
      ingestStartFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:IngestKnowledgeBaseDocuments', 'bedrock:StartIngestionJob', 'bedrock:GetKnowledgeBaseDocuments'],
        resources: [sessionKb.attrKnowledgeBaseArn],
      }));
      ingestStartFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: ssmParamArns,
      }));
      props.documentBucket.grantRead(ingestStartFunction);

      // Cross-stack S3 notification choice:
      // props.documentBucket is owned by BackendStack and ServicesStack already
      // depends on BackendStack. Calling addEventNotification on the concrete
      // (BackendStack-owned) Bucket would make BackendStack reference this
      // stack's Lambda ARN, creating a circular stack dependency. To avoid that
      // we wire the notification through an IMPORTED reference (fromBucketName),
      // which provisions a BucketNotifications custom resource in THIS stack
      // that calls PutBucketNotificationConfiguration at deploy time — no CFN
      // cross-stack cycle. Caveat: the imported-bucket notifier manages the
      // bucket's notification config; this is safe here because DocumentBucket
      // currently has no other event notifications. If notifications are later
      // added in BackendStack, move this wiring there instead.
      // S3 prefix/suffix filters cannot express the design/planning excludes, so
      // we subscribe to all OBJECT_CREATED events and filter in shouldProcessKey.
      const importedDocumentBucket = s3.Bucket.fromBucketName(
        this,
        'ImportedDocumentBucketForIngest',
        props.documentBucket.bucketName,
      );
      importedDocumentBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(ingestStartFunction),
      );

      // poller: scheduled detection of INDEXED/FAILED + exactly-once trigger.
      const ingestPollerFunction = new lambda.Function(this, 'DocumentIngestPollerFunction', {
        functionName: `citadel-document-ingest-poller-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'document-ingestion-poller.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          INGESTION_TABLE: ingestionTable.tableName,
          KB_ID_PARAM: kbIdParamName,
          DS_ID_PARAM: dsIdParamName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          DOCUMENT_BUCKET: props.documentBucket.bucketName,
          MAX_AGE_MS: String(10 * 60 * 1000),
          START_GRACE_MS: String(2 * 60 * 1000),
          ENVIRONMENT: props.environment,
          POWERTOOLS_SERVICE_NAME: 'citadel',
          POWERTOOLS_LOG_LEVEL: 'INFO',
        },
        timeout: cdk.Duration.minutes(2),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
      });

      // poller reads/updates jobs rows (table + GSI), reads Bedrock status,
      // emits trigger/failure events, and publishes a failure metric.
      ingestionTable.grantReadWriteData(ingestPollerFunction);
      ingestPollerFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:IngestKnowledgeBaseDocuments', 'bedrock:StartIngestionJob', 'bedrock:GetKnowledgeBaseDocuments'],
        resources: [sessionKb.attrKnowledgeBaseArn],
      }));
      ingestPollerFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: ssmParamArns,
      }));
      ingestPollerFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'Citadel/DocumentIngestion' } },
      }));
      props.agentEventBus.grantPutEventsTo(ingestPollerFunction);

      // Scheduled poll every minute (resilient to closed tabs/timeouts).
      const ingestPollRule = new events.Rule(this, 'DocumentIngestPollRule', {
        ruleName: `citadel-document-ingest-poll-${props.environment}`,
        description: 'Polls Bedrock ingestion status and fires the assessment trigger exactly once',
        schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      });
      ingestPollRule.addTarget(new targets.LambdaFunction(ingestPollerFunction, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.minutes(5),
      }));

      // --- Health Monitor Lambda (DS-10) ---
      // EventBridge scheduled rule triggers health checks on CONNECTED/ERROR data stores
      const healthMonitorFunction = new lambda.Function(this, 'HealthMonitorFunction', {
        functionName: `citadel-health-monitor-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'health-monitor.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          DATASTORES_TABLE: `citadel-datastores-${props.environment}`,
          HEALTH_CHECK_BATCH_SIZE: '10',
          POWERTOOLS_SERVICE_NAME: 'citadel',
          POWERTOOLS_LOG_LEVEL: 'INFO',
        },
        timeout: cdk.Duration.minutes(5),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
      });

      // Grant DynamoDB read/write on DATASTORES_TABLE
      healthMonitorFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:Scan',
          'dynamodb:GetItem',
          'dynamodb:UpdateItem',
        ],
        resources: [
          `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/citadel-datastores-${props.environment}`,
        ],
      }));

      // Grant Secrets Manager read for credential retrieval
      healthMonitorFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:/citadel/datastores/*`,
        ],
      }));

      // Grant IAM assume role for scoped credentials
      healthMonitorFunction.addToRolePolicy(new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['sts:AssumeRole'],
              resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
            }));
            healthMonitorFunction.addToRolePolicy(new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['sts:GetCallerIdentity'],
              resources: ['*'],
            }));

      // Store health monitor role ARN in SSM so the datastore resolver can add it
      // as a trusted principal on scoped IAM roles (cross-stack reference)
      new ssm.StringParameter(this, 'HealthMonitorRoleParam', {
        parameterName: `/citadel/health-monitor-role-${props.environment}`,
        stringValue: healthMonitorFunction.role!.roleArn,
        description: 'Health monitor Lambda role ARN for scoped IAM trust policies',
      });

      // EventBridge scheduled rule — every 15 minutes (Req 6.1)
      const healthCheckRule = new events.Rule(this, 'HealthCheckScheduleRule', {
        ruleName: `citadel-health-check-${props.environment}`,
        description: 'Triggers data store health checks every 15 minutes',
        schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      });

      healthCheckRule.addTarget(new targets.LambdaFunction(healthMonitorFunction, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.minutes(30),
      }));

      // --- Tool Testing Sandbox Lambda (DS-11) ---
      // Isolated Lambda for executing tools with scoped credentials (Req 7.3, 7.4, 7.5, 7.8, 10.9)
      const toolSandboxFunction = new lambda.Function(this, 'ToolSandboxFunction', {
        functionName: `citadel-tool-sandbox-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'tool-sandbox.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          TOOLS_CONFIG_TABLE: `citadel-tools-config-${props.environment}`,
          TOOLS_BUCKET: `citadel-tools-${props.environment}-${this.account}-${this.region}`,
          POWERTOOLS_SERVICE_NAME: 'citadel',
          POWERTOOLS_LOG_LEVEL: 'INFO',
        },
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        tracing: lambda.Tracing.ACTIVE,
      });

      // Grant DynamoDB read on TOOLS_CONFIG_TABLE
      toolSandboxFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [
          `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/citadel-tools-config-${props.environment}`,
        ],
      }));

      // Grant S3 read on TOOLS_BUCKET
      toolSandboxFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [
          `arn:aws:s3:::citadel-tools-${props.environment}-${this.account}-${this.region}/tools/*`,
        ],
      }));

      // Grant STS assume role for scoped credentials
      toolSandboxFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: ['*'],
      }));

      // Outputs

      new ssm.StringParameter(this, 'KbDataSourceIdParam', {
        parameterName: `/citadel/knowledge-base-datasource-id-${props.environment}`,
        stringValue: sessionKbDataSource.attrDataSourceId,
      });

      new cdk.CfnOutput(this, 'SessionKbId', {
        value: sessionKb.attrKnowledgeBaseId,
        description: 'Session documents Knowledge Base ID',
        exportName: `${this.stackName}-SessionKbId`,
      });

      // Agent Intake Single - Runtime
      const agentIntakeSingleRuntime = new agentcore.Runtime(this, 'AgentIntakeSingleRuntime', {
        runtimeName: `agent_intake_single_${props.environment}`,
        agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(
          path.join(__dirname, '../../../service/agent_intake_single'),
          {
            platform: Platform.LINUX_ARM64,
            exclude: ['__pycache__', '*.pyc', '*.pyo', '.env', '.env.*', 'logs', 'tests', 'tmp', '.git', '*.md'],
          },
        ),
        description: 'Agent Intake Single - Agentification consulting (assessment, design, planning)',
        environmentVariables: {
          AWS_REGION: cdk.Stack.of(this).region,
          SESSION_BUCKET: this.sessionBucket.bucketName,
          SESSION_MEMORY_TABLE: this.sessionMemoryTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          KNOWLEDGE_BASE_ID: sessionKb.attrKnowledgeBaseId,
          INLINE_DATA_SOURCE_ID: sessionKbDataSource.attrDataSourceId,
          FABRICATOR_QUEUE_URL: `https://sqs.${cdk.Stack.of(this).region}.amazonaws.com/${cdk.Stack.of(this).account}/citadel-fabricator-queue-${props.environment}`,
          FABRICATION_JOBS_TABLE: `citadel-fabrication-jobs-${props.environment}`,
          AGENT_CONFIG_TABLE: `citadel-agents-${props.environment}`,
          PROJECTS_TABLE: `citadel-projects-${props.environment}`,
          CONVERSATIONS_TABLE: `citadel-conversations-${props.environment}`,
          MODEL_CONFIG_TABLE: `citadel-model-config-${props.environment}`,
          MODEL_CATALOG_TABLE: `citadel-model-catalog-${props.environment}`,
          // Registry id so the intake catalog (list_factory_agents /
          // plan_fabrication) can read fabricated agents from the AgentCore
          // Registry. Conditionally wired, mirroring the fabricator.
          ...(props.registryId && { REGISTRY_ID: props.registryId }),
          AGENT_MODEL: process.env.AGENT_MODEL || `${crossRegionPrefix(this.region)}.anthropic.claude-sonnet-4-6`,
          EXTRACTION_MODEL: process.env.EXTRACTION_MODEL || `${crossRegionPrefix(this.region)}.anthropic.claude-haiku-4-5-20251001-v1:0`,
          LANGFUSE_SECRET_KEY: '',
          LANGFUSE_PUBLIC_KEY: '',
          LANGFUSE_BASE_URL: '',
        },
      });

      this.sessionBucket.grantReadWrite(agentIntakeSingleRuntime);
      this.sessionMemoryTable.grantReadWriteData(agentIntakeSingleRuntime);
      props.agentEventBus.grantPutEventsTo(agentIntakeSingleRuntime);

      // Grant access to projects and conversations tables for phase tracking
      const projectsTable = dynamodb.Table.fromTableName(this, 'ProjectsTableRef', `citadel-projects-${props.environment}`);
      const conversationsTable = dynamodb.Table.fromTableName(this, 'ConversationsTableRef', `citadel-conversations-${props.environment}`);
      projectsTable.grantReadWriteData(agentIntakeSingleRuntime);
      conversationsTable.grantReadData(agentIntakeSingleRuntime);

      // Grant read-only access to the model config + catalog tables for
      // configurable model selection (falls back to env defaults if absent)
      const modelConfigTable = dynamodb.Table.fromTableName(this, 'ModelConfigTableRef', `citadel-model-config-${props.environment}`);
      const modelCatalogTable = dynamodb.Table.fromTableName(this, 'ModelCatalogTableRef', `citadel-model-catalog-${props.environment}`);
      modelConfigTable.grantReadData(agentIntakeSingleRuntime);
      modelCatalogTable.grantReadData(agentIntakeSingleRuntime);

      new ssm.StringParameter(this, 'IntakeAgentParam', {
        parameterName: `/citadel/agents/agent_intake_single-${props.environment}`,
        stringValue: JSON.stringify({ agentRuntimeArn: agentIntakeSingleRuntime.agentRuntimeArn }),
      });

      agentIntakeSingleRuntime.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }));

      agentIntakeSingleRuntime.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
        resources: [sessionKb.attrKnowledgeBaseArn],
      }));

      agentIntakeSingleRuntime.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [props.agentEventBus.eventBusArn],
      }));

      agentIntakeSingleRuntime.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [`arn:aws:sqs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:citadel-fabricator-queue-${props.environment}`],
      }));

      agentIntakeSingleRuntime.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['aws-marketplace:Subscribe', 'aws-marketplace:Unsubscribe', 'aws-marketplace:ViewSubscriptions'],
        resources: ['*'],
      }));

      agentIntakeSingleRuntime.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [`arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/citadel-agents-${props.environment}`],
      }));

      // PutItem on the durable fabrication-jobs table (owned by BackendStack)
      // so the intake runtime can write a PENDING row per build agent it
      // enqueues. Referenced by deterministic name + constructed ARN — NOT a
      // cross-stack construct import — because importing the BackendStack table
      // here is unnecessary (deterministic name) and keeps wiring uniform with
      // the other writers. Least privilege: PutItem only.
      agentIntakeSingleRuntime.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [`arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/citadel-fabrication-jobs-${props.environment}`],
      }));

      // Least-privilege read access to the AgentCore Registry so the intake
      // runtime can list/get fabricated agent records for the factory catalog
      // (list_factory_agents / plan_fabrication). Mirrors the fabricator's
      // registry grant scope in arbiter-stack.ts (ARN + its /* sub-resources).
      // Conditional on props.registryArn — wired only when a registry exists.
      if (props.registryArn) {
        agentIntakeSingleRuntime.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:ListRegistryRecords',
            'bedrock-agentcore:GetRegistryRecord',
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }));
      }

      // ── Outputs ──────────────────────────────────────────────────────────────

      new cdk.CfnOutput(this, 'GatewayUserPoolId', {
        value: gatewayUserPool.userPoolId,
      });

      new cdk.CfnOutput(this, 'GatewayClientId', {
        value: gatewayClient.userPoolClientId,
      });

      new cdk.CfnOutput(this, 'GatewayTokenUrl', {
        value: `https://${gatewayDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com/oauth2/token`,
      });

      new cdk.CfnOutput(this, 'GatewaySecretArn', {
        value: gatewaySecret.secretArn,
      });

      new cdk.CfnOutput(this, 'GatewayUrl', {
        value: gateway.attrGatewayUrl,
        description: 'AgentCore Gateway URL',
      });

      new cdk.CfnOutput(this, 'GatewayArn', {
        value: gateway.attrGatewayArn,
        description: 'AgentCore Gateway ARN',
      });

      // Extract Gateway ID from ARN (format: arn:aws:bedrock-agentcore:region:account:gateway/GATEWAY_ID)
      const gatewayId = cdk.Fn.select(5, cdk.Fn.split(':', gateway.attrGatewayArn));
      const gatewayIdFinal = cdk.Fn.select(1, cdk.Fn.split('/', gatewayId));

      new cdk.CfnOutput(this, 'GatewayId', {
        value: gatewayIdFinal,
        description: 'AgentCore Gateway ID',
        exportName: `citadel-services-${props.environment}-GatewayId`,
      });

      // SSM parameter for Gateway ID (used by BackendStack Lambda at runtime)
      new ssm.StringParameter(this, 'GatewayIdParam', {
        parameterName: `/citadel/gateway-id-${props.environment}`,
        stringValue: gatewayIdFinal,
      });

      // Export session table and bucket names for BackendStack resolvers
      new ssm.StringParameter(this, 'SessionMemoryTableNameParam', {
        parameterName: `/citadel/session-memory-table-${props.environment}`,
        stringValue: this.sessionMemoryTable.tableName,
      });

      new ssm.StringParameter(this, 'SessionMemoryTableArnParam', {
        parameterName: `/citadel/session-memory-table-arn-${props.environment}`,
        stringValue: this.sessionMemoryTable.tableArn,
      });

      new ssm.StringParameter(this, 'SessionBucketNameParam', {
        parameterName: `/citadel/session-bucket-${props.environment}`,
        stringValue: this.sessionBucket.bucketName,
      });
  }
}

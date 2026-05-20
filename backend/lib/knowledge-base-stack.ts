import * as cdk from 'aws-cdk-lib';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  environment: string;
}

export class KnowledgeBaseStack extends cdk.Stack {
  public readonly complianceKnowledgeBaseId: string;
  public readonly integrationsKnowledgeBaseId: string;
  public readonly fileSourcesKnowledgeBaseId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    // OpenSearch Serverless Collection
    const collectionName = `citadel-kb-${props.environment}`;

    // Security Policy (Encryption)
    const securityPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'SecurityPolicy', {
      name: `citadel-kb-sec-${props.environment}`,
      type: 'encryption',
      policy: JSON.stringify({
        Rules: [
          {
            ResourceType: 'collection',
            Resource: [`collection/${collectionName}`],
          },
        ],
        AWSOwnedKey: true,
      }),
    });

    // Network Policy
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: `citadel-kb-net-${props.environment}`,
      type: 'network',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${collectionName}`],
            },
          ],
          AllowFromPublic: true,
        },
      ]),
    });

    // OpenSearch Serverless Collection
    const collection = new opensearchserverless.CfnCollection(this, 'Collection', {
      name: collectionName,
      type: 'VECTORSEARCH',
      description: 'Citadel Vector collection for Bedrock Knowledge Bases',
    });

    collection.addDependency(securityPolicy);

    // IAM Role for Bedrock Knowledge Base
    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      roleName: `citadel-kb-role-${props.environment}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });

    // Grant specific Bedrock KB permissions instead of AmazonBedrockFullAccess (S-14 fix)
    kbRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:ListFoundationModels',
        'bedrock:GetFoundationModel',
        'bedrock:InvokeModel',
        'bedrock:CreateKnowledgeBase',
        'bedrock:GetKnowledgeBase',
        'bedrock:ListKnowledgeBases',
        'bedrock:AssociateThirdPartyKnowledgeBase',
        'bedrock:CreateDataSource',
        'bedrock:GetDataSource',
        'bedrock:ListDataSources',
        'bedrock:StartIngestionJob',
        'bedrock:GetIngestionJob',
        'bedrock:ListIngestionJobs',
        'bedrock:Retrieve',
        'bedrock:RetrieveAndGenerate',
      ],
      resources: ['*'],
    }));

    // Grant OpenSearch access to KB role
    kbRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['aoss:APIAccessAll'],
      resources: [collection.attrArn],
    }));

    // S3 Bucket for file-based knowledge sources
    const filesBucket = new s3.Bucket(this, 'FilesBucket', {
      bucketName: `citadel-kb-files-${props.environment}-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Grant S3 access to KB role
    filesBucket.grantRead(kbRole);

    // CloudWatch Logs access for KB role
    kbRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/vendedlogs/bedrock/knowledge-base/*`,
      ],
    }));

    // Lambda Role for creating indices
    const createIndicesRole = new iam.Role(this, 'CreateIndicesRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    createIndicesRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['aoss:APIAccessAll'],
      resources: [collection.attrArn],
    }));

    // Access Policy for OpenSearch
    const accessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'AccessPolicy', {
      name: `citadel-kb-access-${props.environment}`,
      type: 'data',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${collectionName}`],
              Permission: ['aoss:*'],
            },
            {
              ResourceType: 'index',
              Resource: ['index/*/*'],
              Permission: ['aoss:*'],
            },
          ],
          Principal: [
            kbRole.roleArn,
            createIndicesRole.roleArn,
            `arn:aws:iam::${this.account}:role/Administrator`,
          ],
        },
      ]),
    });

    accessPolicy.node.addDependency(createIndicesRole);

    // Lambda function to create vector indices
    const createIndicesFunction = new lambda.Function(this, 'CreateIndicesFunction', {
      functionName: `${id}-create-indices`,
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../service/knowledge_base/lambda')),
      timeout: cdk.Duration.minutes(10),
      role: createIndicesRole,
    });

    // Custom Resource to create indices
    const createIndices = new cr.AwsCustomResource(this, 'CreateIndices', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndicesFunction.functionName,
          Payload: JSON.stringify({
            RequestType: 'Create',
            ResourceProperties: {
              CollectionEndpoint: collection.attrCollectionEndpoint,
              Region: this.region,
            },
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('CreateVectorIndices'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [createIndicesFunction.functionArn],
        }),
      ]),
    });

    createIndices.node.addDependency(collection);
    createIndices.node.addDependency(accessPolicy);

    // CloudWatch Log Groups for Knowledge Bases
    new logs.LogGroup(this, 'ComplianceKBLogGroup', {
      logGroupName: `/aws/vendedlogs/bedrock/knowledge-base/compliance-kb-${props.environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'IntegrationsKBLogGroup', {
      logGroupName: `/aws/vendedlogs/bedrock/knowledge-base/integrations-kb-${props.environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new logs.LogGroup(this, 'FileSourcesKBLogGroup', {
      logGroupName: `/aws/vendedlogs/bedrock/knowledge-base/file-sources-kb-${props.environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Bedrock Knowledge Bases
    const complianceKB = new bedrock.CfnKnowledgeBase(this, 'ComplianceKB', {
      name: `compliance-kb-${props.environment}`,
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
          collectionArn: collection.attrArn,
          vectorIndexName: 'web-sources-index',
          fieldMapping: {
            vectorField: 'vector',
            textField: 'text',
            metadataField: 'metadata',
          },
        },
      },
    });

    complianceKB.node.addDependency(createIndices);

    const integrationsKB = new bedrock.CfnKnowledgeBase(this, 'IntegrationsKB', {
      name: `integrations-kb-${props.environment}`,
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
          collectionArn: collection.attrArn,
          vectorIndexName: 'integrations-index',
          fieldMapping: {
            vectorField: 'vector',
            textField: 'text',
            metadataField: 'metadata',
          },
        },
      },
    });

    integrationsKB.node.addDependency(createIndices);

    const fileSourcesKB = new bedrock.CfnKnowledgeBase(this, 'FileSourcesKB', {
      name: `file-sources-kb-${props.environment}`,
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
          collectionArn: collection.attrArn,
          vectorIndexName: 'file-sources-index',
          fieldMapping: {
            vectorField: 'vector',
            textField: 'text',
            metadataField: 'metadata',
          },
        },
      },
    });

    fileSourcesKB.node.addDependency(createIndices);

    // Data Sources
    new bedrock.CfnDataSource(this, 'ComplianceWebDataSource', {
      knowledgeBaseId: complianceKB.attrKnowledgeBaseId,
      name: `compliance-web-source-${props.environment}`,
      dataSourceConfiguration: {
        type: 'WEB',
        webConfiguration: {
          sourceConfiguration: {
            urlConfiguration: {
              seedUrls: [
                { url: 'https://aws.amazon.com/compliance/' },
                { url: 'https://aws.amazon.com/compliance/programs/' },
              ],
            },
          },
          crawlerConfiguration: {
            crawlerLimits: {
              rateLimit: 300,
            },
            scope: 'HOST_ONLY',
          },
        },
      },
    });

    new bedrock.CfnDataSource(this, 'IntegrationsWebDataSource', {
      knowledgeBaseId: integrationsKB.attrKnowledgeBaseId,
      name: `integrations-web-source-${props.environment}`,
      dataSourceConfiguration: {
        type: 'WEB',
        webConfiguration: {
          sourceConfiguration: {
            urlConfiguration: {
              seedUrls: [
                { url: 'https://aws.amazon.com/what-is/api/' },
                { url: 'https://aws.amazon.com/api-gateway/' },
              ],
            },
          },
          crawlerConfiguration: {
            crawlerLimits: {
              rateLimit: 300,
            },
            scope: 'HOST_ONLY',
          },
        },
      },
    });

    new bedrock.CfnDataSource(this, 'FileSourcesS3DataSource', {
      knowledgeBaseId: fileSourcesKB.attrKnowledgeBaseId,
      name: `file-sources-s3-${props.environment}`,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: filesBucket.bucketArn,
        },
      },
    });

    // Store KB IDs for use in other stacks
    this.complianceKnowledgeBaseId = complianceKB.attrKnowledgeBaseId;
    this.integrationsKnowledgeBaseId = integrationsKB.attrKnowledgeBaseId;
    this.fileSourcesKnowledgeBaseId = fileSourcesKB.attrKnowledgeBaseId;

    // Outputs
    new cdk.CfnOutput(this, 'CollectionEndpoint', {
      value: collection.attrCollectionEndpoint,
      description: 'OpenSearch Serverless Collection Endpoint',
    });

    new cdk.CfnOutput(this, 'ComplianceKnowledgeBaseId', {
      value: complianceKB.attrKnowledgeBaseId,
      description: 'Compliance Knowledge Base ID',
    });

    new cdk.CfnOutput(this, 'IntegrationsKnowledgeBaseId', {
      value: integrationsKB.attrKnowledgeBaseId,
      description: 'Integrations Knowledge Base ID',
    });

    new cdk.CfnOutput(this, 'FileSourcesKnowledgeBaseId', {
      value: fileSourcesKB.attrKnowledgeBaseId,
      description: 'File Sources Knowledge Base ID',
    });

    new cdk.CfnOutput(this, 'FilesBucketName', {
      value: filesBucket.bucketName,
      description: 'S3 Bucket for Knowledge Base files',
    });
  }
}

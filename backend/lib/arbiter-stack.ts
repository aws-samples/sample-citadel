import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from "constructs";
import path = require('path');

interface ArbiterStackProps extends cdk.StackProps {
  agentEventBus: events.EventBus;
  agentConfigTable: dynamodb.Table;
  codeBucket: Bucket;
  environment: string;
  workflowsTable?: dynamodb.Table;
  executionsTable?: dynamodb.Table;
  fanoutFunction?: lambda.Function;
  appSyncEndpoint?: string;
  appsTable?: dynamodb.Table;
  registryArn?: string;
  registryId?: string;
}

export class ArbiterStack extends cdk.Stack {
  public readonly orchestrationTable: dynamodb.Table;
  

  constructor(scope: Construct, id: string, props: ArbiterStackProps) {
    super(scope, id, props);

    this.orchestrationTable = new dynamodb.Table(this, 'OrchestrationTable', {
          tableName: `citadel-agent-orchestration-${props.environment}`,
          partitionKey: { name: 'orchestrationId', type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        });

    const workerStateTable = new dynamodb.Table(this, 'WorkerStateTable', {
          tableName: `citadel-worker-state-${props.environment}`,
          partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        });

    const supervisorLambda = new PythonFunction(this, 'SupervisorAgent', {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(__dirname, '../../../arbiter/supervisor'),
      handler: 'handler',
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      environment: {
        ORCHESTRATION_TABLE: this.orchestrationTable.tableName,
        COMPLETION_BUS_NAME: props.agentEventBus.eventBusName,
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        WORKER_STATE_TABLE: workerStateTable.tableName,
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        CODE_VERSION: '2',  // Force Lambda code update
        ...(props.appsTable && { APPS_TABLE: props.appsTable.tableName }),
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
            `arn:aws:bedrock:*::foundation-model/amazon.*`,
            `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          ],
        }),
      ],
    });

    this.orchestrationTable.grantReadWriteData(supervisorLambda);
    props.agentEventBus.grantPutEventsTo(supervisorLambda);
    workerStateTable.grantReadWriteData(supervisorLambda);
    props.agentConfigTable.grantReadData(supervisorLambda);
    if (props.appsTable) {
      props.appsTable.grantReadData(supervisorLambda);
    }

    // SQS permissions are granted below after queue creation (see workerAgentQueue / fabricatorQueue grants)

    const taskRequestRule = new events.Rule(this, 'TaskRequestRule', {
      eventBus: props.agentEventBus,
      eventPattern: {
        source: ['task.request'],
      },
    });

    const completionRule = new events.Rule(this, 'TaskCompletionRule', {
      eventBus: props.agentEventBus,
      eventPattern: {
        source: ['task.completion'],
      },
    });

    taskRequestRule.addTarget(new targets.LambdaFunction(supervisorLambda));
    completionRule.addTarget(new targets.LambdaFunction(supervisorLambda));

    // Dead letter queue for failed worker messages
    const workerAgentDLQ = new Queue(this, `workerAgentDLQ`, {
          queueName: `citadel-worker-agent-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          enforceSSL: true,
        });

    const workerAgentQueue = new Queue(this, `workerAgentQueue`, {
          queueName: `citadel-worker-agent-queue-${props.environment}`,
          visibilityTimeout: cdk.Duration.minutes(15),
          retentionPeriod: cdk.Duration.days(7),
          enforceSSL: true,
          deadLetterQueue: {
            queue: workerAgentDLQ,
            maxReceiveCount: 3, // Retry 3 times before sending to DLQ
          },
        });

    // Agent Credential Vender — lightweight TypeScript Lambda that
    // creates scoped IAM roles and returns temporary credentials
    const credentialVenderLambda = new lambda.Function(this, 'AgentCredentialVender', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'agent-credential-vender.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ENVIRONMENT: props.environment,
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'iam:CreateRole',
            'iam:DeleteRole',
            'iam:GetRole',
            'iam:PutRolePolicy',
            'iam:DeleteRolePolicy',
            'iam:TagRole',
          ],
          resources: [
            `arn:aws:iam::${this.account}:role/citadel-agent-*`,
          ],
        }),
        new PolicyStatement({
                  effect: Effect.ALLOW,
                  actions: ['sts:AssumeRole'],
                  resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
                }),
                new PolicyStatement({
                  effect: Effect.ALLOW,
                  actions: ['sts:GetCallerIdentity'],
                  resources: ['*'],
                }),
      ],
    });

    const workerAgentWrapperLambda = new PythonFunction(this, 'WorkerAgentWrapper', {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(__dirname, '../../../arbiter/workerWrapper'),
      handler: 'lambda_handler',
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        COMPLETION_BUS_NAME: props.agentEventBus.eventBusName,
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        AGENT_BUCKET_NAME: props.codeBucket.bucketName,
        CREDENTIAL_VENDER_FUNCTION: credentialVenderLambda.functionName,
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: ['*'],
        }),
      ],
    });

    props.agentEventBus.grantPutEventsTo(workerAgentWrapperLambda);
    props.agentConfigTable.grantReadData(workerAgentWrapperLambda);
    props.codeBucket.grantRead(workerAgentWrapperLambda);
    credentialVenderLambda.grantInvoke(workerAgentWrapperLambda);

    // Grant IAM permissions for PolicyManager (agent scope)
    workerAgentWrapperLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:GetRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:TagRole',
        ],
        resources: [
          `arn:aws:iam::${this.account}:role/citadel-agent-*`,
        ],
      })
    );

    // Grant STS permissions for PolicyManager (agent scope)
    workerAgentWrapperLambda.addToRolePolicy(
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
          })
        );
        workerAgentWrapperLambda.addToRolePolicy(
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['sts:GetCallerIdentity'],
            resources: ['*'],
          })
        );

    workerAgentWrapperLambda.addEventSource(new SqsEventSource(workerAgentQueue, {
      batchSize: 1, // Process one message at a time
      reportBatchItemFailures: true, // Enable partial batch responses
    }));
    
    const toolsConfigTable = new dynamodb.Table(this, 'ToolsConfigTable', {
          tableName: `citadel-tools-${props.environment}`,
          partitionKey: { name: 'toolId', type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        });
    
    const fabricatorDLQ = new Queue(this, `fabricatorDLQ`, {
          queueName: `citadel-fabricator-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          enforceSSL: true,
        });
    
        const fabricatorQueue = new Queue(this, `fabricatorQueue`, {
          queueName: `citadel-fabricator-queue-${props.environment}`,
          visibilityTimeout: cdk.Duration.minutes(15),
          retentionPeriod: cdk.Duration.days(7),
          enforceSSL: true,
          deadLetterQueue: {
            queue: fabricatorDLQ,
            maxReceiveCount: 3,
          },
        });

    const fabricatorLambda = new PythonFunction(this, 'FabricatorAgent', {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(__dirname, '../../../arbiter/fabricator'),
      handler: 'lambda_handler',
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        COMPLETION_BUS_NAME: props.agentEventBus.eventBusName,
        WORKFLOW_STATE_TABLE: workerStateTable.tableName,
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        TOOL_CONFIG_TABLE: toolsConfigTable.tableName,
        AGENT_BUCKET_NAME: props.codeBucket.bucketName,
        WORKER_QUEUE_URL: workerAgentQueue.queueUrl,
        CODE_VERSION: '2',  // Force Lambda code update
        ...(props.registryId && { REGISTRY_ID: props.registryId }),
        ...(props.registryId && { REGISTRY_ENABLED: 'true' }),
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
            `arn:aws:bedrock:*::foundation-model/amazon.*`,
            `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          ],
        }),
      ],
    });

    props.agentEventBus.grantPutEventsTo(fabricatorLambda);
    workerStateTable.grantReadWriteData(fabricatorLambda);
    props.agentConfigTable.grantReadWriteData(fabricatorLambda);
    toolsConfigTable.grantReadWriteData(fabricatorLambda);
    props.codeBucket.grantReadWrite(fabricatorLambda);

    // Grant Fabricator permission to call Registry APIs
    if (props.registryArn) {
      fabricatorLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'bedrock-agentcore:CreateRegistryRecord',
            'bedrock-agentcore:UpdateRegistryRecord',
            'bedrock-agentcore:UpdateRegistryRecordStatus',
            'bedrock-agentcore:DeleteRegistryRecord',
            'bedrock-agentcore:GetRegistryRecord',
            'bedrock-agentcore:ListRegistryRecords',
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }),
      );
    }

    fabricatorLambda.addEventSource(new SqsEventSource(fabricatorQueue));

    // Grant scoped SQS permissions to Supervisor (S-02 fix)
    supervisorLambda.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage'],
      resources: [workerAgentQueue.queueArn, fabricatorQueue.queueArn],
    }));

    // Seed initial agent configuration
    const seedAgentConfigLambda = new lambda.Function(this, 'SeedAgentConfigFunction', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../arbiter/seedConfig')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        WORKER_QUEUE_URL: workerAgentQueue.queueUrl,
        FABRICATOR_QUEUE_URL: fabricatorQueue.queueUrl,
      },
    });

    props.agentConfigTable.grantWriteData(seedAgentConfigLambda);

    // Invoke the Custom Resource to seed agent config table
    // This must come after fabricatorQueue is created since we pass its URL
    const seedAgentConfigResource = new cdk.CustomResource(this, 'SeedAgentConfigResource', {
      serviceToken: seedAgentConfigLambda.functionArn,
      properties: {
        // O-05: Use content hash instead of Date.now() to avoid unnecessary re-runs
        Version: 'v1.0.0',
      },
    });

    // Ensure the Custom Resource runs after the table and queue are created
    seedAgentConfigResource.node.addDependency(props.agentConfigTable);
    seedAgentConfigResource.node.addDependency(fabricatorQueue);

    // --- Step Runner Lambda (Task 1.6) ---
    if (props.workflowsTable && props.executionsTable && props.appSyncEndpoint) {
      const stepRunnerFunction = new lambda.Function(this, 'StepRunnerFunction', {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, '../../../arbiter/stepRunner')),
        timeout: cdk.Duration.minutes(5),
        memorySize: 1024,
        environment: {
          EXECUTIONS_TABLE: props.executionsTable.tableName,
          WORKFLOWS_TABLE: props.workflowsTable.tableName,
          AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
          TOOLS_CONFIG_TABLE: toolsConfigTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          APPSYNC_ENDPOINT: props.appSyncEndpoint,
        },
      });

      // Least-privilege IAM per design 8.2
      props.executionsTable.grantReadWriteData(stepRunnerFunction);
      props.workflowsTable.grantReadData(stepRunnerFunction);
      props.agentConfigTable.grantReadData(stepRunnerFunction);
      toolsConfigTable.grantReadData(stepRunnerFunction);
      props.agentEventBus.grantPutEventsTo(stepRunnerFunction);

      // EventBridge rules targeting StepRunner
      const stepRunnerStartRule = new events.Rule(this, 'StepRunnerStartRule', {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ['execution.start.requested'],
        },
      });
      stepRunnerStartRule.addTarget(new targets.LambdaFunction(stepRunnerFunction));

      const stepRunnerNodeCompletedRule = new events.Rule(this, 'StepRunnerNodeCompletedRule', {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ['workflow.node.completed'],
        },
      });
      stepRunnerNodeCompletedRule.addTarget(new targets.LambdaFunction(stepRunnerFunction));

      const stepRunnerNodeFailedRule = new events.Rule(this, 'StepRunnerNodeFailedRule', {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ['workflow.node.failed'],
        },
      });
      stepRunnerNodeFailedRule.addTarget(new targets.LambdaFunction(stepRunnerFunction));

      const stepRunnerCancelRule = new events.Rule(this, 'StepRunnerCancelRule', {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ['execution.cancel.requested'],
        },
      });
      stepRunnerCancelRule.addTarget(new targets.LambdaFunction(stepRunnerFunction));

      // WorkflowProgressFanoutRule — matches workflow.* events → FanoutFunction
      if (props.fanoutFunction) {
        const workflowProgressFanoutRule = new events.Rule(this, 'WorkflowProgressFanoutRule', {
          eventBus: props.agentEventBus,
          eventPattern: {
            source: ['citadel.workflows'],
            detailType: [
              'workflow.started',
              'workflow.node.started',
              'workflow.node.completed',
              'workflow.node.failed',
              'workflow.node.retrying',
              'workflow.completed',
              'workflow.failed',
            ],
          },
        });
        workflowProgressFanoutRule.addTarget(new targets.LambdaFunction(props.fanoutFunction));
      }
    }

    // O-03: Enable X-Ray active tracing on all Lambda functions
    // O-02: Add Powertools structured logging env vars
    this.node.findAll().forEach((child) => {
      if (child instanceof lambda.Function || child instanceof PythonFunction) {
        const fn = child as lambda.Function;
        fn.addEnvironment('POWERTOOLS_LOG_LEVEL', 'INFO');
        fn.addEnvironment('POWERTOOLS_SERVICE_NAME', 'citadel');
        const cfnFunction = fn.node.defaultChild as lambda.CfnFunction;
        if (cfnFunction && !cfnFunction.tracingConfig) {
          cfnFunction.addPropertyOverride('TracingConfig', { Mode: 'Active' });
        }
      }
    });

    // O-01: CloudWatch alarms for DLQ depth and critical Lambda errors
    new cloudwatch.Alarm(this, 'WorkerDLQDepthAlarm', {
      alarmName: `citadel-worker-dlq-depth-${props.environment}`,
      metric: workerAgentDLQ.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Worker agent DLQ has messages — indicates failed processing',
    });

    new cloudwatch.Alarm(this, 'SupervisorErrorAlarm', {
      alarmName: `citadel-supervisor-errors-${props.environment}`,
      metric: supervisorLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Supervisor Lambda error rate exceeded threshold',
    });

    new cloudwatch.Alarm(this, 'FabricatorErrorAlarm', {
      alarmName: `citadel-fabricator-errors-${props.environment}`,
      metric: fabricatorLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Fabricator Lambda error rate exceeded threshold',
    });

  }
}
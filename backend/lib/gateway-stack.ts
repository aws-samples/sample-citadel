import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface GatewayStackProps extends cdk.StackProps {
  environment: string;
  appsTable: dynamodb.ITable;
  eventBus: events.IEventBus;
  idempotencyTable: dynamodb.ITable;
}

export class GatewayStack extends cdk.Stack {
  public readonly authorizerFunction: lambda.Function;
  public readonly publishHandler: lambda.Function;
  public readonly metricsHandler: lambda.Function;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // Shared Lambda authorizer (one per environment, used by all per-app APIs)
    this.authorizerFunction = new lambda.Function(this, 'AppApiAuthorizer', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'app-api-authorizer.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        APPS_TABLE: props.appsTable.tableName,
      },
      timeout: cdk.Duration.seconds(10),
      logGroup: new logs.LogGroup(this, 'AppApiAuthorizerLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // IAM role for API Gateway → EventBridge integration (per-app APIs use this to put events)
    const apiGwEventBridgeRole = new iam.Role(this, 'ApiGwEventBridgeRole', {
      roleName: `citadel-apigw-eb-${props.environment}`,
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    props.eventBus.grantPutEventsTo(apiGwEventBridgeRole);

    // Publish handler — orchestrates API Gateway provisioning
    this.publishHandler = new lambda.Function(this, 'AppPublishHandler', {
      functionName: `citadel-app-publish-handler-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'app-publish-handler.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        APPS_TABLE: props.appsTable.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        ENVIRONMENT: props.environment,
        AUTHORIZER_FUNCTION_ARN: this.authorizerFunction.functionArn,
        IDEMPOTENCY_TABLE: props.idempotencyTable.tableName,
        APIGW_EVENTBRIDGE_ROLE_ARN: apiGwEventBridgeRole.roleArn,
      },
      timeout: cdk.Duration.seconds(120),
      logGroup: new logs.LogGroup(this, 'AppPublishHandlerLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Metrics handler — aggregates API Gateway access logs
    this.metricsHandler = new lambda.Function(this, 'AppMetricsHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'app-metrics-handler.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        APPS_TABLE: props.appsTable.tableName,
      },
      timeout: cdk.Duration.seconds(60),
      logGroup: new logs.LogGroup(this, 'AppMetricsHandlerLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // --- DynamoDB Permissions ---
    // appsTable read/write to all three Lambdas
    props.appsTable.grantReadWriteData(this.authorizerFunction);
    props.appsTable.grantReadWriteData(this.publishHandler);
    props.appsTable.grantReadWriteData(this.metricsHandler);

    // eventBus put events to publish handler
    props.eventBus.grantPutEventsTo(this.publishHandler);

    // idempotencyTable read/write to publish handler
    props.idempotencyTable.grantReadWriteData(this.publishHandler);

    // --- Publish Handler: API Gateway management permissions ---
    this.publishHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'apigateway:POST',
        'apigateway:GET',
        'apigateway:DELETE',
        'apigateway:PUT',
        'apigateway:PATCH',
      ],
      resources: ['arn:aws:apigateway:*::/apis*'],
    }));

    // --- Publish Handler: IAM role management for scoped agent roles ---
    this.publishHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:CreateRole',
        'iam:DeleteRole',
        'iam:PutRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:TagRole',
        'iam:GetRole',
        'iam:PassRole',
      ],
      resources: [
        `arn:aws:iam::${this.account}:role/citadel-agent-*`,
        apiGwEventBridgeRole.roleArn,
      ],
    }));

    // --- Publish Handler: STS permissions ---
    this.publishHandler.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
        }));
        this.publishHandler.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['sts:GetCallerIdentity'],
          resources: ['*'],
        }));

    // --- Publish Handler: CloudWatch Logs permissions for API Gateway access logging ---
    this.publishHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:DescribeLogGroups',
        'logs:DeleteLogGroup',
        'logs:PutRetentionPolicy',
        'logs:CreateLogDelivery',
        'logs:GetLogDelivery',
        'logs:UpdateLogDelivery',
        'logs:DeleteLogDelivery',
        'logs:ListLogDeliveries',
        'logs:PutResourcePolicy',
        'logs:DescribeResourcePolicies',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
    }));
    // DescribeLogGroups and log delivery APIs require wildcard resource
    this.publishHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:DescribeLogGroups',
        'logs:CreateLogDelivery',
        'logs:GetLogDelivery',
        'logs:UpdateLogDelivery',
        'logs:DeleteLogDelivery',
        'logs:ListLogDeliveries',
        'logs:PutResourcePolicy',
        'logs:DescribeResourcePolicies',
      ],
      resources: ['*'],
    }));

    // --- Publish Handler: Lambda permissions for authorizer configuration ---
    this.publishHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:AddPermission', 'lambda:RemovePermission'],
      resources: [this.authorizerFunction.functionArn],
    }));

    // --- SSM Parameter: Export authorizer function ARN for per-app API Gateway configuration ---
    new ssm.StringParameter(this, 'AuthorizerFunctionArnParam', {
      parameterName: `/citadel/authorizer-arn-${props.environment}`,
      stringValue: this.authorizerFunction.functionArn,
      description: 'Shared Lambda authorizer ARN for per-app API Gateways',
    });
  }
}

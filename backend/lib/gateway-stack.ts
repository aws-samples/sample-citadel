import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export interface GatewayStackProps extends cdk.StackProps {
  environment: string;
  appsTable: dynamodb.ITable;
  eventBus: events.IEventBus;
  idempotencyTable: dynamodb.ITable;
  /**
   * AgentCore Registry id/ARN, threaded from BackendStack.registryId /
   * BackendStack.registryArn (mirrors the arbiter-stack.ts registryId/
   * registryArn props). Required for the publish handler's owner gate
   * (finding 13a58234) — it reads (never writes) the app's Registry
   * manifest via RegistryService before any provisioning/teardown.
   */
  registryId: string;
  registryArn: string;
}

export class GatewayStack extends cdk.Stack {
  public readonly authorizerFunction: lambda.Function;
  public readonly publishHandler: lambda.Function;
  public readonly metricsHandler: lambda.Function;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // Shared Lambda authorizer (one per environment, used by all per-app APIs)
    this.authorizerFunction = new lambda.Function(this, "AppApiAuthorizer", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "app-api-authorizer.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      environment: {
        APPS_TABLE: props.appsTable.tableName,
        ENVIRONMENT: props.environment,
      },
      timeout: cdk.Duration.seconds(10),
      logGroup: new logs.LogGroup(this, "AppApiAuthorizerLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // API key HMAC pepper (getApiKeyPepper in api-key-hash.ts): the
    // authorizer verifies incoming keys against the HMAC digest, so it needs
    // read access to the SecureString pepper. Mirrors the governance-flag
    // ssm:GetParameter grant pattern in backend-stack.ts (~lines 1452-1463),
    // plus kms:Decrypt since this parameter is a SecureString encrypted with
    // the AWS-managed SSM key (no dedicated CMK exists for this parameter).
    this.authorizerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/${props.environment}/app-api-key-pepper`,
        ],
      }),
    );
    this.authorizerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: [`arn:aws:kms:${this.region}:${this.account}:alias/aws/ssm`],
      }),
    );

    // IAM role for API Gateway → EventBridge integration (per-app APIs use this to put events)
    const apiGwEventBridgeRole = new iam.Role(this, "ApiGwEventBridgeRole", {
      roleName: `citadel-apigw-eb-${props.environment}`,
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });
    props.eventBus.grantPutEventsTo(apiGwEventBridgeRole);

    // Publish handler — orchestrates API Gateway provisioning
    this.publishHandler = new lambda.Function(this, "AppPublishHandler", {
      functionName: `citadel-app-publish-handler-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "app-publish-handler.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      environment: {
        APPS_TABLE: props.appsTable.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        ENVIRONMENT: props.environment,
        AUTHORIZER_FUNCTION_ARN: this.authorizerFunction.functionArn,
        IDEMPOTENCY_TABLE: props.idempotencyTable.tableName,
        APIGW_EVENTBRIDGE_ROLE_ARN: apiGwEventBridgeRole.roleArn,
        // Owner gate (finding 13a58234): the handler fetches the app's
        // Registry manifest via RegistryService before any
        // provisioning/teardown, gated at requiredRole='owner' via the
        // shared assertManifestAccess (registry-agent-record-resolver.ts).
        REGISTRY_ID: props.registryId,
      },
      timeout: cdk.Duration.seconds(120),
      logGroup: new logs.LogGroup(this, "AppPublishHandlerLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Metrics handler — aggregates API Gateway access logs
    this.metricsHandler = new lambda.Function(this, "AppMetricsHandler", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "app-metrics-handler.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      environment: {
        APPS_TABLE: props.appsTable.tableName,
      },
      timeout: cdk.Duration.seconds(60),
      logGroup: new logs.LogGroup(this, "AppMetricsHandlerLogs", {
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
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "apigateway:POST",
          "apigateway:GET",
          "apigateway:DELETE",
          "apigateway:PUT",
          "apigateway:PATCH",
        ],
        resources: ["arn:aws:apigateway:*::/apis*"],
      }),
    );

    // --- Publish Handler: IAM role management for scoped agent roles ---
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:TagRole",
          "iam:GetRole",
          "iam:PassRole",
        ],
        resources: [
          `arn:aws:iam::${this.account}:role/citadel-agent-*`,
          apiGwEventBridgeRole.roleArn,
        ],
      }),
    );

    // --- Publish Handler: STS permissions ---
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
      }),
    );
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:GetCallerIdentity"],
        resources: ["*"],
      }),
    );

    // --- Publish Handler: CloudWatch Logs permissions for API Gateway access logging ---
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:DescribeLogGroups",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
        ],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
      }),
    );
    // DescribeLogGroups and log delivery APIs require wildcard resource
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:DescribeLogGroups",
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
        ],
        resources: ["*"],
      }),
    );

    // --- Publish Handler: API key HMAC pepper (hashApiKey in api-key-hash.ts) ---
    // The publish handler hashes newly issued/rotated keys at publish time, so
    // it needs the same SecureString read + KMS decrypt as the authorizer.
    // Mirrors the governance-flag ssm:GetParameter grant pattern in
    // backend-stack.ts (~lines 1452-1463).
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/${props.environment}/app-api-key-pepper`,
        ],
      }),
    );
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: [`arn:aws:kms:${this.region}:${this.account}:alias/aws/ssm`],
      }),
    );

    // --- Publish Handler: Lambda permissions for authorizer configuration ---
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:AddPermission", "lambda:RemovePermission"],
        resources: [this.authorizerFunction.functionArn],
      }),
    );

    // --- Publish Handler: Registry read grant (finding 13a58234) ---
    // Least-privilege READ-ONLY: the owner gate calls
    // RegistryService.getResource('agent', appId) to fetch the app's
    // manifest before any provisioning/teardown. GetRegistryRecord only —
    // no ListRegistryRecords/write actions, since this handler never lists
    // or mutates Registry records. Mirrors the props.registryArn grant
    // pattern in arbiter-stack.ts (supervisor/worker/fabricator Lambdas).
    this.publishHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock-agentcore:GetRegistryRecord"],
        resources: [props.registryArn, `${props.registryArn}/*`],
      }),
    );

    // --- SSM Parameter: Export authorizer function ARN for per-app API Gateway configuration ---
    new ssm.StringParameter(this, "AuthorizerFunctionArnParam", {
      parameterName: `/citadel/authorizer-arn-${props.environment}`,
      stringValue: this.authorizerFunction.functionArn,
      description: "Shared Lambda authorizer ARN for per-app API Gateways",
    });
  }
}

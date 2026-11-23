import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as fs from "fs";
import * as path from "path";
import { Construct } from "constructs";
import {
  PYTHON_RUNTIME,
  LAMBDA_ARCHITECTURE,
  resolveBackendSrcDir,
} from "./runtime-constants";

const BACKEND_SRC = resolveBackendSrcDir(__dirname);

interface FrontendStackProps extends cdk.StackProps {
  appSyncApi: appsync.GraphqlApi;
  userPool: cognito.UserPool;
  agentEventBus: events.EventBus;
  environment: string;
  /** Cost query HttpApi endpoint from TelemetryStack (pass 2) — rides the existing aws-exports.json deployment as `aws_cost_api_url`. */
  costApiUrl: string;
}

export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // S3 bucket for frontend hosting
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      bucketName: `citadel-frontend-s3-logs-${props.environment}-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });

    this.bucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `citadel-frontend-${props.environment}-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "frontend/",
    });

    // Create OAI
    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    this.bucket.grantRead(oai);

    // WAF WebACL for CloudFront (S-16 fix)
    // CloudFront-scoped WAF WebACLs can only be created in us-east-1
    let webAclArn: string | undefined;
    if (this.region === "us-east-1") {
      const webAcl = new wafv2.CfnWebACL(this, "CloudFrontWebAcl", {
        defaultAction: { allow: {} },
        scope: "CLOUDFRONT",
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: "CitadelWebAcl",
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: "AWSManagedRulesCommonRuleSet",
            priority: 1,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: "AWS",
                name: "AWSManagedRulesCommonRuleSet",
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: "CommonRuleSet",
              sampledRequestsEnabled: true,
            },
          },
          {
            name: "RateLimitRule",
            priority: 2,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: 2000,
                aggregateKeyType: "IP",
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: "RateLimitRule",
              sampledRequestsEnabled: true,
            },
          },
        ],
      });
      webAclArn = webAcl.attrArn;
    }

    // CloudFront distribution using L1 construct
    const cloudFrontLogsBucket = new s3.Bucket(this, "CloudFrontLogsBucket", {
      bucketName: `citadel-cf-logs-${props.environment}-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // CloudFront log delivery requires BucketOwnerPreferred ACL (it writes as awslogsdelivery canonical ID).
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });

    // Security response headers policy (finding 82997842): the SPA holds
    // Cognito tokens, so every response from the distribution must carry
    // HSTS, X-Content-Type-Options, X-Frame-Options and Referrer-Policy.
    //
    // Finding 68019420 (PR #598 follow-up): adds a Content-Security-Policy
    // as REPORT-ONLY first (Content-Security-Policy-Report-Only custom
    // header, not the enforcing header), built entirely from stack values —
    // no hard-coded account id, API id, or region literal. Origin
    // inventory and evidence live in the file header comment of
    // backend/test/frontend-stack-security-headers.test.ts; summary:
    //   - connect-src: 'self' (same-origin fetches, e.g. /aws-exports.json)
    //     plus the AppSync GraphQL host and its paired realtime host
    //     (Amplify talks to AppSync directly from the browser — the SPA
    //     never proxies through this distribution), the Cognito IDP host
    //     (aws-amplify/auth calls cognito-idp directly for sign-in/session),
    //     and the cost/trace/replay-metadata API host (costApiUrl).
    //   - execute-api (published Agent App endpoints) is deliberately
    //     OMITTED: the UI only displays/copies endpointUrl to the
    //     clipboard, no browser fetch/XHR targets it.
    //   - style-src needs 'unsafe-inline' (Tailwind/Radix inline `style={{}}`
    //     usage across ~25 files) plus the Google Fonts stylesheet host.
    //   - font-src needs the Google Fonts asset host.
    //   - img-src needs 'data:' for inline base64 SVG backgrounds.
    //   - script-src does NOT get 'unsafe-inline' — index.html has no
    //     inline scripts, only the bundled module entrypoint.
    //   - frame-ancestors 'none' / object-src 'none' / base-uri 'self' are
    //     unconditional hardening with no functional cost (no iframes,
    //     confirmed by PR #598's FrameOptions: DENY).
    //
    // Promotion path: this ships as Content-Security-Policy-Report-Only so
    // violations are observed (browser console + any configured
    // report-uri/report-to collector) for at least one full deploy cycle
    // before anything is blocked. Once a deploy shows zero unexpected
    // violation reports, promote by renaming the header below from
    // "Content-Security-Policy-Report-Only" to "Content-Security-Policy".
    const appSyncGraphqlHost = cdk.Fn.select(
      2,
      cdk.Fn.split("/", props.appSyncApi.graphqlUrl),
    );
    // AppSync's realtime (wss) endpoint is the same host with the
    // "appsync-api" segment swapped for "appsync-realtime-api" — Amplify
    // derives this internally. CloudFormation has no string-replace
    // intrinsic, so this is split-on-the-literal then re-joined with the
    // replacement (the standard CFN "replace" idiom).
    const appSyncRealtimeHost = cdk.Fn.join("appsync-realtime-api", [
      cdk.Fn.select(0, cdk.Fn.split("appsync-api", appSyncGraphqlHost)),
      cdk.Fn.select(1, cdk.Fn.split("appsync-api", appSyncGraphqlHost)),
    ]);
    const costApiHost = cdk.Fn.select(2, cdk.Fn.split("/", props.costApiUrl));
    const cognitoIdpHost = `cognito-idp.${this.region}.amazonaws.com`;

    const contentSecurityPolicyReportOnly = cdk.Fn.join("", [
      "default-src 'self'; ",
      "frame-ancestors 'none'; ",
      "object-src 'none'; ",
      "base-uri 'self'; ",
      "img-src 'self' data:; ",
      "font-src 'self' https://fonts.gstatic.com; ",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ",
      "script-src 'self'; ",
      "connect-src 'self' https://",
      appSyncGraphqlHost,
      " wss://",
      appSyncRealtimeHost,
      ` https://${cognitoIdpHost} https://`,
      costApiHost,
      ";",
    ]);

    const securityResponseHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityResponseHeaders",
      {
        comment: "Baseline security headers for the Citadel SPA",
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          // No <iframe> usage anywhere in frontend/src, so the SPA never
          // needs to be framed (not even same-origin) — DENY is the
          // strictest option and carries no functional cost here.
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Content-Security-Policy-Report-Only",
              value: contentSecurityPolicyReportOnly,
              override: true,
            },
          ],
        },
      },
    );

    const cfnDistribution = new cloudfront.CfnDistribution(
      this,
      "FrontendDistribution",
      {
        distributionConfig: {
          enabled: true,
          defaultRootObject: "index.html",
          priceClass: "PriceClass_100",
          comment: "Citadel Frontend Distribution",
          logging: {
            bucket: cloudFrontLogsBucket.bucketRegionalDomainName,
            prefix: "cloudfront/",
            includeCookies: false,
          },
          viewerCertificate: {
            cloudFrontDefaultCertificate: true,
            minimumProtocolVersion: "TLSv1.2_2021",
          },
          webAclId: webAclArn,
          origins: [
            {
              id: "s3-origin",
              domainName: this.bucket.bucketRegionalDomainName,
              s3OriginConfig: {
                originAccessIdentity: `origin-access-identity/cloudfront/${oai.originAccessIdentityId}`,
              },
            },
          ],
          defaultCacheBehavior: {
            targetOriginId: "s3-origin",
            viewerProtocolPolicy: "redirect-to-https",
            allowedMethods: ["GET", "HEAD", "OPTIONS"],
            cachedMethods: ["GET", "HEAD", "OPTIONS"],
            compress: true,
            cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", // CachingOptimized
            responseHeadersPolicyId:
              securityResponseHeaders.responseHeadersPolicyId,
          },
          // Finding 68019420: the /api/* behaviour + appsync-origin were
          // unused — the SPA calls AppSync directly from the browser via
          // Amplify (frontend/src/services/server.ts), never through this
          // distribution — removed along with the now-unreferenced origin.
          customErrorResponses: [
            {
              errorCode: 404,
              responseCode: 200,
              responsePagePath: "/index.html",
              errorCachingMinTtl: 1800,
            },
            {
              errorCode: 403,
              responseCode: 200,
              responsePagePath: "/index.html",
              errorCachingMinTtl: 1800,
            },
          ],
        },
      },
    );

    this.distribution = cloudfront.Distribution.fromDistributionAttributes(
      this,
      "Distribution",
      {
        distributionId: cfnDistribution.ref,
        domainName: cfnDistribution.attrDomainName,
      },
    ) as cloudfront.Distribution;

    // Configure Cognito email templates with CloudFront URL using Custom Resource
    const hostUrl =
      process.env.HOST_URL || `https://${cfnDistribution.attrDomainName}`;

    const verificationEmailTemplate = fs
      .readFileSync(
        path.join(
          BACKEND_SRC,
          "cognito-email-templates/verification-email.html",
        ),
        "utf-8",
      )
      .replace(/https:\/\/your-domain\.com/g, hostUrl);

    const invitationEmailTemplate = fs
      .readFileSync(
        path.join(BACKEND_SRC, "cognito-email-templates/invitation-email.html"),
        "utf-8",
      )
      .replace(/https:\/\/your-domain\.com/g, hostUrl);

    const passwordResetEmailTemplate = fs
      .readFileSync(
        path.join(
          BACKEND_SRC,
          "cognito-email-templates/password-reset-email.html",
        ),
        "utf-8",
      )
      .replace(/https:\/\/your-domain\.com/g, hostUrl);

    // Create a Lambda function to update Cognito email templates
    const updateEmailTemplatesFunction = new cdk.aws_lambda.Function(
      this,
      "UpdateEmailTemplatesFunction",
      {
        runtime: PYTHON_RUNTIME,
        architecture: LAMBDA_ARCHITECTURE,
        handler: "index.handler",
        code: cdk.aws_lambda.Code.fromAsset(
          path.join(BACKEND_SRC, "lambda/update-email-templates"),
        ),
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "UpdateEmailTemplatesFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        tracing: cdk.aws_lambda.Tracing.ACTIVE, // O-03
        environment: {
          POWERTOOLS_SERVICE_NAME: "citadel", // O-02
          POWERTOOLS_LOG_LEVEL: "INFO",
        },
      },
    );

    // Grant permissions to update Cognito User Pool
    updateEmailTemplatesFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:UpdateUserPool", "cognito-idp:DescribeUserPool"],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // Create Custom Resource to trigger the Lambda
    const emailTemplatesCustomResource = new cdk.CustomResource(
      this,
      "EmailTemplatesCustomResource",
      {
        serviceToken: updateEmailTemplatesFunction.functionArn,
        properties: {
          UserPoolId: props.userPool.userPoolId,
          VerificationTemplate: verificationEmailTemplate,
          InvitationTemplate: invitationEmailTemplate,
          PasswordResetTemplate: passwordResetEmailTemplate,
          // Trigger update when CloudFront URL changes
          CloudFrontUrl: hostUrl,
          // O-05: Use version string instead of Date.now() to avoid unnecessary re-runs
          Version: "v1.1.0",
        },
      },
    );

    // Ensure this runs after the distribution is created
    emailTemplatesCustomResource.node.addDependency(cfnDistribution);

    // Output CloudFront URL for reference
    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: hostUrl,
      description: "CloudFront Distribution URL used in email templates",
    });

    // Create a configuration file for the frontend
    const frontendConfig = {
      aws_project_region: this.region,
      aws_appsync_graphqlEndpoint: props.appSyncApi.graphqlUrl,
      aws_appsync_region: this.region,
      aws_appsync_authenticationType: "AMAZON_COGNITO_USER_POOLS",
      aws_cognito_region: this.region,
      aws_user_pools_id: props.userPool.userPoolId,
      // CIT-207: read via SSM instead of a cross-stack Fn::ImportValue
      // (valueForStringParameter caused a stack cycle here in E19).
      aws_user_pools_web_client_id: ssm.StringParameter.fromStringParameterName(
        this,
        "UserPoolClientIdParam",
        `/citadel/${props.environment}/cognito/client-id`,
      ).stringValue,
      aws_cognito_identity_pool_id: "", // Optional: Add if using Identity Pool
      aws_mandatory_sign_in: "enable",
      aws_cognito_username_attributes: ["EMAIL"],
      aws_cognito_social_providers: [],
      aws_cognito_signup_attributes: ["EMAIL", "GIVEN_NAME", "FAMILY_NAME"],
      aws_cognito_mfa_configuration: "OPTIONAL",
      aws_cognito_mfa_types: ["SMS", "TOTP"],
      aws_cognito_password_protection_settings: {
        passwordPolicyMinLength: 8,
        passwordPolicyCharacters: [
          "REQUIRES_LOWERCASE",
          "REQUIRES_UPPERCASE",
          "REQUIRES_NUMBERS",
          "REQUIRES_SYMBOLS",
        ],
      },
      aws_cognito_verification_mechanisms: ["EMAIL"],
      aws_event_bus_url: props.agentEventBus.eventBusArn,
      aws_cost_api_url: props.costApiUrl,
    };

    // --- CIT-307: Split deployment for cache control ---
    // Hashed assets (Vite output in assets/) get immutable caching.
    // index.html and other non-hashed root files get no-cache so browsers
    // always fetch the latest entry point after a deploy.
    const frontendBuildPath =
      process.env.FRONTEND_BUILD_PATH || "../frontend/build";

    // (1) Hashed assets — long-lived immutable cache, deployed first
    const assetsDeployment = new s3deploy.BucketDeployment(
      this,
      "AssetsDeployment",
      {
        sources: [
          s3deploy.Source.asset(frontendBuildPath, {
            exclude: ["index.html", "aws-exports.json"],
          }),
        ],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        cacheControl: [
          s3deploy.CacheControl.fromString(
            "public, max-age=31536000, immutable",
          ),
        ],
        prune: false,
      },
    );

    // (2) index.html + non-hashed root files — no-cache, always revalidate
    const indexDeployment = new s3deploy.BucketDeployment(
      this,
      "IndexDeployment",
      {
        sources: [
          s3deploy.Source.asset(frontendBuildPath, {
            exclude: ["assets", "assets/**"],
          }),
          s3deploy.Source.jsonData("aws-exports.json", frontendConfig),
        ],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        distributionPaths: ["/index.html", "/"],
        cacheControl: [
          s3deploy.CacheControl.fromString(
            "no-cache, no-store, must-revalidate",
          ),
        ],
        prune: false,
      },
    );

    // Ensure index deployment runs after assets so chunks are already
    // present when the new index.html becomes live.
    indexDeployment.node.addDependency(assetsDeployment);

    // (3) Lifecycle rule: bound growth of superseded (noncurrent) hashed
    // chunks. With prune: false, old chunks accumulate as noncurrent
    // versions on each redeploy; this ages those out after 30 days.
    // Current-version expiration must NOT be used here: S3 Expiration acts
    // on the CURRENT version by age, so it would delete-mark every live,
    // index.html-referenced bundle 30 days after upload — breaking any
    // environment not redeployed within that window.
    this.bucket.addLifecycleRule({
      prefix: "assets/",
      noncurrentVersionExpiration: cdk.Duration.days(30),
      enabled: true,
    });

    // Outputs
    new cdk.CfnOutput(this, "FrontendUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
      description: "Frontend URL",
    });

    new cdk.CfnOutput(this, "FrontendBucketName", {
      value: this.bucket.bucketName,
      description: "Frontend S3 Bucket Name",
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: this.distribution.distributionId,
      description: "CloudFront Distribution ID",
    });
  }
}

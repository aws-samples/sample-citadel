import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as appsync from '@aws-cdk/aws-appsync-alpha';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from "aws-cdk-lib/aws-events";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';

interface FrontendStackProps extends cdk.StackProps {
  appSyncApi: appsync.GraphqlApi;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  agentEventBus: events.EventBus;
  environment: string;
}

export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);
    
    // S3 bucket for frontend hosting
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
          bucketName: `citadel-frontend-s3-logs-${props.environment}-${this.account}-${this.region}`,
          encryption: s3.BucketEncryption.S3_MANAGED,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
          lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
        });
    
        this.bucket = new s3.Bucket(this, 'FrontendBucket', {
              bucketName: `citadel-frontend-${props.environment}-${this.account}-${this.region}`,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
              autoDeleteObjects: true,
              versioned: true,
              publicReadAccess: false,
              blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
              enforceSSL: true,
              serverAccessLogsBucket: accessLogsBucket,
              serverAccessLogsPrefix: 'frontend/',
            });

    // Create OAI
    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI');
    this.bucket.grantRead(oai);

    // WAF WebACL for CloudFront (S-16 fix)
    // CloudFront-scoped WAF WebACLs can only be created in us-east-1
    let webAclArn: string | undefined;
    if (this.region === 'us-east-1') {
      const webAcl = new wafv2.CfnWebACL(this, 'CloudFrontWebAcl', {
        defaultAction: { allow: {} },
        scope: 'CLOUDFRONT',
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'CitadelWebAcl',
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'AWSManagedRulesCommonRuleSet',
            priority: 1,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesCommonRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'CommonRuleSet',
              sampledRequestsEnabled: true,
            },
          },
          {
            name: 'RateLimitRule',
            priority: 2,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: 2000,
                aggregateKeyType: 'IP',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'RateLimitRule',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });
      webAclArn = webAcl.attrArn;
    }

    // CloudFront distribution using L1 construct
    const cloudFrontLogsBucket = new s3.Bucket(this, 'CloudFrontLogsBucket', {
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
    
        const cfnDistribution = new cloudfront.CfnDistribution(this, 'FrontendDistribution', {
          distributionConfig: {
            enabled: true,
            defaultRootObject: 'index.html',
            priceClass: 'PriceClass_100',
            comment: 'Citadel Frontend Distribution', logging: { bucket: cloudFrontLogsBucket.bucketRegionalDomainName, prefix: 'cloudfront/', includeCookies: false }, viewerCertificate: { cloudFrontDefaultCertificate: true, minimumProtocolVersion: 'TLSv1.2_2021' },
            webAclId: webAclArn,
            origins: [
              {
                id: 's3-origin',
                domainName: this.bucket.bucketRegionalDomainName,
                s3OriginConfig: {
                  originAccessIdentity: `origin-access-identity/cloudfront/${oai.originAccessIdentityId}`,
                },
              },
              {
                id: 'appsync-origin',
                domainName: cdk.Fn.select(2, cdk.Fn.split('/', props.appSyncApi.graphqlUrl)),
                customOriginConfig: {
                  httpPort: 80,
                  httpsPort: 443,
                  originProtocolPolicy: 'https-only',
                  originSslProtocols: ['TLSv1.2'],
                },
              },
            ],
            defaultCacheBehavior: {
              targetOriginId: 's3-origin',
              viewerProtocolPolicy: 'redirect-to-https',
              allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
              cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
              compress: true,
              cachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // CachingOptimized
            },
            cacheBehaviors: [
              {
                pathPattern: '/api/*',
                targetOriginId: 'appsync-origin',
                viewerProtocolPolicy: 'https-only',
                allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
                cachedMethods: ['GET', 'HEAD'],
                cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // CachingDisabled
                originRequestPolicyId: '88a5eaf4-2fd4-4709-b370-b4c650ea3fcf', // CORS-S3Origin
              },
            ],
            customErrorResponses: [
              {
                errorCode: 404,
                responseCode: 200,
                responsePagePath: '/index.html',
                errorCachingMinTtl: 1800,
              },
              {
                errorCode: 403,
                responseCode: 200,
                responsePagePath: '/index.html',
                errorCachingMinTtl: 1800,
              },
            ],
          },
        });

    this.distribution = cloudfront.Distribution.fromDistributionAttributes(this, 'Distribution', {
      distributionId: cfnDistribution.ref,
      domainName: cfnDistribution.attrDomainName,
    }) as cloudfront.Distribution;

    // Configure Cognito email templates with CloudFront URL using Custom Resource
    const hostUrl = process.env.HOST_URL || `https://${cfnDistribution.attrDomainName}`;
    
    const verificationEmailTemplate = fs.readFileSync(
      path.join(__dirname, '../src/cognito-email-templates/verification-email.html'),
      'utf-8'
    ).replace(/https:\/\/your-domain\.com/g, hostUrl);
    
    const invitationEmailTemplate = fs.readFileSync(
      path.join(__dirname, '../src/cognito-email-templates/invitation-email.html'),
      'utf-8'
    ).replace(/https:\/\/your-domain\.com/g, hostUrl);

    const passwordResetEmailTemplate = fs.readFileSync(
      path.join(__dirname, '../src/cognito-email-templates/password-reset-email.html'),
      'utf-8'
    ).replace(/https:\/\/your-domain\.com/g, hostUrl);

    // Create a Lambda function to update Cognito email templates
    const updateEmailTemplatesFunction = new cdk.aws_lambda.Function(this, 'UpdateEmailTemplatesFunction', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, '../../src/lambda/update-email-templates')),
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'UpdateEmailTemplatesFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      tracing: cdk.aws_lambda.Tracing.ACTIVE, // O-03
      environment: {
        POWERTOOLS_SERVICE_NAME: 'citadel', // O-02
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
    });

    // Grant permissions to update Cognito User Pool
    updateEmailTemplatesFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:UpdateUserPool', 'cognito-idp:DescribeUserPool'],
        resources: [props.userPool.userPoolArn],
      })
    );

    // Create Custom Resource to trigger the Lambda
    const emailTemplatesCustomResource = new cdk.CustomResource(this, 'EmailTemplatesCustomResource', {
      serviceToken: updateEmailTemplatesFunction.functionArn,
      properties: {
        UserPoolId: props.userPool.userPoolId,
        VerificationTemplate: verificationEmailTemplate,
        InvitationTemplate: invitationEmailTemplate,
        PasswordResetTemplate: passwordResetEmailTemplate,
        // Trigger update when CloudFront URL changes
        CloudFrontUrl: hostUrl,
        // O-05: Use version string instead of Date.now() to avoid unnecessary re-runs
        Version: 'v1.1.0',
      },
    });

    // Ensure this runs after the distribution is created
    emailTemplatesCustomResource.node.addDependency(cfnDistribution);

    // Output CloudFront URL for reference
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: hostUrl,
      description: 'CloudFront Distribution URL used in email templates',
    });

    // Create a configuration file for the frontend
    const frontendConfig = {
      aws_project_region: this.region,
      aws_appsync_graphqlEndpoint: props.appSyncApi.graphqlUrl,
      aws_appsync_region: this.region,
      aws_appsync_authenticationType: 'AMAZON_COGNITO_USER_POOLS',
      aws_cognito_region: this.region,
      aws_user_pools_id: props.userPool.userPoolId,
      aws_user_pools_web_client_id: props.userPoolClient.userPoolClientId, 
      aws_cognito_identity_pool_id: '', // Optional: Add if using Identity Pool
      aws_mandatory_sign_in: 'enable',
      aws_cognito_username_attributes: ['EMAIL'],
      aws_cognito_social_providers: [],
      aws_cognito_signup_attributes: ['EMAIL', 'GIVEN_NAME', 'FAMILY_NAME'],
      aws_cognito_mfa_configuration: 'OPTIONAL',
      aws_cognito_mfa_types: ['SMS', 'TOTP'],
      aws_cognito_password_protection_settings: {
        passwordPolicyMinLength: 8,
        passwordPolicyCharacters: ['REQUIRES_LOWERCASE', 'REQUIRES_UPPERCASE', 'REQUIRES_NUMBERS', 'REQUIRES_SYMBOLS'],
      },
      aws_cognito_verification_mechanisms: ['EMAIL'],
      aws_event_bus_url: props.agentEventBus.eventBusArn,
    };

    // Deploy frontend build files to S3
    const frontendBuildPath = process.env.FRONTEND_BUILD_PATH || '../frontend/build';
    new s3deploy.BucketDeployment(this, 'FrontendBuildDeployment', {
      sources: [s3deploy.Source.asset(frontendBuildPath), s3deploy.Source.jsonData('aws-exports.json', frontendConfig)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths:["/*"]
    });

    // Outputs
    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Frontend URL',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.bucket.bucketName,
      description: 'Frontend S3 Bucket Name',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront Distribution ID',
    });
  }
}
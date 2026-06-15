# Integration Types Documentation

This document provides setup instructions and troubleshooting guidance for all supported integration types in the Citadel platform.

## Table of Contents

- [SaaS Integrations](#saas-integrations)
  - [Confluence](#confluence)
  - [Jira](#jira)
  - [ServiceNow](#servicenow)
  - [Slack](#slack)
  - [Microsoft](#microsoft)
  - [Zendesk](#zendesk)
  - [PagerDuty](#pagerduty)
- [AgentCore Integrations](#agentcore-integrations)
  - [AWS Lambda](#aws-lambda)
  - [AWS Services (Smithy)](#aws-services-smithy)
  - [MCP Server](#mcp-server)
- [Troubleshooting](#troubleshooting)

---

## SaaS Integrations

### Confluence

Connect to Atlassian Confluence for documentation and knowledge base management.

**Authentication Method:** API Key

**Setup Instructions:**
1. Log in to your Atlassian account
2. Go to Account Settings > Security > API tokens
3. Create a new API token
4. In the integration form, provide:
   - Email: Your Atlassian account email
   - API Token: The token you just created
   - Base URL: Your Confluence instance URL (e.g., https://your-domain.atlassian.net)

**Required Permissions:**
- Read access to Confluence spaces
- Write access if you want to create/update pages

---

### Jira

Connect to Atlassian Jira for issue tracking and project management.

**Authentication Method:** API Key

**Setup Instructions:**
1. Log in to your Atlassian account
2. Go to Account Settings > Security > API tokens
3. Create a new API token
4. In the integration form, provide:
   - Email: Your Atlassian account email
   - API Token: The token you just created
   - Base URL: Your Jira instance URL (e.g., https://your-domain.atlassian.net)

**Required Permissions:**
- Read access to Jira projects
- Write access if you want to create/update issues

---

### ServiceNow

Connect to ServiceNow for IT service management and workflow automation.

**Authentication Method:** Basic Auth

**Setup Instructions:**
1. Log in to your ServiceNow instance as an administrator
2. Create a dedicated integration user account
3. In the integration form, provide:
   - Username: ServiceNow username
   - Password: ServiceNow password
   - Instance URL: Your ServiceNow instance URL (e.g., https://your-instance.service-now.com)

**Required Permissions:**
- Read access to tables you want to query
- Write access if you want to create/update records

---

### Slack

Connect to Slack for team communication and notifications.

**Authentication Method:** OAuth 2.0

**Setup Instructions:**
1. Go to https://api.slack.com/apps
2. Create a new Slack app or select an existing one
3. Go to OAuth & Permissions
4. Add the required scopes (e.g., chat:write, channels:read)
5. Install the app to your workspace
6. In the integration form, provide:
   - Client ID: From Basic Information
   - Client Secret: From Basic Information
   - Workspace ID: Your Slack workspace ID

**Required Scopes:**
- `chat:write` - Send messages
- `channels:read` - List channels
- `users:read` - Read user information

---

### Microsoft

Connect to Microsoft SharePoint and Teams via Graph API.

**Authentication Method:** OAuth 2.0

**Setup Instructions:**
1. Go to Azure Portal > Azure Active Directory > App registrations
2. Create a new app registration
3. Go to Certificates & secrets and create a new client secret
4. Go to API permissions and add required Microsoft Graph permissions
5. In the integration form, provide:
   - Client ID: Application (client) ID from app registration
   - Client Secret: The secret you created
   - Tenant ID: Directory (tenant) ID from Azure AD

**Required Permissions:**
- `Files.Read.All` - Read files in SharePoint
- `Sites.Read.All` - Read SharePoint sites
- `User.Read` - Read user profile

---

### Zendesk

Connect to Zendesk for customer support and ticketing.

**Authentication Method:** API Key

**Setup Instructions:**
1. Log in to your Zendesk account as an administrator
2. Go to Admin > Channels > API
3. Enable token access and create a new API token
4. In the integration form, provide:
   - Email: Your Zendesk account email
   - API Token: The token you created
   - Subdomain: Your Zendesk subdomain (from your-company.zendesk.com)

**Required Permissions:**
- Read access to tickets
- Write access if you want to create/update tickets

---

### PagerDuty

Connect to PagerDuty for incident management and on-call scheduling.

**Authentication Method:** Bearer Token

**Setup Instructions:**
1. Log in to your PagerDuty account
2. Go to Integrations > API Access Keys
3. Create a new API key
4. In the integration form, provide:
   - API Token: The API key you created

**Required Permissions:**
- Read access to incidents
- Write access if you want to create/update incidents

---

## AgentCore Integrations

### AWS Lambda

Execute custom business logic via Lambda functions as MCP tools.

**Authentication Method:** IAM Role

**Setup Instructions:**

1. **Create an IAM Execution Role:**
   ```bash
   # Create a trust policy for Lambda
   cat > trust-policy.json << EOF
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Service": "lambda.amazonaws.com"
         },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   EOF
   
   # Create the role
   aws iam create-role \
     --role-name LambdaExecutionRole \
     --assume-role-policy-document file://trust-policy.json
   
   # Attach the Lambda execution policy
   aws iam attach-role-policy \
     --role-name LambdaExecutionRole \
     --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
   ```

2. **Create Your Lambda Function:**
   ```python
   # example_function.py
   def lambda_handler(event, context):
       # Your business logic here
       return {
           'statusCode': 200,
           'body': 'Hello from Lambda!'
       }
   ```

3. **Define the Tool Schema:**
   ```json
   {
     "name": "my_custom_tool",
     "description": "Executes custom business logic",
     "inputSchema": {
       "type": "object",
       "properties": {
         "input_param": {
           "type": "string",
           "description": "Input parameter for the function"
         }
       },
       "required": ["input_param"]
     }
   }
   ```

4. **Configure the Integration:**
   - Execution Role ARN: `arn:aws:iam::123456789012:role/LambdaExecutionRole`
   - Lambda Function ARN: `arn:aws:lambda:us-east-1:123456789012:function:MyFunction`
   - Tool Schema: Paste the JSON schema from step 3
   - AWS Region: The region where your Lambda function is deployed (e.g., `us-east-1`)

**Required IAM Permissions:**
- `lambda:InvokeFunction` - To invoke the Lambda function

**Troubleshooting:**
- **Error: "Invalid Lambda ARN format"** - Ensure your Lambda ARN follows the format: `arn:aws:lambda:region:account:function:function-name`
- **Error: "Execution role lacks necessary permissions"** - Add `lambda:InvokeFunction` permission to the execution role
- **Error: "Tool schema must be valid JSON"** - Validate your JSON syntax using a JSON validator
- **Error: "Tool schema must include required fields"** - Ensure your schema includes `name`, `description`, and `inputSchema` fields

---

### AWS Services (Smithy)

Direct integration with AWS services like DynamoDB, S3, Lambda, SQS, and SNS.

**Authentication Method:** IAM Role

**Setup Instructions:**

1. **Create an IAM Execution Role:**
   ```bash
   # Create a trust policy for the service
   cat > trust-policy.json << EOF
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Service": "bedrock.amazonaws.com"
         },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   EOF
   
   # Create the role
   aws iam create-role \
     --role-name ServiceExecutionRole \
     --assume-role-policy-document file://trust-policy.json
   ```

2. **Attach Service-Specific Permissions:**

   **For DynamoDB:**
   ```bash
   aws iam attach-role-policy \
     --role-name ServiceExecutionRole \
     --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess
   ```

   **For S3:**
   ```bash
   aws iam attach-role-policy \
     --role-name ServiceExecutionRole \
     --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
   ```

   **For SQS:**
   ```bash
   aws iam attach-role-policy \
     --role-name ServiceExecutionRole \
     --policy-arn arn:aws:iam::aws:policy/AmazonSQSFullAccess
   ```

   **For SNS:**
   ```bash
   aws iam attach-role-policy \
     --role-name ServiceExecutionRole \
     --policy-arn arn:aws:iam::aws:policy/AmazonSNSFullAccess
   ```

3. **Configure the Integration:**
   - Execution Role ARN: `arn:aws:iam::123456789012:role/ServiceExecutionRole`
   - AWS Service: Select from dropdown (DynamoDB, S3, Lambda, SQS, SNS)
   - AWS Region: The region for the service (e.g., `us-east-1`)

**Required IAM Permissions:**
- **DynamoDB:** `dynamodb:ListTables`, `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:Query`, `dynamodb:Scan`
- **S3:** `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`
- **Lambda:** `lambda:InvokeFunction`, `lambda:ListFunctions`
- **SQS:** `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`
- **SNS:** `sns:Publish`, `sns:Subscribe`, `sns:ListTopics`

**Troubleshooting:**
- **Error: "Invalid IAM Role ARN format"** - Ensure your role ARN follows the format: `arn:aws:iam::account:role/role-name`
- **Error: "Execution role lacks permissions for {service}"** - Add the appropriate service permissions to the execution role
- **Error: "Invalid AWS region code"** - Use a valid AWS region code like `us-east-1`, `eu-west-1`, etc.

---

### MCP Server

Connect to external MCP-compatible servers for specialized tools and third-party services.

**Authentication Method:** Configurable (API Key, OAuth 2.0, or Custom)

**Setup Instructions:**

#### API Key Authentication

1. **Obtain API Key from MCP Server Provider:**
   - Contact your MCP server provider or check their documentation
   - Generate an API key from their dashboard

2. **Configure the Integration:**
   - Authentication Method: Select "API Key"
   - MCP Server URL: `https://mcp.example.com`
   - API Key: Your API key from step 1

#### OAuth 2.0 Authentication

1. **Register Your Application:**
   - Go to your MCP server provider's developer portal
   - Create a new OAuth application
   - Note the Client ID and Client Secret

2. **Configure the Integration:**
   - Authentication Method: Select "OAuth 2.0"
   - MCP Server URL: `https://mcp.example.com`
   - Client ID: Your OAuth client ID
   - Client Secret: Your OAuth client secret

#### Custom Authentication

1. **Consult MCP Server Documentation:**
   - Check your MCP server's authentication requirements
   - Prepare any custom headers or tokens needed

2. **Configure the Integration:**
   - Authentication Method: Select "Custom"
   - MCP Server URL: `https://mcp.example.com`
   - Follow any additional configuration steps provided by your MCP server

**Required Permissions:**
- Varies by MCP server provider
- Typically requires read access to tools and resources

**Troubleshooting:**
- **Error: "MCP Server URL must be a valid HTTPS URL"** - Ensure your URL uses HTTPS protocol and is properly formatted
- **Error: "Unable to connect to MCP server"** - Check network connectivity and ensure the server URL is correct
- **Error: "MCP server authentication failed"** - Verify your API key or OAuth credentials are correct and not expired

---

## Troubleshooting

### General Issues

**Integration Status Stuck in "Configuring":**
- Ensure all required fields are filled in correctly
- Test the connection to verify credentials
- Check the error message for specific issues

**Connection Test Fails:**
- Verify credentials are correct
- Check network connectivity
- Ensure the service is accessible from your environment
- Review IAM permissions for AWS integrations

**Integration Disconnects Unexpectedly:**
- Check if credentials have expired
- Verify the service is still accessible
- Review error logs for specific issues

### AWS-Specific Issues

**AgentCore Gateway Not Configured:**
- Verify the Services Stack deployed successfully
- Check that the Gateway ID is exported from the Services Stack
- Redeploy the backend stack to ensure Gateway ID is imported:
  ```bash
  ./deploy.sh --backend-only --profile your-profile
  ```

**IAM Role Permissions:**
- Use the AWS IAM Policy Simulator to test permissions
- Ensure the trust policy allows the correct service to assume the role
- Check CloudWatch Logs for detailed error messages

### Getting Help

If you continue to experience issues:
1. Check the error message in the integration card
2. Review the CloudWatch Logs for detailed error information
3. Consult the service provider's documentation
4. Contact support with the integration ID and error details

---

## Environment Configuration

### Backend Environment Variables

The AgentCore Gateway ID is automatically imported from the Services Stack during deployment. No manual configuration is required in your `backend/.env` file.

If you need to verify the Gateway ID:

```bash
# Get Gateway ID from CloudFormation exports
aws cloudformation list-exports \
  --query "Exports[?Name=='citadel-services-dev-GatewayId'].Value" \
  --output text
```

### AWS Credentials

Ensure your AWS credentials are configured:

```bash
# Option 1: Environment variables
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1

# Option 2: AWS CLI configuration
aws configure
```

---

## Best Practices

1. **Use Dedicated Service Accounts:** Create dedicated service accounts or IAM roles for integrations rather than using personal credentials
2. **Principle of Least Privilege:** Grant only the minimum permissions required for the integration to function
3. **Rotate Credentials Regularly:** Update API keys and secrets on a regular schedule
4. **Monitor Integration Health:** Regularly check integration status and test connections
5. **Use Environment-Specific Configurations:** Maintain separate configurations for development, staging, and production environments
6. **Document Custom Configurations:** Keep notes on any custom settings or configurations for your integrations

---

## Additional Resources

- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [AWS Lambda Documentation](https://docs.aws.amazon.com/lambda/)
- [AWS Bedrock AgentCore Documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)

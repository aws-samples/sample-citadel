# Frontend Integration Testing Guide

## Quick Start

### 1. Deploy Backend (if not already deployed)

```bash
cd backend
npm run build:lambda
cdk deploy BackendStack --profile akalanka+0001-Administrator
```

### 2. Access Test Page

1. Start frontend: `cd frontend && npm run dev`
2. Login to the application
3. Navigate to test page by typing in browser console:
   ```javascript
   // In browser console
   window.location.hash = '#integrations-test'
   ```
   Or manually change the URL to include `integrations-test` in the navigation

### 3. Test Integration Flow

#### Step 1: Get Confluence API Token
1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Label: "Citadel Test"
4. Copy the token

#### Step 2: Create Integration
1. Fill in the form:
   - **Name**: Test Confluence
   - **Base URL**: https://your-company.atlassian.net
   - **Email**: your-email@company.com
   - **API Token**: (paste token from step 1)
   - **Space Keys**: PROJ, DOCS (optional)
2. Click "Create Integration"
3. Copy the `integrationId` from the result

#### Step 3: Test Connection
1. Click "Test Connection" button
2. Should see: `{ success: true, message: "Connection successful" }`

#### Step 4: Connect Integration
1. Click "Connect" button
2. Status should change to "CONNECTED"

#### Step 5: List Integrations
1. Click "List Integrations"
2. Should see your integration in the list

#### Step 6: Delete Integration (optional)
1. Click "Delete" button
2. Confirm deletion
3. Integration should be removed

## Alternative: Test via Browser Console

If you prefer to test directly via browser console:

```javascript
// Import the service (already available in the app)
import { integrationService } from './services/integrationService';

// 1. List integrations
const integrations = await integrationService.listIntegrations('default');
console.log(integrations);

// 2. Create integration
const newIntegration = await integrationService.createIntegration({
  integrationType: 'CONFLUENCE',
  name: 'Test Confluence',
  orgId: 'default',
  config: {
    baseUrl: 'https://your-company.atlassian.net',
    spaceKeys: ['PROJ'],
    enabledFeatures: ['read', 'search']
  },
  credentials: {
    email: 'your-email@company.com',
    apiToken: 'YOUR_TOKEN_HERE'
  }
});
console.log('Created:', newIntegration);

// 3. Test connection
const testResult = await integrationService.testIntegration(newIntegration.integrationId);
console.log('Test result:', testResult);

// 4. Connect
const connected = await integrationService.connectIntegration(newIntegration.integrationId);
console.log('Connected:', connected);

// 5. Delete
const deleted = await integrationService.deleteIntegration(newIntegration.integrationId);
console.log('Deleted:', deleted);
```

## Test via GraphQL Playground

1. Open AppSync console
2. Go to Queries tab
3. Run mutations:

```graphql
# Create
mutation {
  createIntegration(input: {
    integrationType: CONFLUENCE
    name: "Test Confluence"
    orgId: "default"
    config: {
      baseUrl: "https://your-company.atlassian.net"
      spaceKeys: ["PROJ"]
      enabledFeatures: ["read", "search"]
    }
    credentials: {
      email: "your-email@company.com"
      apiToken: "YOUR_TOKEN"
    }
  }) {
    integrationId
    status
    name
  }
}

# Test
mutation {
  testIntegration(integrationId: "YOUR_ID") {
    success
    message
    details
  }
}

# Connect
mutation {
  connectIntegration(integrationId: "YOUR_ID") {
    integrationId
    status
  }
}

# List
query {
  listIntegrations(orgId: "default") {
    integrationId
    name
    status
    config
  }
}
```

## Expected Results

### Successful Flow
1. **Create**: Returns integration with `status: "CONFIGURING"`
2. **Test**: Returns `{ success: true, message: "Connection successful" }`
3. **Connect**: Returns integration with `status: "CONNECTED"`
4. **List**: Shows integration in list

### Error Cases

#### Invalid Credentials
```json
{
  "success": false,
  "message": "Connection failed: 401 Unauthorized"
}
```

#### Invalid Base URL
```json
{
  "success": false,
  "message": "Connection error: fetch failed"
}
```

## Troubleshooting

### Error: "Integration not found"
- Check DynamoDB table: `citadel-integrations-test`
- Verify orgId matches

### Error: "Access denied"
- Check Cognito authentication
- Verify user is logged in
- Check browser console for auth errors

### Error: "Network error"
- Check AppSync endpoint in config
- Verify AWS credentials
- Check browser network tab

### Test Connection Fails
- Verify Confluence URL is correct
- Check API token is valid
- Ensure email matches Atlassian account
- Check CloudWatch logs: `/aws/lambda/citadel-integration-resolver-test`

## Verify Backend

```bash
# Check Lambda logs
aws logs tail /aws/lambda/citadel-integration-resolver-test --follow

# Check DynamoDB
aws dynamodb scan \
  --table-name citadel-integrations-test \
  --region ap-southeast-2

# Check Secrets Manager
aws secretsmanager list-secrets \
  --filters Key=name,Values=/citadel/integrations \
  --region ap-southeast-2
```

## Clean Up Test Data

```bash
# Delete all test integrations via GraphQL
mutation {
  deleteIntegration(integrationId: "YOUR_ID") {
    success
    message
  }
}

# Or via AWS CLI
aws dynamodb scan \
  --table-name citadel-integrations-test \
  --region ap-southeast-2 \
  | jq -r '.Items[].integrationId.S' \
  | xargs -I {} aws dynamodb delete-item \
    --table-name citadel-integrations-test \
    --key '{"PK":{"S":"ORG#default"},"SK":{"S":"INTEGRATION#CONFLUENCE#{}"}}' \
    --region ap-southeast-2
```

## Next Steps

Once testing is complete:
1. ✅ Verify all CRUD operations work
2. ✅ Test error handling
3. ✅ Verify security (credentials in Secrets Manager)
4. Update main Integrations.tsx to use real data
5. Add UI for creating integrations
6. Implement AgentCore Gateway integration

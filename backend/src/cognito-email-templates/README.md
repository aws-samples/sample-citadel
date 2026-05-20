# Cognito Email Templates

This directory contains custom HTML email templates for AWS Cognito user pool messages. These templates feature the CITADEL branding with a professional header and footer.

## Templates

### 1. Verification Email (Code-based)
**File:** `verification-email.html`

Used when users need to verify their email address with a verification code.

**Cognito Placeholders:**
- `{####}` - Verification code

**Configuration:**
- Set verification type to "Code" in Cognito console
- Maximum length: 20,000 UTF-8 characters

### 2. Verification Email (Link-based)
**File:** `verification-email-link.html`

Used when users can verify their email address by clicking a link.

**Cognito Placeholders:**
- `{##Verify Your Email##}` - Verification link (text between ## can be customized)

**Configuration:**
- Set verification type to "Link" in Cognito console
- Maximum length: 20,000 UTF-8 characters

### 3. Invitation Email
**File:** `invitation-email.html`

Sent to new users when they are invited to join the platform.

**Cognito Placeholders:**
- `{username}` - User's username
- `{####}` - Temporary password

**Configuration:**
- Maximum length: 20,000 UTF-8 characters for email

### 4. MFA Email
**File:** `mfa-email.html`

Sent when multi-factor authentication is required for sign-in.

**Cognito Placeholders:**
- `{####}` - MFA authentication code

**Configuration:**
- Maximum length: 20,000 UTF-8 characters

## Setup Instructions

### Using AWS Console

1. Navigate to Amazon Cognito in AWS Console
2. Select your User Pool
3. Go to "Messaging" → "Message templates"
4. For each template type:
   - Select the message type (Verification, Invitation, or MFA)
   - Choose "Email" as the delivery method
   - Copy the HTML content from the corresponding file
   - Paste into the message template editor
   - Save changes

### Using AWS CDK (Automatic via Custom Resource)

**Note:** This project automatically configures email templates using a Custom Resource in the FrontendStack. No manual configuration needed!

The FrontendStack:
1. Creates CloudFront distribution
2. Loads email templates and replaces URLs
3. Uses a Python Lambda Custom Resource to update Cognito User Pool

**Lambda function:** `backend/src/lambda/update-email-templates/index.py`

```python
import boto3
import cfnresponse

def handler(event, context):
    cognito = boto3.client('cognito-idp')
    cognito.update_user_pool(
        UserPoolId=user_pool_id,
        VerificationMessageTemplate={...},
        AdminCreateUserConfig={...}
    )
    cfnresponse.send(event, context, cfnresponse.SUCCESS, {...})
```

**CDK Configuration:** `backend/lib/frontend-stack.ts`

```typescript
// Smart URL selection
const hostUrl = process.env.HOST_URL || `https://${cfnDistribution.attrDomainName}`;

// Load and process templates
const verificationEmailTemplate = fs.readFileSync(...).replace(...);

// Custom Resource Lambda (Python)
const updateEmailTemplatesFunction = new lambda.Function(this, 'UpdateEmailTemplatesFunction', {
  runtime: lambda.Runtime.PYTHON_3_11,
  handler: 'index.handler',
  code: lambda.Code.fromAsset(path.join(__dirname, '../src/lambda/update-email-templates')),
});
```

### Using AWS CLI

```bash
# Update verification message
aws cognito-idp update-user-pool \
  --user-pool-id <your-pool-id> \
  --verification-message-template \
    EmailMessage="$(cat verification-email.html)" \
    EmailSubject="Verify your email for CITADEL"

# Update invitation message
aws cognito-idp update-user-pool \
  --user-pool-id <your-pool-id> \
  --admin-create-user-config \
    InviteMessageTemplate={
      EmailMessage="$(cat invitation-email.html)",
      EmailSubject="Welcome to CITADEL"
    }
```

## Customization

### Update Host URL (Optional)

**Automatic Configuration:** By default, the system uses your CloudFront distribution URL automatically. No configuration needed!

**Custom Domain:** If you have a custom domain, set the `HOST_URL` environment variable in `backend/.env`:
```bash
HOST_URL=https://your-actual-domain.com
```

The FrontendStack will automatically replace all `https://your-domain.com` references in the templates. This affects:
- Logo URL: `{HOST_URL}/Citadel_logo_sans_sml.png`
- Login URL: `{HOST_URL}/login` (in invitation email)

**Fallback Behavior:**
- If `HOST_URL` is set → uses your custom domain
- If `HOST_URL` is not set → uses CloudFront distribution URL (e.g., `https://d123abc.cloudfront.net`)

### Customize Colors
The templates use the following color scheme:
- Primary gradient: Orange to red (`#FFA500` → `#DC143C`)
- Background: Dark slate (`#0f172a`, `#1e293b`)
- Accent: Orange (`#fb923c`, `#f97316`)
- Text: Light slate (`#e2e8f0`, `#cbd5e1`)

### Email Subject Lines
Recommended subject lines:
- **Verification:** "Verify your email for CITADEL"
- **Invitation:** "Welcome to CITADEL"
- **MFA:** "Your CITADEL authentication code"

## Testing

Before deploying to production:

1. Test with Cognito's test email feature
2. Check rendering in multiple email clients:
   - Gmail
   - Outlook
   - Apple Mail
   - Mobile devices
3. Verify all placeholders are replaced correctly
4. Test link functionality (for link-based verification)

## Notes

- All templates are responsive and mobile-friendly
- HTML email uses inline CSS for maximum compatibility
- Templates follow email best practices for deliverability
- Maximum message length is 20,000 UTF-8 characters for email
- Verification codes expire based on your Cognito configuration (default: 24 hours)
- MFA codes typically expire in 3 minutes

## Support

For issues or questions about these templates, refer to:
- [AWS Cognito Documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-message-customizations.html)
- Your team's internal documentation

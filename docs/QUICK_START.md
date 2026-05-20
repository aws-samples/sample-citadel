# Quick Start Guide

Get Citadel up and running in 5 minutes.

## 1. Prerequisites

```bash
# Install Node.js 24+
node --version

# Install AWS CDK
npm install -g aws-cdk

# Configure AWS CLI
aws configure
```

## 2. Configure

```bash
# Copy environment template
cp backend/.env.example backend/.env

# Edit with your details
nano backend/.env
```

**Minimum required in `.env`:**
```bash
ENVIRONMENT=dev
CDK_DEFAULT_ACCOUNT=your-account-id
CDK_DEFAULT_REGION=ap-southeast-2
ADMIN_EMAIL=your-email@example.com
ADMIN_PASSWORD=YourSecurePass123!
```

## 3. Deploy

```bash
# Deploy everything
./deploy.sh

# Or with AWS profile
./deploy.sh --profile my-profile
```

## 4. Access

After deployment completes:

1. Find CloudFront URL in outputs
2. Navigate to URL
3. Login with your `ADMIN_EMAIL` and `ADMIN_PASSWORD`

## Common Commands

```bash
# Deploy all stacks
./deploy.sh --all

# Deploy backend only
./deploy.sh --backend-only

# Deploy with profile
./deploy.sh --profile my-aws-profile

# Deploy specific stack
./deploy.sh BackendStack

# Get help
./deploy.sh --help
```

## Troubleshooting

**Build fails?**
```bash
cd frontend && npm install
cd ../backend && npm install
```

**Need to bootstrap CDK?**
```bash
cdk bootstrap aws://ACCOUNT/REGION
```

**Want to start over?**
```bash
cd backend
cdk destroy --all
```

## Next Steps

- Read [DEPLOYMENT.md](DEPLOYMENT.md) for detailed guide
- Check [backend README](../backend/README.md) for backend-specific info
- Review CloudFormation outputs for API endpoints
- Add more users in Team Management

## Support

- Check CloudWatch Logs for errors
- Review CloudFormation events
- Verify IAM permissions

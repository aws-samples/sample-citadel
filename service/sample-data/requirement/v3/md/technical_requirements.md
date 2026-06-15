# Technical Requirements - Intelligent Invoice Exception Resolution

## Current Architecture & Systems

**System Architecture**: Hybrid monolithic and service-oriented
- **Core ERP**: SAP S/4HANA (on-premise) - handles invoice processing, PO management, GRN recording
- **Email System**: Microsoft Exchange Server 2019 (on-premise) with Office 365 hybrid
- **Document Storage**: Network-attached storage (NAS) for invoice PDFs and supporting documents
- **Reporting**: SAP BusinessObjects for financial reporting

**Technology Stack**:
- **Application Layer**: Java-based custom extensions on SAP
- **Database**: SAP HANA (in-memory database)
- **Integration Middleware**: SAP PI/PO (Process Integration/Orchestration)
- **Frontend**: SAP Fiori for modern UI, legacy SAP GUI still in use

**Cloud Maturity**: Early hybrid stage
- Office 365 for email and collaboration (cloud)
- Core ERP remains on-premise due to historical concerns about data sovereignty
- No experience with AWS or other cloud platforms
- IT leadership now open to cloud-native solutions for new capabilities

## Integration Landscape

**Systems Requiring Integration**:

1. **SAP S/4HANA** (Critical)
   - Invoice data, PO data, GRN data
   - Vendor master data
   - Approval workflows
   - Integration method: SAP OData APIs (REST-like)

2. **Microsoft Exchange/Office 365** (Critical)
   - Read incoming supplier emails
   - Send outgoing emails to suppliers and internal staff
   - Search email history for context
   - Integration method: Microsoft Graph API (REST)

3. **SharePoint** (Important)
   - Contract documents and supplier agreements
   - Historical correspondence archives
   - Integration method: Microsoft Graph API

4. **Procurement System** (Important)
   - Supplier performance data
   - Contract terms and conditions
   - Integration method: Custom REST API

5. **Document Management** (Important)
   - Invoice PDFs and supporting documents
   - Integration method: File system access or S3 migration

**Integration Patterns**:
- **Current**: Primarily batch-based integration via SAP PI/PO (nightly jobs)
- **Required for Agents**: Real-time event-driven integration
  - Invoice discrepancy detected → trigger agent investigation
  - Supplier email received → trigger agent response
  - GRN created → check for pending invoice exceptions

**Performance Requirements**:
- **Invoice volume**: 50,000/month (2,500/day average, 5,000/day peak at month-end)
- **Exception volume**: 15,000/month (750/day average)
- **Response time**: Agent should begin investigation within 5 minutes of exception detection
- **Email response**: Agent should respond to supplier emails within 2 hours during business hours
- **Availability**: 99.5% during business hours (7am-7pm AEST, Monday-Friday)

**Critical SLAs**:
- Month-end close: All exceptions must be resolved within 3 business days
- High-value invoices (>$50K): 24-hour resolution target
- Supplier payment terms: Must not breach payment deadlines

## Data Strategy & Readiness

**Data Sources**:

1. **Structured Data** (SAP HANA):
   - Invoice records: invoice number, amount, date, vendor ID, PO reference
   - Purchase orders: PO number, line items, quantities, prices
   - GRNs: receipt date, quantities received, quality status
   - Vendor master: vendor ID, name, contact details, payment terms, performance ratings

2. **Unstructured Data**:
   - **Email correspondence**: 2 years of email history (~500K emails)
   - **Invoice PDFs**: 7 years of scanned invoices (compliance requirement)
   - **Contract documents**: PDF contracts with supplier terms
   - **Spreadsheet tracking**: Excel files with tribal knowledge and exception notes

**Data Quality**:
- **Structured data**: High quality (95%+ accuracy) - SAP enforces data validation
- **Unstructured data**: Variable quality
  - Email threads often fragmented across multiple conversations
  - Inconsistent naming conventions for attachments
  - Tribal knowledge in spreadsheets not standardized

**Data Sensitivity**:
- **Confidential**: Vendor bank account details, pricing agreements, contract terms
- **Internal**: Invoice amounts, PO numbers, approval decisions
- **PII**: Vendor contact names, email addresses, phone numbers

**Data Residency**: All data must remain within Australia (regulatory requirement)

**Knowledge Base Requirements**:
- **Supplier-specific rules**: 200+ undocumented rules (e.g., "Supplier X always ships 2% over")
- **Approval thresholds**: 5 different workflows based on amount and risk
- **Historical patterns**: Need to learn from 2 years of exception resolution history
- **Contract terms**: Extract acceptable variance clauses from PDF contracts

**Vector Database Needs**:
- Semantic search across email history to find similar past exceptions
- Contract clause retrieval for variance acceptance rules
- Supplier communication pattern analysis

## Model & AI Infrastructure

**Current AI/ML Experience**: Limited
- No production AI/ML models currently deployed
- Previous chatbot pilot used Azure Bot Framework (failed due to poor accuracy)
- IT team has basic understanding of AI concepts but no hands-on experience
- No MLOps practices or infrastructure

**Foundation Model Requirements**:

1. **Document Understanding**: Extract data from invoice PDFs and contracts
2. **Email Comprehension**: Understand supplier email intent and context
3. **Reasoning & Decision-Making**: Evaluate whether variance is acceptable based on multiple factors
4. **Email Generation**: Draft professional, contextually appropriate emails
5. **Pattern Recognition**: Learn from historical exception resolutions

**Model Preferences**:
- Prefer AWS-native solutions (Bedrock) to minimize vendor complexity
- Need explainable AI - must be able to explain why agent made a decision
- Require guardrails to prevent inappropriate decisions or communications

**Prompt Engineering**:
- No in-house expertise currently
- Need templates and best practices for agent prompts
- Require ability to refine prompts based on agent performance

**Model Governance Needs**:
- Version control for agent configurations and prompts
- A/B testing capability to compare agent performance
- Rollback capability if agent performance degrades

## Agent Architecture Requirements

**Required Agent Roles**:

1. **Investigator Agent**
   - Analyzes invoice vs GRN discrepancies
   - Searches email history for context
   - Retrieves contract terms and supplier history
   - Determines if variance is within acceptable bounds

2. **Communication Agent**
   - Drafts emails to suppliers requesting clarification
   - Drafts internal emails to procurement team
   - Adjusts tone based on supplier relationship (formal vs casual)
   - Handles follow-up emails if no response received

3. **Decision Agent**
   - Evaluates whether to accept variance, reject invoice, or escalate
   - Considers multiple factors: contract terms, supplier history, item criticality, amount
   - Provides explanation for decision
   - Identifies when human judgment is required

4. **Escalation Agent**
   - Determines escalation criteria (high-value, high-risk, policy violation)
   - Routes to appropriate approver (AP manager, procurement, finance director)
   - Provides full context and recommendation to human reviewer

5. **Learning Agent**
   - Captures patterns from resolved exceptions
   - Updates knowledge base with new supplier-specific rules
   - Identifies process improvement opportunities
   - Monitors agent performance and suggests refinements

**Agent Coordination**:
- Investigator Agent triggers Communication Agent when clarification needed
- Communication Agent waits for supplier response, then triggers Decision Agent
- Decision Agent triggers Escalation Agent when criteria met
- All agents log to Learning Agent for continuous improvement

**Autonomy Boundaries**:
- **Fully autonomous**: Variances <5% for trusted suppliers, standard items
- **Autonomous with notification**: Variances 5-10%, notify AP manager after decision
- **Human-in-the-loop**: Variances >10%, high-value items (>$50K), new suppliers, policy violations

## Security & Identity

**Authentication & Authorization**:
- **Current**: Active Directory for user authentication
- **Required**: 
  - Service accounts for agent access to SAP and Exchange
  - OAuth 2.0 for Microsoft Graph API integration
  - API keys for SAP OData services
  - Role-based access control for agent capabilities

**Secrets Management**:
- Currently stored in configuration files (not secure)
- Need centralized secrets management (AWS Secrets Manager preferred)

**Encryption**:
- **At rest**: All data must be encrypted (AES-256)
- **In transit**: TLS 1.2 minimum for all API calls
- **In use**: Sensitive data (bank accounts, pricing) should be masked in logs

**Network Security**:
- **Current**: On-premise systems behind corporate firewall
- **Required**: 
  - VPN or AWS PrivateLink for secure cloud-to-on-premise connectivity
  - Network segmentation for agent infrastructure
  - Egress controls to prevent data exfiltration

**Audit Logging**:
- All agent actions must be logged with timestamps and user context
- Logs must be immutable and retained for 7 years (compliance)
- Need to log: decision rationale, data accessed, emails sent, escalations

## Observability & Operations

**Current Monitoring**:
- Basic SAP monitoring (system health, database performance)
- Email server monitoring (uptime, queue length)
- No application performance monitoring (APM)
- Manual exception tracking in spreadsheets

**Required Observability**:

1. **Agent Performance Metrics**:
   - Resolution time per exception
   - Autonomous resolution rate
   - Decision accuracy (validated by human review)
   - Escalation rate and reasons
   - Supplier response rate to agent emails

2. **System Health Metrics**:
   - Agent availability and response time
   - API call latency (SAP, Exchange)
   - Model inference time
   - Queue depth for pending exceptions

3. **Business Metrics**:
   - Exceptions resolved per day
   - Cost per exception (token usage)
   - AP team time saved
   - Vendor satisfaction (from surveys)

**Alerting Requirements**:
- Agent failure or degraded performance
- High escalation rate (>30% indicates agent struggling)
- SLA breach risk (exceptions approaching deadline)
- Security incidents (unauthorized access, data anomalies)

**Operational Runbooks**:
- Need documented procedures for common issues
- Escalation path for agent failures
- Rollback procedures if agent performance degrades

## Scalability & Performance

**Current Volumes**:
- 50,000 invoices/month
- 15,000 exceptions/month (30% exception rate)
- 750 exceptions/day average, 1,500/day at month-end peak

**Growth Projections**:
- 20% annual growth in invoice volume
- Expect exception rate to decrease to 20% as agents improve processes

**Performance Targets**:
- **Investigation time**: <5 minutes per exception
- **Email response time**: <2 hours during business hours
- **End-to-end resolution**: <8 hours for 70% of exceptions
- **Concurrent processing**: Handle 100 exceptions simultaneously at peak

**Auto-scaling Requirements**:
- Scale up during month-end peaks (2x capacity)
- Scale down during low-volume periods to control costs
- No experience with auto-scaling, need guidance

**Disaster Recovery**:
- **RTO**: 4 hours (can tolerate brief outage)
- **RPO**: 1 hour (acceptable to re-process recent exceptions)
- Need backup of agent knowledge base and configuration

## Development & Deployment

**Current Practices**:
- **Version Control**: Git (Bitbucket) for custom SAP code
- **CI/CD**: Basic Jenkins pipelines for SAP transports
- **Testing**: Primarily manual UAT, limited automated testing
- **Environments**: Dev, QA, Production (no staging environment)
- **Deployment Frequency**: Monthly releases for SAP changes

**Required for Agentic AI**:

1. **Infrastructure as Code**:
   - No current IaC experience
   - Prefer AWS CDK or CloudFormation
   - Need templates and best practices

2. **Agent Deployment**:
   - Containerized agents (Docker/ECS preferred)
   - Blue-green deployment for zero-downtime updates
   - Ability to roll back agent versions quickly

3. **Testing Strategy**:
   - Unit tests for agent tools and integrations
   - Integration tests with SAP and Exchange (test environments)
   - **Agent evaluation**: Test agent decisions against historical data (2 years of exceptions)
   - A/B testing to compare agent versions

4. **Environment Strategy**:
   - **Dev**: For agent development and prompt engineering
   - **Test**: Integration testing with SAP/Exchange test systems
   - **Staging**: Full production-like environment for UAT
   - **Production**: Live agent processing

5. **Monitoring & Feedback Loop**:
   - Real-time agent performance dashboard
   - Weekly agent performance reviews
   - Monthly agent capability updates based on learnings

## Integration Architecture

**Event-Driven Architecture**:
- **Trigger Events**:
  - Invoice posted in SAP with discrepancy flag → Trigger Investigator Agent
  - Supplier email received → Trigger Communication Agent
  - GRN created → Check for pending invoice exceptions
  - Escalation approved/rejected → Update agent knowledge base

**Message Queue Requirements**:
- Need reliable message queue for agent coordination (SQS preferred)
- Dead letter queue for failed agent tasks
- Priority queue for high-value exceptions

**API Gateway**:
- Centralized API gateway for agent-to-system communication
- Rate limiting to prevent overwhelming SAP/Exchange
- Request/response logging for audit trail

**Data Synchronization**:
- Real-time sync of invoice, PO, GRN data from SAP
- Email sync from Exchange (near real-time, 5-minute polling acceptable)
- Vendor master data sync (daily batch acceptable)

## Additional Technical Details

**SAP API Capabilities**:
- **OData Services Available**:
  - Invoice API: Read invoice headers, line items, status
  - PO API: Read purchase orders, line items, approval status
  - GRN API: Read goods receipts, quantities, dates
  - Vendor API: Read vendor master data, payment terms, contact info
- **Authentication**: OAuth 2.0 with service account credentials
- **Rate Limits**: 1,000 API calls per hour per service account (sufficient for our volume)
- **Response Time**: Average 200ms per API call

**Exchange/Graph API Permissions**:
- **Required Permissions**:
  - Mail.Read: Read emails from shared AP mailbox
  - Mail.Send: Send emails on behalf of AP team
  - Mail.ReadWrite: Mark emails as read, move to folders
- **Authentication**: OAuth 2.0 with application permissions (not delegated)
- **Rate Limits**: 10,000 API calls per 10 minutes (sufficient for our volume)
- **Mailbox**: Shared mailbox (ap@company.com) for all supplier communication

**Network Topology**:
- **On-Premise**:
  - SAP S/4HANA: 10.0.1.0/24 subnet
  - Exchange Server: 10.0.2.0/24 subnet
  - Corporate firewall: Allows outbound HTTPS (443) only
- **AWS**:
  - VPC: 172.16.0.0/16
  - Private subnets: 172.16.1.0/24, 172.16.2.0/24 (agents, Lambda)
  - Public subnets: 172.16.101.0/24, 172.16.102.0/24 (NAT gateways)
- **Connectivity**:
  - AWS Site-to-Site VPN for SAP connectivity
  - Direct internet for Exchange/Office 365 (already cloud-based)
  - No PrivateLink required (Office 365 is public endpoint)

**Existing AWS Account**:
- Have AWS account (created 6 months ago for exploration)
- Currently only using S3 for backups (minimal usage)
- No production workloads on AWS yet
- **Approved Services** (from IT governance):
  - Compute: Lambda, ECS (Fargate preferred)
  - Storage: S3, EFS
  - Database: DynamoDB, RDS (Aurora)
  - AI/ML: Bedrock, SageMaker
  - Networking: VPC, VPN, CloudFront
  - Security: IAM, Secrets Manager, KMS
  - Monitoring: CloudWatch, X-Ray
- **Restricted Services**: EC2 (prefer serverless), Redshift (not needed)

**Data Migration Plan**:
- **Email History** (2 years, ~500K emails):
  - Export from Exchange to PST files (1 week)
  - Convert PST to EML format (automated tool, 2 days)
  - Upload to S3 (1 day)
  - Index in OpenSearch for semantic search (3 days)
  - **Total time**: 2 weeks
  - **Cost**: $500 (storage) + $1,000 (indexing compute)
- **Exception History** (2 years, ~360K exceptions):
  - Export from SAP to CSV (1 day)
  - Transform and load to DynamoDB (2 days)
  - **Total time**: 3 days
  - **Cost**: $200 (storage)
- **Invoice PDFs** (7 years, ~4.2M invoices):
  - Already in NAS, migrate to S3 over 4 weeks (bandwidth limited)
  - Use S3 Transfer Acceleration for faster upload
  - **Cost**: $10,000 (storage) + $2,000 (transfer)

**Token Cost Modeling** (Detailed):
- **Per Exception Investigation**:
  - Read invoice/PO/GRN data: 500 tokens (structured data)
  - Search email history: 2,000 tokens (semantic search + context)
  - Retrieve contract terms: 1,500 tokens (PDF extraction)
  - Decision reasoning: 2,500 tokens (multi-step reasoning)
  - Email generation: 1,000 tokens (draft + refinement)
  - **Total per exception**: 7,500 tokens average
- **Monthly Volume**:
  - 15,000 exceptions × 7,500 tokens = 112.5M tokens
  - Bedrock Nova Pro pricing: $0.008 per 1K input tokens, $0.032 per 1K output tokens
  - Assume 70% input, 30% output: (112.5M × 0.7 × $0.008) + (112.5M × 0.3 × $0.032) = $630 + $1,080 = $1,710/month
  - **Annual token cost**: $20,520
- **Knowledge Base Retrieval**:
  - 15,000 queries × $0.10 per query = $1,500/month
  - **Annual cost**: $18,000
- **Total AI/ML Cost**: $38,520/year (vs $60,000 budgeted, good buffer)

**Backup SAP Access**:
- If agents fail, AP team can continue manual processing
- SAP GUI and Fiori interfaces remain available
- Email access via Outlook (not affected by agent failure)
- Spreadsheet tracking can be resumed if needed
- **Downtime tolerance**: 4 hours (can catch up on backlog)

**Email Sending Limits**:
- **Exchange Online**: 10,000 emails per day per mailbox
- **Current volume**: 15,000 exceptions/month = 500/day average, 1,000/day peak
- **Agent email volume**: ~30% of exceptions require email (150/day average, 300/day peak)
- **Conclusion**: Well within limits, no throttling concerns

**Contract Parsing Complexity**:
- **Contract formats**: 80% PDF (scanned), 20% Word (digital)
- **OCR quality**: Variable (70-95% accuracy depending on scan quality)
- **Structure**: Semi-structured (standard clauses but varied formatting)
- **Key clauses to extract**:
  - Acceptable variance thresholds (e.g., "±5% quantity variance allowed")
  - Payment terms (e.g., "Net 30 days, 2% discount if paid within 10 days")
  - Delivery terms (e.g., "FOB, partial deliveries allowed")
- **Approach**: Use Bedrock Data Automation with custom blueprint for contract extraction
- **Fallback**: If confidence <70%, escalate to human for manual review

**Supplier Notification Requirements**:
- **Legal review**: Required before sending AI disclosure emails (2 weeks, $5K legal fees)
- **Privacy laws**: Australian Privacy Act requires disclosure of automated decision-making
- **Recommendation**: Transparent disclosure to all suppliers
- **Opt-out**: Suppliers can request human-only communication (estimated <5%, ~10 suppliers)
- **Implementation**: Flag in vendor master data, agents skip these suppliers

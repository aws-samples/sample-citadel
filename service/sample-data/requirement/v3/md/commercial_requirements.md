# Commercial & Economic Requirements - Intelligent Invoice Exception Resolution

## Budget & Investment

**Total Budget Allocated**: $850,000 AUD over 18 months

**Budget Breakdown**:

| Category | Amount | Justification |
|----------|--------|---------------|
| **AWS Infrastructure** | $180,000 | Bedrock agents, Lambda, S3, DynamoDB, OpenSearch (18 months) |
| **Professional Services** | $320,000 | AWS ProServ for architecture and implementation (6 months) |
| **Integration Development** | $150,000 | SAP and Exchange integration, custom tools (4 months) |
| **Change Management** | $80,000 | Training, communication, pilot program (6 months) |
| **Contingency** | $120,000 | Risk buffer (14% of total budget) |

**Budget Approval Status**: 
- Approved by CFO and Finance Committee in Q4 2024
- Board-level approval obtained (required for >$500K initiatives)
- Budget authority delegated to CFO for execution

**Multi-Year Investment**:
- **Year 1** (Months 1-18): $850K development and implementation
- **Year 2**: $180K operational costs (AWS infrastructure, support)
- **Year 3+**: $150K/year (reduced as team gains expertise)

**Funding Source**:
- **CapEx**: $650K (infrastructure, professional services, integration)
- **OpEx**: $200K (change management, training, ongoing support)
- Transition to full OpEx in Year 2 (cloud operational costs)

**Contingency Allocation**:
- $120K (14%) reserved for unexpected costs
- Requires CFO approval to access contingency funds
- Typical usage: scope changes, extended testing, additional training

## Cost Modeling & Estimation

**Cost Estimation Methodology**:
- AWS Professional Services provided initial estimates based on similar implementations
- Benchmarked against Gartner research on AI automation projects
- Added 20% buffer for uncertainty (first agentic AI project)

**Understanding of AI/ML Cost Drivers**:

**Current Understanding** (Limited):
- Aware that AI models charge per token/API call
- Understand storage costs for documents and data
- Know compute costs vary by model size and complexity

**Uncertainties**:
- **Token consumption rates**: How many tokens per exception investigation?
- **Model selection impact**: Cost difference between Nova vs Claude models?
- **Development vs production**: How much higher are production costs?
- **Email processing**: Token costs for reading/writing emails?
- **Knowledge base**: Cost of vector storage and semantic search?

**Estimated Token Consumption** (Rough estimates, need validation):
- **Per exception investigation**: 5,000-10,000 tokens
  - Read invoice, PO, GRN data: 1,000 tokens
  - Search email history: 2,000 tokens
  - Retrieve contract terms: 1,000 tokens
  - Decision reasoning: 2,000 tokens
  - Email generation: 1,000 tokens
- **Monthly volume**: 15,000 exceptions × 7,500 tokens avg = 112.5M tokens
- **Estimated cost**: $0.003 per 1K tokens = $337.50/month (seems too low?)

**Infrastructure Cost Projections** (18 months):

| Service | Monthly Cost | 18-Month Total | Notes |
|---------|--------------|----------------|-------|
| **Bedrock (Nova Pro)** | $5,000 | $90,000 | Token-based pricing, estimated |
| **Bedrock Knowledge Base** | $2,000 | $36,000 | Vector storage + retrieval |
| **Lambda Functions** | $1,500 | $27,000 | Agent orchestration, integrations |
| **S3 Storage** | $500 | $9,000 | Documents, logs, artifacts |
| **DynamoDB** | $800 | $14,400 | Session state, audit logs |
| **OpenSearch** | $1,200 | $21,600 | Email search, pattern analysis |
| **Data Transfer** | $500 | $9,000 | SAP/Exchange integration |
| **CloudWatch/X-Ray** | $300 | $5,400 | Monitoring, logging, tracing |
| **Secrets Manager** | $100 | $1,800 | API keys, credentials |
| **VPN/PrivateLink** | $600 | $10,800 | Secure connectivity to on-premise |
| **Total** | **$12,500** | **$225,000** | Includes 25% buffer |

**Note**: Allocated $180K in budget, may need to optimize or access contingency

**Licensing & Subscription Costs**:
- **SAP OData API**: Included in existing SAP license (no additional cost)
- **Microsoft Graph API**: Included in Office 365 E3 license (no additional cost)
- **AWS Support**: Business Support plan ($100/month minimum, likely higher)
- **Third-party tools**: None planned (using AWS-native services)

**Professional Services Budget**:
- **AWS ProServ**: $320K for 6 months (2 architects, 1 ML specialist)
  - Architecture design: 4 weeks
  - Agent development: 12 weeks
  - Integration implementation: 8 weeks
  - Testing and optimization: 4 weeks
  - Knowledge transfer: 4 weeks

**Hidden/Overlooked Costs**:
- **Data migration**: Moving 2 years of email history to S3 (not budgeted)
- **SAP test environment**: May need dedicated test instance for integration testing
- **Increased Exchange API usage**: Potential licensing implications for high-volume API calls
- **Supplier communication**: Potential need to notify suppliers about AI (legal review costs)
- **Insurance**: AI-specific liability insurance (not yet priced)

## Operational Costs & Sustainability

**Ongoing Operational Costs** (Year 2 onwards, annual):

| Category | Annual Cost | Notes |
|----------|-------------|-------|
| **AWS Infrastructure** | $120,000 | Reduced from Year 1 as we optimize |
| **AWS Support** | $15,000 | Business Support plan |
| **Monitoring & Observability** | $10,000 | CloudWatch, third-party APM tools |
| **Agent Maintenance** | $25,000 | Prompt refinements, capability updates |
| **Training & Upskilling** | $20,000 | Ongoing AP team training |
| **Compliance & Audit** | $15,000 | Quarterly audits, bias assessments |
| **Contingency** | $15,000 | 10% buffer for unexpected costs |
| **Total** | **$220,000** | Decreases to $150K in Year 3 |

**Model Inference Volume Estimates**:
- **Exceptions per month**: 15,000 (current), decreasing to 10,000 (Year 2) as agents improve processes
- **Tokens per exception**: 7,500 average (investigation + communication + decision)
- **Monthly token volume**: 75M tokens (Year 2, reduced from 112.5M)
- **Annual token cost**: $2,700 (seems low, need validation)

**Data Storage Costs**:
- **Invoice PDFs**: 50,000/month × 500KB avg = 25GB/month = 300GB/year
- **Email archives**: 2 years historical + ongoing = 500GB total
- **Agent logs**: 100MB/day × 365 days = 36GB/year
- **Vector embeddings**: 500K documents × 1KB avg = 500MB
- **Total S3 storage**: ~1TB, cost ~$25/month ($300/year)

**Data Transfer Costs**:
- **SAP integration**: 15,000 exceptions × 10KB data = 150MB/month (negligible)
- **Exchange integration**: 15,000 emails × 50KB avg = 750MB/month (negligible)
- **Egress to on-premise**: Minimal (mostly API calls, not large data transfers)
- **Estimated**: $500/month ($6,000/year)

**Cost Optimization Strategies**:

1. **FinOps Practices** (Planned):
   - Monthly cost review meetings with IT and Finance
   - Tag all resources by project and cost center
   - Set up AWS Cost Anomaly Detection alerts
   - Quarterly optimization reviews (right-sizing, reserved capacity)

2. **Specific Optimizations**:
   - Use S3 Intelligent-Tiering for document storage (30% savings)
   - Implement Lambda reserved concurrency for predictable workloads
   - Use Bedrock batch inference for non-urgent exceptions (lower cost)
   - Archive old logs to S3 Glacier after 90 days (80% savings)
   - Optimize token usage through prompt engineering (target 20% reduction)

3. **Cost Controls**:
   - Set AWS Budget alerts at 80%, 90%, 100% of monthly budget
   - Implement resource tagging policy for cost allocation
   - Monthly cost reports to CFO and project sponsor
   - Quarterly cost optimization reviews

**Long-Term Sustainability**:
- **Year 1**: High costs due to development and learning
- **Year 2**: Costs stabilize as we optimize and reduce exception volume
- **Year 3+**: Costs decrease as team expertise grows and exception rate drops to 20%
- **Break-even**: Month 24 (cumulative savings exceed cumulative costs)

## Return on Investment (ROI)

**Expected ROI**: 185% over 3 years  
**Payback Period**: 24 months

**ROI Calculation Methodology**:
- **Total Investment**: $850K (Year 1) + $220K (Year 2) + $150K (Year 3) = $1,220K
- **Total Benefits**: $2,260K over 3 years (see breakdown below)
- **Net Benefit**: $2,260K - $1,220K = $1,040K
- **ROI**: ($1,040K / $1,220K) × 100% = 85% (conservative estimate)

**Quantifiable Benefits**:

1. **Labor Cost Savings** (Primary benefit)
   - **Current state**: 15 AP clerks × $80K avg salary = $1,200K/year
   - **Future state**: 9 AP clerks (6 FTE reduction) = $720K/year
   - **Annual savings**: $480K
   - **3-year savings**: $1,440K
   - **Assumption**: 40% workload reduction, 6 FTE redeployed to strategic vendor management

2. **Faster Exception Resolution** (Working capital benefit)
   - **Current**: 3-4 days average resolution time
   - **Future**: 8 hours average resolution time
   - **Benefit**: Faster payment processing improves cash flow management
   - **Value**: $50K/year (reduced borrowing costs, better cash forecasting)
   - **3-year value**: $150K

3. **Improved Supplier Relationships** (Discount capture)
   - **Current**: Miss 40% of early payment discounts due to slow exception resolution
   - **Future**: Capture 80% of early payment discounts (2% for payment within 10 days)
   - **Annual invoice value**: $60M
   - **Eligible for discount**: $20M (33% of invoices)
   - **Current capture**: $20M × 60% × 2% = $240K
   - **Future capture**: $20M × 80% × 2% = $320K
   - **Annual benefit**: $80K
   - **3-year benefit**: $240K

4. **Reduced Error Correction Costs**
   - **Current**: 6% error rate in manual exception handling = 900 errors/month
   - **Error correction cost**: $100/error (staff time, supplier communication, rework)
   - **Current cost**: 900 × $100 × 12 = $1,080K/year
   - **Future**: 1% error rate with agent processing = 150 errors/month
   - **Future cost**: 150 × $100 × 12 = $180K/year
   - **Annual savings**: $900K (seems high, need validation)
   - **Conservative estimate**: $150K/year (assuming 50% error reduction)
   - **3-year savings**: $450K

**Total Quantifiable Benefits**: $1,440K + $150K + $240K + $450K = $2,280K over 3 years

**Qualitative Benefits** (Not included in ROI calculation):

1. **Improved Vendor Satisfaction**
   - Faster, more professional communication
   - Consistent decision-making
   - Reduced payment delays
   - **Value**: Difficult to quantify, but improves negotiating position

2. **Enhanced Compliance & Audit Readiness**
   - Complete audit trail for all decisions
   - Explainable AI decisions
   - Reduced audit findings
   - **Value**: Reduced audit costs, lower compliance risk

3. **Employee Satisfaction**
   - AP team shifts from repetitive work to strategic vendor management
   - Reduced frustration with manual follow-ups
   - Career development opportunities (agent supervision skills)
   - **Value**: Reduced turnover, improved morale

4. **Competitive Advantage**
   - Early adopter of agentic AI in finance operations
   - Demonstrates innovation to customers and partners
   - Attracts top talent interested in AI
   - **Value**: Reputational benefit, talent acquisition

5. **Scalability**
   - Can handle invoice volume growth without proportional headcount increase
   - 20% annual growth in invoices absorbed by agents
   - **Value**: Avoided future hiring costs

**ROI Measurement & Tracking**:
- **Monthly**: Track exception resolution time, autonomous resolution rate, error rate
- **Quarterly**: Calculate cumulative cost savings vs investment
- **Annually**: Comprehensive ROI review with CFO and steering committee
- **Dashboard**: Real-time ROI tracking dashboard for stakeholders

**Sensitivity Analysis**:

| Scenario | Assumption Change | ROI Impact |
|----------|-------------------|------------|
| **Pessimistic** | Only 4 FTE reduction (not 6) | ROI drops to 45% |
| **Realistic** | 6 FTE reduction, 50% error reduction | ROI = 85% (base case) |
| **Optimistic** | 7 FTE reduction, 60% error reduction | ROI increases to 125% |

**Risk Scenarios**:
- **Agent underperforms**: If autonomous resolution rate is only 50% (not 70%), ROI drops to 35%
- **Higher AWS costs**: If infrastructure costs are 50% higher than estimated, ROI drops to 65%
- **Delayed implementation**: Each 3-month delay reduces 3-year ROI by 10%

## Resource Allocation

**Project Team Composition**:

| Role | FTE | Duration | Cost | Notes |
|------|-----|----------|------|-------|
| **Project Manager** | 1.0 | 12 months | $150K | Internal resource, experienced with IT projects |
| **Business Analyst** | 1.0 | 6 months | $90K | Document requirements, UAT coordination |
| **Solution Architect** | 0.5 | 12 months | $100K | Internal IT architect, 50% allocation |
| **Integration Developer** | 2.0 | 6 months | $180K | SAP and Exchange integration specialists |
| **QA/Test Lead** | 1.0 | 4 months | $60K | Test planning, execution, automation |
| **Change Manager** | 0.5 | 12 months | $75K | Training, communication, adoption |
| **AP Subject Matter Expert** | 0.3 | 12 months | $36K | Domain expertise, 30% allocation |
| **AWS ProServ** | 3.0 | 6 months | $320K | External consultants (included in budget) |

**Total Internal Resources**: 6.3 FTE (blended across 12 months)  
**Total External Resources**: 3.0 FTE (AWS ProServ for 6 months)

**Resource Availability**:
- **Project Manager**: Dedicated 100%, no competing priorities
- **Business Analyst**: Dedicated 100% for 6 months
- **Solution Architect**: 50% allocation, also supporting CRM upgrade project
- **Integration Developers**: Contractors hired specifically for this project
- **QA/Test Lead**: Dedicated during testing phase (months 7-10)
- **Change Manager**: 50% allocation, also supporting other change initiatives
- **AP SME**: 30% allocation, continues normal AP duties

**Competing Priorities**:
- **CRM Upgrade Project**: Shares solution architect (30% capacity conflict)
- **Month-End Close**: AP SME availability reduced during month-end (5 days/month)
- **Annual Audit**: QA lead may be pulled for audit support (2 weeks in Q2)

**Mitigation for Resource Conflicts**:
- Hire additional contractor if solution architect capacity becomes critical
- Schedule intensive work phases outside month-end periods
- Build buffer into timeline for audit season

**Backfill Plans**:
- **AP SME**: Temporary contractor to cover 30% of normal duties ($30K)
- **Solution Architect**: No backfill, other projects absorb 50% capacity
- **Change Manager**: No backfill, other change initiatives slightly delayed

**Ramp-Up Plan**:
- **Months 1-2**: Core team (PM, BA, Architect) + AWS ProServ onboarding
- **Months 3-6**: Full team including developers and QA
- **Months 7-10**: Testing phase, reduced development team
- **Months 11-12**: Pilot and rollout, change management focus

**Ramp-Down Plan**:
- **Month 10**: Developers roll off after integration complete
- **Month 11**: QA lead rolls off after UAT complete
- **Month 12**: AWS ProServ knowledge transfer complete
- **Month 13+**: Ongoing support by internal team (0.5 FTE)

## Cost-Benefit Analysis

**Current State Costs** (Annual):

| Category | Annual Cost | Notes |
|----------|-------------|-------|
| **AP Team Salaries** | $1,200K | 15 FTE × $80K average |
| **ERP Licenses** | $80K | SAP user licenses for AP team |
| **Infrastructure** | $120K | On-premise servers, storage, network |
| **Error Correction** | $300K | Rework, supplier disputes, audit findings |
| **Late Payment Penalties** | $50K | Missed payment deadlines |
| **Missed Discounts** | $80K | Early payment discounts not captured |
| **Total** | **$1,830K/year** | Baseline operational cost |

**Future State Costs** (Annual, Year 2 onwards):

| Category | Annual Cost | Notes |
|----------|-------------|-------|
| **AP Team Salaries** | $720K | 9 FTE × $80K average |
| **ERP Licenses** | $48K | Reduced licenses (9 users) |
| **AWS Infrastructure** | $120K | Cloud operational costs |
| **Agent Maintenance** | $25K | Prompt updates, capability enhancements |
| **Support & Training** | $20K | Ongoing training and support |
| **Error Correction** | $180K | Reduced error rate |
| **Late Payment Penalties** | $10K | Faster resolution reduces penalties |
| **Missed Discounts** | $0K | Capture 80% of discounts |
| **Total** | **$1,123K/year** | 39% reduction from current state |

**Net Annual Savings**: $1,830K - $1,123K = $707K/year (Year 2 onwards)

**Efficiency Gains**:
- **Exception resolution time**: 3-4 days → 8 hours (80% reduction)
- **Autonomous resolution**: 0% → 70% (reduces manual workload)
- **Error rate**: 6% → 1% (83% reduction)
- **AP team capacity**: 40% freed for strategic work

**Productivity Improvements**:
- **AP clerks**: Shift from transactional work to strategic vendor relationship management
- **Procurement team**: Better visibility into exception patterns for contract negotiations
- **Finance team**: Faster month-end close due to reduced open exceptions

**Time Savings**:
- **Per exception**: 3-4 days → 8 hours (saves 2.5 days per exception)
- **Monthly time saved**: 15,000 exceptions × 70% autonomous × 2.5 days = 26,250 days
- **Equivalent FTE**: 26,250 days / 220 working days = 119 FTE-days/month = 6 FTE

**Customer Experience** (Supplier perspective):
- **Faster responses**: 2-hour email response time (vs 1-2 days currently)
- **Professional communication**: Consistent, well-written emails
- **Predictable resolution**: Clear timelines and expectations
- **Improved satisfaction**: Target 85/100 (from 72/100 currently)

**Risk Reduction**:
- **Compliance risk**: Complete audit trail reduces audit findings
- **Financial risk**: Lower error rate reduces overpayments
- **Relationship risk**: Faster, more professional communication improves vendor relationships

## Financial Governance & Controls

**Budget Tracking & Reporting**:
- **Frequency**: Monthly budget vs actual reports to CFO and project sponsor
- **Tool**: Project accounting in SAP (dedicated cost center)
- **Variance Analysis**: Investigate any variance >10%
- **Forecast**: Rolling 3-month forecast updated monthly

**Approval Thresholds**:
- **<$10K**: Project Manager approval
- **$10K-$50K**: CFO approval
- **>$50K**: CFO + Finance Committee approval
- **Contingency access**: CFO approval required

**Escalation Paths**:
- **Budget variance >10%**: Escalate to CFO within 5 business days
- **Scope change impacting budget**: Escalate to steering committee
- **Risk to timeline/budget**: Escalate to project sponsor immediately

**Cost Allocation Model**:
- **Development costs**: Allocated to Finance department (100%)
- **Ongoing operational costs**: Allocated to Finance department (80%), IT department (20%)
- **Chargeback**: Not planned initially, may implement in Year 2 if other departments adopt agents

**Financial Audit Requirements**:
- **Internal audit**: Quarterly review of project spending
- **External audit**: Annual financial statement audit includes project costs
- **Compliance**: All spending must comply with procurement policies

**Budget Flexibility**:
- **Contingency**: $120K available for approved scope changes
- **Reallocation**: Can reallocate up to 10% between budget categories with CFO approval
- **Additional funding**: Requires business case and Finance Committee approval

**Cost Optimization Governance**:
- **Monthly reviews**: IT and Finance review AWS costs and optimization opportunities
- **Quarterly targets**: 5% cost reduction target each quarter (Year 2 onwards)
- **FinOps team**: Establish FinOps practice in IT department (Year 2)

## Economic Viability & Market Factors

**Market Conditions**:
- **Economic outlook**: Moderate growth expected in Australia (2-3% GDP growth)
- **Interest rates**: Elevated but stabilizing (impacts working capital costs)
- **Labor market**: Tight labor market, difficult to hire skilled AP staff
- **Technology trends**: Rapid adoption of AI in finance operations

**Competitive Pressure**:
- **Urgency**: Medium - competitors are exploring AI, but no one has deployed at scale yet
- **First-mover advantage**: Opportunity to differentiate and attract top talent
- **Risk of delay**: If we wait 2 years, competitors may have mature AI capabilities

**Opportunity Cost of Not Transforming**:
- **Continued high operational costs**: $1,830K/year vs $1,123K/year (future state)
- **Lost efficiency**: 40% of AP team capacity remains on manual work
- **Talent retention**: Risk losing younger staff who want to work with AI
- **Competitive disadvantage**: Fall behind competitors in operational efficiency

**Alternative Investment Options Considered**:

1. **Traditional RPA** (Rejected)
   - **Cost**: $300K implementation + $50K/year operational
   - **Benefit**: 20% efficiency gain (vs 40% with agentic AI)
   - **Limitation**: Cannot handle exceptions requiring judgment
   - **Decision**: Insufficient ROI, doesn't solve core problem

2. **Hire More AP Staff** (Rejected)
   - **Cost**: 5 additional FTE × $80K = $400K/year
   - **Benefit**: Faster exception resolution through more manual effort
   - **Limitation**: Doesn't improve efficiency, scales linearly
   - **Decision**: Not sustainable, doesn't address root cause

3. **Outsource AP Function** (Rejected)
   - **Cost**: $1,200K/year (outsourcing provider quote)
   - **Benefit**: Transfer operational burden
   - **Limitation**: Loss of control, data security concerns, no innovation
   - **Decision**: Doesn't align with digital transformation strategy

4. **Do Nothing** (Rejected)
   - **Cost**: $0 upfront, but $1,830K/year ongoing
   - **Benefit**: No change management risk
   - **Limitation**: Continued inefficiency, competitive disadvantage
   - **Decision**: Not viable given strategic objectives

**Economic Sensitivity**:
- **Recession scenario**: If invoice volume drops 20%, still achieve positive ROI (reduced to 45%)
- **Inflation scenario**: If labor costs increase 10%, ROI improves (higher savings from FTE reduction)
- **Interest rate scenario**: If rates increase, working capital benefit increases (faster resolution more valuable)

**Long-Term Strategic Value**:
- **Platform for future AI**: Establishes foundation for AI in other finance processes (expense management, contract analysis)
- **Organizational learning**: Builds AI capability and culture
- **Talent attraction**: Positions organization as innovative employer
- **Vendor relationships**: Improved relationships enable better contract negotiations
- **Scalability**: Can handle 50% invoice growth without proportional cost increase

**Break-Even Analysis**:
- **Cumulative investment**: $850K (Year 1) + $220K (Year 2) = $1,070K
- **Cumulative savings**: $0 (Year 1) + $707K (Year 2) = $707K
- **Break-even**: Month 24 (Year 2, Month 6)
- **Sensitivity**: If savings are 20% lower, break-even extends to Month 30

## Additional Commercial Details

**Detailed Token Cost Modeling**:
- **Per Exception Investigation** (7,500 tokens average):
  - Read invoice/PO/GRN data: 500 tokens (structured data)
  - Search email history: 2,000 tokens (semantic search + context)
  - Retrieve contract terms: 1,500 tokens (PDF extraction)
  - Decision reasoning: 2,500 tokens (multi-step reasoning)
  - Email generation: 1,000 tokens (draft + refinement)
- **Monthly Volume**:
  - 15,000 exceptions × 7,500 tokens = 112.5M tokens
  - Bedrock Nova Pro pricing: $0.008 per 1K input tokens, $0.032 per 1K output tokens
  - Assume 70% input, 30% output: (112.5M × 0.7 × $0.008) + (112.5M × 0.3 × $0.032) = $630 + $1,080 = $1,710/month
  - **Annual token cost**: $20,520
- **Knowledge Base Retrieval**:
  - 15,000 queries × $0.10 per query = $1,500/month
  - **Annual cost**: $18,000
- **Total AI/ML Cost**: $38,520/year (vs $60,000 budgeted, 36% buffer)
- **Validation**: AWS ProServ confirmed estimates are reasonable based on similar implementations

**AWS Pricing Optimization**:
- **Compute Savings Plans**: Not applicable (serverless Lambda and Bedrock usage)
- **Reserved Capacity**: Not available for Bedrock (pay-per-use only)
- **Volume Discounts**: Bedrock pricing tiers (>100M tokens/month gets 10% discount)
  - Current volume: 112.5M tokens/month (just above threshold)
  - **Estimated discount**: $2,000/year
- **S3 Intelligent-Tiering**: Automatic cost optimization for document storage
  - **Estimated savings**: 30% on storage costs ($3,000/year)
- **DynamoDB On-Demand**: Pay-per-request pricing (no reserved capacity needed)
- **Total Optimization**: ~$5,000/year savings (included in budget estimates)

**SAP API Licensing**:
- **Confirmed with SAP**: OData API usage included in existing S/4HANA license
- **No additional costs** for high-volume API usage (up to 10,000 calls/hour)
- **Current usage**: ~1,000 calls/hour (well within limits)
- **Future growth**: Can scale to 5x volume before hitting limits

**Exchange API Limits**:
- **Microsoft Graph API**: Included in Office 365 E3 license (no additional cost)
- **Rate Limits**: 10,000 API calls per 10 minutes (sufficient for our volume)
- **Current usage**: ~300 calls/day (well within limits)
- **Throttling**: No throttling concerns at current or projected volumes
- **Cost Impact**: $0 (no additional licensing required)

**Data Migration Costs**:
- **Email History** (2 years, ~500K emails):
  - Export and conversion: $1,000 (automated tools)
  - S3 storage: $500/year
  - OpenSearch indexing: $1,000 (one-time)
  - **Total**: $2,500
- **Exception History** (2 years, ~360K exceptions):
  - Export and transformation: $500 (automated scripts)
  - DynamoDB storage: $200/year
  - **Total**: $700
- **Invoice PDFs** (7 years, ~4.2M invoices):
  - S3 storage: $10,000/year
  - Transfer costs: $2,000 (one-time)
  - **Total**: $12,000
- **Grand Total**: $15,200 (included in $180K infrastructure budget)

**Insurance Pricing**:
- **Cyber Insurance**: Existing $5M policy covers AI-related incidents (no additional cost)
- **AI-Specific Liability**: Quoted $15K/year for $2M coverage
  - Covers errors in autonomous decisions
  - Covers data breaches from AI systems
  - Covers reputational harm from AI failures
- **Professional Liability**: Existing $10M policy covers automated financial decisions (no additional cost)
- **Total Additional Insurance**: $15K/year (not in original budget, will use contingency)

**Redeployment Costs**:
- **6 FTE Redeployment** (from AP clerk to strategic roles):
  - **Training**: $5K per person × 6 = $30K
    - Strategic vendor management (2-week course)
    - Contract negotiation skills (1-week course)
    - Data analysis and reporting (1-week course)
  - **Productivity Ramp**: 3-month learning curve (50% productivity)
    - Lost productivity: 6 FTE × 3 months × 50% × $80K/12 = $60K
  - **Salary Increases**: $10K per person × 6 = $60K/year (agent supervisor premium)
  - **Total Redeployment Cost**: $150K (Year 1), $60K/year ongoing
  - **Note**: Included in labor cost savings calculation (9 FTE at higher salary vs 15 FTE at current salary)

**Supplier Notification Costs**:
- **Legal Review**: $5K (2 weeks of legal counsel time)
  - Review Australian Privacy Act requirements
  - Draft supplier notification email
  - Review contract clause updates
- **Communication**: $2K
  - Email campaign to 200 suppliers
  - Website updates
  - FAQ document creation
- **Opt-Out Management**: $1K/year
  - Flag opt-out suppliers in vendor master data
  - Quarterly review and outreach
- **Total**: $8K (one-time), $1K/year ongoing (included in change management budget)

**Ongoing Model Costs**:
- **Bedrock Pricing Stability**: AWS has committed to stable pricing for 12 months (confirmed)
- **Expected Changes**:
  - **Year 1**: Current pricing ($0.008/$0.032 per 1K tokens)
  - **Year 2**: Potential 10-20% decrease (historical trend for AI services)
  - **Year 3**: Potential 20-30% decrease (continued commoditization)
- **Risk Mitigation**:
  - Budget includes 25% buffer for price increases
  - Can switch to alternative models (Claude, Llama) if pricing changes significantly
  - Monitor AWS pricing announcements quarterly
- **Upside Scenario**: If prices decrease 20% by Year 3, save $8K/year

**Scale Economics**:
- **Expansion to Other Finance Processes**:
  - **Expense Management**: 10,000 expense reports/month, similar exception rate
    - Incremental cost: $15K/year (shared infrastructure)
    - Incremental savings: $200K/year (2 FTE reduction)
    - **Incremental ROI**: 1,233%
  - **Contract Analysis**: 500 contracts/year, manual review takes 4 hours each
    - Incremental cost: $10K/year
    - Incremental savings: $150K/year (1 FTE reduction)
    - **Incremental ROI**: 1,400%
  - **Vendor Onboarding**: 50 new vendors/year, manual process takes 8 hours each
    - Incremental cost: $5K/year
    - Incremental savings: $30K/year (0.5 FTE reduction)
    - **Incremental ROI**: 500%
- **Platform Benefits**:
  - Shared infrastructure (S3, DynamoDB, Bedrock) reduces marginal cost
  - Reusable agent patterns and tools accelerate development
  - Organizational AI capability enables faster future implementations
- **3-Year Expansion Plan**:
  - **Year 1**: Invoice exception handling (current project)
  - **Year 2**: Expense management (high ROI, similar process)
  - **Year 3**: Contract analysis (strategic value, moderate ROI)
- **Cumulative ROI** (3 processes over 3 years): 350% (vs 85% for invoice processing alone)

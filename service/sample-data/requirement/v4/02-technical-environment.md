# Technical Environment — AP Invoice Processing
## GlobalBuild Materials Pty Ltd

### Core Systems

#### ERP — SAP S/4HANA (in migration)
- Current: SAP ECC 6.0 (on-premise, Sydney DC)
- Target: SAP S/4HANA Cloud (migration in progress, go-live Q3 2025)
- AP module: FI-AP with standard 3-way match
- SAP exposes REST APIs via SAP Integration Suite (BTP) — available for both ECC and S/4HANA
- Key AP objects accessible via API: Vendor master, Purchase Orders, Goods Receipts (MIGO), Invoice documents (MIRO), Payment runs

#### Procurement — SAP Ariba
- Used for strategic procurement and PO creation
- ~22% of invoices arrive via Ariba Network (cXML format)
- Ariba is integrated with SAP ECC today; integration with S/4HANA being re-established as part of migration

#### Document Management — SharePoint Online
- Scanned invoices stored in SharePoint (legacy process)
- No structured metadata — invoices stored in date-based folder structure
- ~10% of invoice volume still arrives as physical mail, scanned by receptionist

#### Email — Microsoft 365
- AP inbox: ap.invoices@globalbuild.com.au
- ~2,800 emails/month to AP inbox (invoices + supplier queries + internal comms mixed)
- No automated triage or routing today

#### Banking — ANZ Transactive
- Payment runs executed twice weekly (Tuesday and Thursday)
- ANZ Transactive has API access for payment file upload (ABA format)
- Payment confirmation feeds back to SAP via manual reconciliation today

### Data Landscape

#### Invoice Data
- Structured: Ariba cXML invoices (~22% of volume) — well-structured, high quality
- Semi-structured: PDF invoices via email (~68%) — varying layouts across 340 suppliers
- Unstructured: Scanned paper invoices (~10%) — image quality varies, some handwritten annotations

#### Supplier Master Data
- 340 active suppliers in SAP vendor master
- ~15% have incomplete or outdated bank details
- ABN validation not currently automated
- Supplier portal (Ariba) has more current data for the ~180 suppliers on Ariba

#### Purchase Orders
- All POs created in SAP (via Ariba for strategic procurement, direct SAP entry for operational)
- PO data quality is generally good for construction materials
- Service POs (for non-material purchases) often lack line-item detail — common source of matching failures

#### Goods Receipts
- GRNs entered by warehouse staff in SAP at time of delivery
- ~12% of GRNs are entered late (>2 days after delivery) — major cause of 3-way match failures
- No mobile GRN capability — warehouse staff use desktop terminals

### Integration Architecture

```
Email (M365)          → Manual triage by AP officer → SAP MIRO (manual entry)
Ariba Network (cXML)  → SAP Ariba → SAP ECC (automated, but requires AP review)
SharePoint (scanned)  → Manual retrieval by AP officer → SAP MIRO (manual entry)
```

### AWS Footprint

GlobalBuild has an existing AWS presence:
- **Account structure**: Single AWS account (dev/test/prod in same account, separated by tags — not ideal)
- **Services in use**: S3 (document storage), EC2 (some legacy apps), RDS PostgreSQL (reporting DB), CloudWatch (basic monitoring)
- **No Bedrock usage today**
- **No VPC peering or Direct Connect** — SAP is on-premise, accessed via site-to-site VPN
- **IAM**: Basic IAM setup, no SSO, no AWS Organizations

### Security & Compliance Constraints

- **Data classification**: Invoice data classified as "Confidential — Financial" under GlobalBuild's data policy
- **Encryption**: All financial data must be encrypted at rest (AES-256) and in transit (TLS 1.2+)
- **Network**: SAP on-premise accessible only via VPN. Any agent calling SAP APIs must route through VPN or use SAP BTP as intermediary
- **Credentials**: No secrets in code. SAP API credentials currently stored in a shared spreadsheet (known risk — flagged for remediation)
- **Audit**: All invoice processing actions must be logged with user/system identity, timestamp, and action taken. Retained for 7 years (ATO requirement)
- **Data residency**: All financial data must remain in Australia (ap-southeast-2)

### Known Technical Risks

1. **SAP migration timing**: S/4HANA go-live is Q3 2025. Any automation built on ECC APIs will need to be re-validated post-migration. SAP BTP Integration Suite provides some abstraction but not complete.

2. **PDF invoice variability**: 340 suppliers use different invoice formats. Some use non-standard layouts, some embed data in images within PDFs, some use non-machine-readable PDFs.

3. **GRN latency**: Late GRN entry is a process problem, not a technical one. Automation can detect the missing GRN and route for resolution, but can't fix the underlying behaviour without a mobile GRN solution.

4. **AWS account immaturity**: Single-account setup, no SSO, no IaC. Deploying production AI workloads will require account structure improvements.

5. **Supplier master data quality**: ~15% of supplier records have issues. Automated payment processing requires clean bank details and ABN validation.

# Governance & Compliance Requirements — AP Invoice Processing
## GlobalBuild Materials Pty Ltd

### Regulatory Environment

GlobalBuild operates in the Australian construction and distribution sector. The following regulatory requirements apply to AP invoice processing:

#### Australian Taxation Office (ATO)
- GST compliance: All invoices must be validated as tax invoices under GST Act 1999. Requires supplier ABN, GST amount, and correct tax coding.
- Record retention: All financial records including invoices must be retained for 7 years.
- BAS reporting: AP data feeds into quarterly BAS lodgement. Errors in invoice coding affect BAS accuracy.
- Single Touch Payroll: Not directly relevant to AP but indicates ATO digital reporting direction.

#### ASIC / Corporations Act
- GlobalBuild is a proprietary limited company. Financial records must be maintained in accordance with the Corporations Act 2001.
- Directors have personal liability for financial misstatements — CFO is acutely aware of this.

#### Industry-Specific
- No specific industry regulator for construction materials distribution.
- However, GlobalBuild has several government contracts (state infrastructure projects) that require compliance with NSW Government procurement rules, including audit rights over supplier payments.

### Internal Financial Controls

#### Segregation of Duties
- AP officers can enter invoices but cannot approve payments above $5,000.
- Payment runs require dual authorisation: AP Team Lead + Finance Manager.
- Any invoice from a related party (supplier with a director connection) requires CFO approval regardless of amount.

#### Approval Thresholds
| Invoice Type | Amount | Approver |
|---|---|---|
| PO-backed, matched | Any | Automated (no human approval required if 3-way match passes) |
| PO-backed, exception | Any | AP Team Lead |
| Non-PO | < $500 | Cost centre manager (email approval) |
| Non-PO | $500 – $10,000 | Cost centre manager + Finance Manager |
| Non-PO | > $10,000 | CFO |
| Related party | Any | CFO |

#### Fraud Controls
- Supplier bank detail changes require verification via a callback to the supplier's registered phone number (not email — known BEC fraud vector).
- New supplier onboarding requires ABN verification via ATO ABN Lookup API.
- Duplicate invoice detection is currently manual and acknowledged as a control gap.

### Human-in-the-Loop Requirements

The CFO has been explicit: **agents can recommend and prepare, but humans must authorise payments.**

Specific HITL requirements:
1. **Payment authorisation**: No automated payment execution. Agents can prepare payment files and route for approval, but a human must approve and submit the payment run.
2. **Supplier bank detail changes**: Must be verified by a human via phone callback before any change is applied.
3. **New supplier creation**: Human review required before a new vendor is created in SAP.
4. **Related party invoices**: Always require CFO review — no exceptions.
5. **Invoices > $50,000**: Require Finance Manager review even if 3-way match passes.
6. **Exception resolution involving price variances > 5%**: Require Procurement team involvement.

### Responsible AI Considerations

The CFO and Legal team have reviewed the company's draft AI policy (not yet formally adopted). Key positions:

- **Transparency**: Suppliers interacting with any automated system must be informed they are not speaking with a human. The company does not want to misrepresent AI as human agents.
- **Explainability**: If an invoice is rejected or held, the system must provide a clear, human-readable reason. "System error" is not acceptable.
- **Audit trail**: Every action taken by an AI agent must be logged with the agent identity, timestamp, input data, decision made, and rationale. This is non-negotiable for ATO compliance.
- **Override**: AP officers and managers must be able to override any agent decision. The override must be logged with the human's identity and reason.
- **No autonomous payments**: Reiterated — the company will not allow AI to execute payments without human authorisation in this phase.

### Organisational Readiness

#### Change Appetite
The AP team has mixed feelings. The Team Lead (Sarah Chen) is supportive — she sees automation as a way to focus her team on higher-value exception handling and supplier relationship management. Two of the AP officers are anxious about job security despite the CFO's commitment to no redundancies.

The CFO and COO are strongly supportive and have committed executive sponsorship. The initiative has board visibility as part of the broader digital transformation program.

#### Workforce Transition Plan
- No redundancies. The 3 FTE reduction target is through natural attrition and redeployment.
- Two AP officers have expressed interest in moving into a "Supplier Relationship Manager" role that would be created as part of the transformation.
- Training budget allocated: $30,000 for AP team upskilling on new tools and processes.

#### Support Model
- IT team (3 people) will own the technical infrastructure post-go-live.
- AP Team Lead will own the business process and exception handling rules.
- No dedicated AI/ML capability in-house — will require ongoing vendor/partner support for model updates and tuning.

#### Risk Tolerance
- The company is risk-averse on financial controls. The CFO's position: "I'd rather process invoices slowly and correctly than fast and wrong."
- Acceptable error rate for automated processing: <0.5% of invoice value (i.e., errors should not exceed 0.5% of total invoice value processed per month).
- Any error that results in an incorrect payment must be escalated to the CFO within 24 hours.

#### Rollback Plan
- The current SAP MIRO manual process will be maintained in parallel for the first 3 months post-go-live.
- Rollback trigger: if automated straight-through processing rate drops below 80% or error rate exceeds 0.5% for two consecutive weeks.
- The AP team has committed to maintaining manual processing capability during the parallel run period.

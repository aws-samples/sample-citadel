# Business Overview — Accounts Payable Invoice Processing
## GlobalBuild Materials Pty Ltd

### Company Background

GlobalBuild Materials is a mid-sized Australian construction materials distributor with operations across NSW, VIC, and QLD. Annual revenue of approximately $420M. The company sources materials from ~340 active suppliers and processes invoices through a centralised AP team based in Sydney.

### The AP Team

- 6 full-time AP officers
- 1 AP Team Lead
- Average fully-loaded cost per AP officer: $95,000/year
- Team Lead: $120,000/year

### The Problem

The AP team is overwhelmed. Invoice volumes have grown 40% over the past 3 years following two acquisitions, but headcount has only grown by one person. The team regularly works overtime during month-end close. Three AP officers have resigned in the past 18 months citing repetitive, high-pressure work.

The CFO has flagged AP processing as a priority for improvement after the company incurred $180,000 in late payment penalties last financial year and missed early payment discounts worth an estimated $95,000.

### Current Invoice Volumes

- ~4,200 invoices received per month
- ~3,100 are standard PO-backed invoices (74%)
- ~1,100 are non-PO invoices (26%) — services, utilities, ad-hoc purchases
- Peak periods: end of month (30% above average), end of financial year

### Invoice Sources

- Email (AP inbox): 68% of invoices
- Supplier portal (Ariba): 22% of invoices
- Post / manual scan: 10% of invoices

### Current Process Pain Points

1. **Manual data entry**: AP officers manually key invoice data (supplier, ABN, invoice number, date, line items, GST, total) into SAP. Average 8–12 minutes per invoice for standard invoices, 20–35 minutes for complex or non-PO invoices.

2. **3-way matching failures**: ~18% of PO-backed invoices fail the 3-way match (PO vs goods receipt vs invoice) on first attempt. Common causes: quantity discrepancies, price variances, missing GRNs, wrong PO numbers cited by suppliers.

3. **Exception handling backlog**: Failed matches sit in a queue. Average resolution time is 4.2 days. At any given time, ~380 invoices are in the exception queue.

4. **Approval routing**: Non-PO invoices require manager approval. The routing is manual — AP officers email the relevant manager. Approval SLA is 3 business days but average actual time is 6.8 days. ~15% of approval requests are never responded to and require chasing.

5. **Duplicate invoice risk**: The team has no automated duplicate detection. Two duplicate payments were identified last quarter totalling $47,000. Both were recovered but required significant effort.

6. **Supplier queries**: AP officers spend approximately 35% of their time responding to supplier payment status queries via phone and email.

### Business Impact

- Late payment penalties last FY: $180,000
- Missed early payment discounts last FY: $95,000
- Estimated cost of duplicate payments (annualised): $180,000 (based on last quarter)
- AP officer overtime cost last FY: $68,000
- Staff turnover cost (3 resignations × ~$25,000 recruitment/onboarding): $75,000

**Total quantifiable annual cost of current state: ~$598,000** (excluding base salary cost of manual processing)

### Strategic Context

The CFO and COO are joint sponsors of this initiative. The CFO wants to reduce the cost of AP operations by 40% within 18 months. The COO wants to eliminate the dependency on individual AP officers' knowledge of supplier quirks and exception handling patterns.

The company is mid-way through an ERP consolidation — the acquired businesses are being migrated to SAP S/4HANA by Q3 this year. The AP automation initiative needs to be compatible with the new SAP environment.

### Success Criteria (as stated by CFO)

1. Reduce straight-through processing rate from current ~62% to >90% within 12 months
2. Reduce average invoice processing time from 12 minutes to under 2 minutes for standard invoices
3. Eliminate late payment penalties (target: <$10,000/year)
4. Reduce AP headcount requirement by 3 FTEs through natural attrition (no redundancies)
5. Supplier payment status queries handled without AP officer involvement

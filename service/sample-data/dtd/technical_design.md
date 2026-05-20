# Technical Design

---

## 1. Solution Overview

### What Is Being Built

This document describes the design of an agentic AI system to automate end-to-end Accounts Payable invoice processing for the Finance/Accounts Payable business unit. The system will ingest approximately 4,200 invoices per month arriving via three channels — AP email inbox (68%), Ariba supplier portal (22%), and scanned post (10%) — and orchestrate a multi-agent pipeline that extracts structured data from semi-structured and unstructured invoice documents, executes 3-way matching logic against SAP purchase orders and goods receipt notes (GRNs), applies duplicate detection rules, routes non-PO invoices for manager approval, and posts validated invoices directly to SAP for payment — all with minimal human intervention except at defined exception and approval decision points. The system is designed to raise the straight-through processing (STP) rate from the current 62% to above 90% within 12 months, reduce average processing time for standard invoices from 12 minutes to under 2 minutes, and eliminate the $180,000 in annual late payment penalties and $95,000 in missed early payment discounts that have been directly attributed to processing delays and backlog.

---

### Why Agentic AI, Not RPA or Traditional Automation

Rule-based RPA and traditional workflow automation were considered and rejected as the primary approach for the following reasons:

- **Input variability defeats brittle scripting.** Invoices arrive as PDFs, scanned images, and portal-generated structured data across dozens of supplier formats. Supplier ABNs, line-item layouts, GST presentation, and PO reference placement vary significantly. RPA bots operating on fixed field coordinates or document templates break on format changes and require constant maintenance — a cost that compounds at 4,200 invoices per month.
- **Exception handling requires contextual reasoning, not just branching logic.** Approximately 18% of PO-backed invoices fail 3-way matching on first attempt due to quantity discrepancies, price variances, missing GRNs, or incorrect PO numbers cited by suppliers. Resolving these requires the system to interpret *why* a match failed, determine whether the variance falls within a defined tolerance (e.g., ±5% price variance, ±1 unit quantity tolerance), and decide whether to auto-resolve, query the supplier, or escalate — a sequence of conditional reasoning steps that RPA cannot perform without exhaustive pre-scripted branching.
- **Volume spikes require elastic, stateless processing.** End-of-month and end-of-financial-year peaks drive invoice volumes 30% above average. A fixed RPA bot pool or batch-scheduled automation cannot elastically absorb these spikes without queuing delays — exactly the condition that currently produces the $180,000 in late payment penalties.
- **Agentic AI enables autonomous goal pursuit with human-in-the-loop guardrails.** An agent-based architecture allows each specialised agent (ingestion, extraction, matching, exception handling, approval routing, supplier query) to operate autonomously within its defined scope, pass structured context to downstream agents, and escalate to a human only when confidence thresholds or business rules require it. This is qualitatively different from RPA, which executes a fixed script, and from a large language model used in isolation, which lacks the ability to take actions, maintain state across steps, or interact with SAP and Ariba.

---

### Core Value Proposition

The business case for this system rests on four compounding outcomes:

| Outcome | Current State | Target State |
|---|---|---|
| Straight-through processing rate | 62% | >90% within 12 months |
| Average processing time (standard invoices) | 12 minutes | <2 minutes |
| Annual late payment penalties | $180,000 | <$10,000 |
| AP officer capacity freed for exception work | ~0 FTE headroom | 3 FTE reduction via natural attrition |

Beyond the $598,000 in quantified annual losses (late payment penalties, missed early payment discounts, duplicate payments, and overtime), the agentic system addresses a structural fragility: three AP officers have resigned in the past 18 months, and the team has grown by only one headcount despite a 40% increase in invoice volume over three years. The system eliminates the dependency on individual AP officers for routine processing — a specific mandate from the COO — and creates an auditable, rules-consistent process that satisfies GST/BAS compliance obligations and Corporations Act record-keeping requirements without relying on individual staff knowledge.

---

### Key Assumptions and Constraints

The following assumptions and constraints are foundational to this design and must be actively managed throughout delivery:

1. **SAP API access is partial.** SAP integration will rely on available APIs and, where necessary, structured data exports for PO and GRN retrieval. Full write-back of validated invoices to SAP for payment posting is a dependency that requires IT confirmation of API scope before the production build commences. The POC will operate against a SAP sandbox environment.

2. **ERP migration is in progress.** The business is mid-way through migrating acquired entities to SAP S/4HANA, targeting completion by Q3. The agentic system must be designed to function against both the current SAP instance and S/4HANA, with abstracted integration layers that do not hard-code version-specific field mappings.

3. **Ariba portal is API-accessible.** The 22% of invoices arriving via Ariba are treated as the highest-confidence input channel. Ariba's structured invoice data will be used to validate OCR extraction quality from email and scanned channels during the POC.

4. **Human approval is mandatory for defined decision classes.** Manager approval for all non-PO invoices (3 business day SLA), exception resolution for failed 3-way matches that exceed defined tolerance thresholds, and any flagged duplicate invoice are non-negotiable human-in-the-loop steps. The system will not route these to payment without a recorded human decision.

5. **OCR quality for scanned post (10% of volume) is unproven.** The 10% of invoices arriving via post will require OCR digitisation. Extraction confidence scoring must be implemented, and low-confidence extractions must be routed to human review rather than processed straight-through.

6. **Error detection lag is 90 days.** The business has confirmed that agent errors would trigger an AP department alert after a 90-day cycle. This means the system must implement proactive confidence thresholds, duplicate detection, and variance tolerance rules to prevent errors from entering the payment run — the 90-day lag is not a safety net, it is a compliance risk if the system is misconfigured.

7. **No redundancies.** Headcount reduction of 3 FTEs is to be achieved through natural attrition only. Workforce transition planning is outside the scope of this technical design but is a constraint on the pace of STP rate improvement — AP officers must remain engaged in exception handling and oversight roles throughout the transition.


---

## 2. Agent Definitions

This solution deploys five specialised agents in a sequential pipeline, orchestrated via the Arbiter pattern. Each agent has bounded responsibility, defined decision authority, and explicit escalation triggers. All agents are implemented using the AWS Strands SDK and registered with the central Arbiter orchestrator.

---

### 2.1 Agent Summary Table

| Agent Name | Responsibility | Strands Tools Used | Inputs | Outputs |
|---|---|---|---|---|
| **IngestAgent** | Receive and normalise invoices from all three intake channels; extract structured fields via OCR/parsing | `email_reader`, `ocr_tool`, `ariba_api_connector`, `document_parser` | Raw email attachments (PDF/image), Ariba API payloads, scanned document files | Normalised invoice record: `supplier_name`, `abn`, `invoice_number`, `invoice_date`, `po_number`, `line_items[]`, `gst_amount`, `total_amount`, `source_channel`, `raw_document_ref` |
| **DuplicateDetectionAgent** | Identify duplicate or near-duplicate invoices before any matching or approval work begins | `sap_invoice_lookup`, `fuzzy_match_tool`, `vector_similarity_search` | Normalised invoice record from IngestAgent; SAP historical invoice index | Duplicate status: `UNIQUE`, `PROBABLE_DUPLICATE`, or `CONFIRMED_DUPLICATE`; match evidence record with `matched_invoice_id`, `similarity_score`, `match_fields[]` |
| **MatchingAgent** | Execute 3-way match (PO vs GRN vs invoice); apply tolerance rules; classify match outcome | `sap_po_lookup`, `sap_grn_lookup`, `tolerance_rules_engine` | Normalised invoice record; SAP PO data (`po_number`, `po_line_items[]`, `po_unit_price`, `po_quantity`); SAP GRN data (`grn_number`, `received_quantity`, `receipt_date`) | Match result: `MATCHED`, `WITHIN_TOLERANCE`, `FAILED_MATCH`, or `NO_PO` (non-PO invoice); variance detail record with `variance_type`, `variance_amount`, `variance_pct` |
| **ApprovalRoutingAgent** | Route non-PO invoices and tolerance-breaching exceptions to the correct approver; track SLA; chase non-responses | `sap_cost_centre_lookup`, `approval_workflow_tool`, `notification_service`, `sla_tracker` | Match result (`NO_PO` or `FAILED_MATCH`); normalised invoice record; cost centre ownership data from SAP | Approval task record with `approver_id`, `approver_email`, `routing_reason`, `sla_due_date`; status updates: `PENDING`, `APPROVED`, `REJECTED`, `ESCALATED` |
| **PostingAgent** | Write approved and matched invoices to SAP as posted documents; confirm payment scheduling; update audit log | `sap_invoice_post`, `payment_terms_lookup`, `audit_log_writer` | Approved invoice record (from MatchingAgent or ApprovalRoutingAgent); payment terms from SAP vendor master | SAP document number (`sap_doc_id`), scheduled payment date, early payment discount flag (`epd_eligible`, `epd_deadline`), audit trail entry |

---

### 2.2 Decision Authority per Agent

#### IngestAgent
**Decides autonomously:**
- Channel classification (email vs Ariba vs scanned document)
- OCR confidence threshold acceptance: fields with confidence ≥ 0.85 are accepted without review
- Field normalisation (date format standardisation, ABN formatting, whitespace cleanup)
- Assignment of `source_channel` and `raw_document_ref`

**Escalates to human (AP Officer queue):**
- OCR confidence < 0.85 on any of: `abn`, `invoice_number`, `total_amount`, `gst_amount` — record is flagged `EXTRACTION_REVIEW_REQUIRED` and routed to the AP officer exception queue with the low-confidence fields highlighted
- Document type cannot be classified as an invoice (e.g. statement, remittance advice) — routed with flag `NON_INVOICE_DOCUMENT`
- Missing `po_number` AND missing `supplier_name` simultaneously — insufficient data to proceed

#### DuplicateDetectionAgent
**Decides autonomously:**
- `UNIQUE` classification: similarity score < 0.80 across all candidate matches — invoice proceeds to MatchingAgent
- `PROBABLE_DUPLICATE` classification: similarity score 0.80–0.94 — invoice is held and routed to AP officer queue with match evidence; agent does not block the original invoice
- `CONFIRMED_DUPLICATE` classification: exact match on `invoice_number` + `abn` + `total_amount` — invoice is rejected and supplier notified via `notification_service`; no human action required unless supplier disputes

**Escalates to human (AP Manager):**
- Any `CONFIRMED_DUPLICATE` where `total_amount` > $10,000 — AP Manager receives notification alongside the automated rejection, consistent with the $47,000 duplicate payment risk precedent
- Supplier has had ≥ 3 `PROBABLE_DUPLICATE` flags in a rolling 90-day window — flagged for vendor master review

#### MatchingAgent
**Decides autonomously:**
- `MATCHED`: all three of PO, GRN, and invoice align within zero variance — invoice proceeds directly to PostingAgent
- `WITHIN_TOLERANCE`: quantity variance ≤ 5% AND price variance ≤ 2% AND total variance ≤ $500 — invoice proceeds to PostingAgent with tolerance note recorded in audit log
- `NO_PO`: `po_number` is absent or returns no SAP record — invoice is classified as non-PO and routed to ApprovalRoutingAgent

**Escalates to human (AP Officer exception queue):**
- `FAILED_MATCH`: any variance outside tolerance thresholds — variance detail record is attached; agent does not attempt resolution
- GRN does not exist in SAP for a PO-backed invoice — flagged `GRN_MISSING`; agent queries SAP once with a 24-hour retry before escalating
- PO exists but is fully receipted or closed — flagged `PO_EXHAUSTED`; routed to AP Officer with `po_number` and `po_status`

**Never decides:**
- Overriding a failed 3-way match without human confirmation
- Accepting a price variance > 2% autonomously, regardless of absolute dollar value

#### ApprovalRoutingAgent
**Decides autonomously:**
- Identifies correct approver from SAP cost centre ownership data using `sap_cost_centre_lookup` based on `cost_centre_code` extracted from the invoice or inferred from vendor master
- Sets `sla_due_date` = current date + 3 business days (per documented SLA)
- Sends first-chase notification at T+2 business days if no response received
- Sends second-chase notification at T+3 business days (SLA breach day) to approver and their direct manager
- Marks approval task `ESCALATED` and notifies AP Manager at T+4 business days (addressing the current 15% non-response rate)

**Escalates to AP Manager:**
- Approver cannot be determined from cost centre data — `APPROVER_UNRESOLVABLE` flag
- Invoice `total_amount` > $50,000 — co-approval required; agent routes to both cost centre owner and their manager simultaneously
- Approval SLA breach beyond T+4 business days — AP Manager assumes ownership

**Never decides:**
- Approving or rejecting a non-PO invoice autonomously
- Modifying the approval hierarchy

#### PostingAgent
**Decides autonomously:**
- Writes SAP invoice posting document for all invoices with status `MATCHED`, `WITHIN_TOLERANCE`, or `APPROVED`
- Flags `epd_eligible = true` and sets `epd_deadline` where vendor payment terms include an early payment discount (addressing the $95,000 missed discount problem)
- Schedules payment date per vendor payment terms from SAP vendor master
- Writes structured audit trail entry including `agent_id`, `decision_timestamp`, `match_result`, `sap_doc_id`, `operator_id` (null for straight-through) — satisfying Corporations Act record-keeping and GST/BAS audit requirements

**Escalates to AP Officer:**
- SAP posting API returns an error or non-200 response — invoice is held in `POSTING_FAILED` state; agent retries once after 15 minutes before escalating
- Vendor master record is inactive or blocked in SAP — flagged `VENDOR_BLOCKED`; no payment scheduled

**Never decides:**
- Releasing a payment run (payment execution remains a human-initiated action in SAP)
- Modifying vendor master payment terms

---

### 2.3 Handler Function Signatures (Arbiter Pattern)

Each agent exposes a `handler()` function that the Arbiter invokes. The Arbiter passes a standardised `AgentEvent` envelope and receives a standardised `AgentResult` envelope. Routing to the next agent or to a human queue is determined by the `status` and `next_action` fields in the result.

#### IngestAgent

```python
def handler(event: AgentEvent) -> AgentResult:
    """
    AgentEvent fields:
        source_channel: str          # "email" | "ariba" | "scan"
        raw_payload: bytes | dict    # raw email attachment, Ariba JSON, or scanned file
        received_at: datetime
        correlation_id: str          # Arbiter-assigned trace ID

    AgentResult fields:
        agent_id: str                # "ingest-agent-v1"
        correlation_id: str
        status: str                  # "SUCCESS" | "EXTRACTION_REVIEW_REQUIRED" | "NON_INVOICE_DOCUMENT"
        invoice_record: dict | None  # Normalised invoice record if status == "SUCCESS"
        low_confidence_fields: list  # Field names with confidence < 0.85
        next_action: str             # "ROUTE_TO_DUPLICATE_DETECTION" | "ROUTE_TO_HUMAN_QUEUE"
        audit_entry: dict
    """
```

#### DuplicateDetectionAgent

```python
def handler(event: AgentEvent) -> AgentResult:
    """
    AgentEvent fields:
        invoice_record: dict         # Normalised invoice record from IngestAgent
        correlation_id: str

    AgentResult fields:
        agent_id: str                # "duplicate-detection-agent-v1"
        correlation_id: str
        status: str                  # "UNIQUE" | "PROBABLE_DUPLICATE" | "CONFIRMED_DUPLICATE"
        similarity_score: float | None
        matched_invoice_id: str | None
        match_fields: list           # Fields that triggered the match
        next_action: str             # "ROUTE_TO_MATCHING" | "ROUTE_TO_HUMAN_QUEUE" | "REJECT_DUPLICATE"
        audit_entry: dict
    """
```

#### MatchingAgent

```python
def handler(event: AgentEvent) -> AgentResult:
    """
    AgentEvent fields:
        invoice_record: dict         # Normalised invoice record
        correlation_id: str

    AgentResult fields:
        agent_id: str                # "matching-agent-v1"
        correlation_id: str
        status: str                  # "MATCHED" | "WITHIN_TOLERANCE" | "FAILED_MATCH" | "NO_PO" | "GRN_MISSING" | "PO_EXHAUSTED"
        po_data: dict | None         # SAP PO record used in match
        grn_data: dict | None        # SAP GRN record used in match
        variance_detail: dict | None # variance_type, variance_amount, variance_pct
        next_action: str             # "ROUTE_TO_POSTING" | "ROUTE_TO_APPROVAL_ROUTING" | "ROUTE_TO_HUMAN_QUEUE"
        audit_entry: dict
    """
```

#### ApprovalRoutingAgent

```python
def handler(event: AgentEvent) -> AgentResult:
    """
    AgentEvent fields:
        invoice_record: dict         # Normalised invoice record
        match_result: str            # "NO_PO" | "FAILED_MATCH"
        correlation_id: str

    AgentResult fields:
        agent_id: str                # "approval-routing-agent-v1"
        correlation_id: str
        status: str                  # "PENDING" | "APPROVED" | "REJECTED" | "ESCALATED" | "APPROVER_UNRESOLVABLE"
        approver_id: str | None
        approver_email: str | None
        routing_reason: str
        sla_due_date: date
        next_action: str             # "ROUTE_TO_POSTING" | "ROUTE_TO_AP_MANAGER" | "ROUTE_TO_HUMAN_QUEUE"
        audit_entry: dict
    """
```

#### PostingAgent

```python
def handler(event: AgentEvent) -> AgentResult:
    """
    AgentEvent fields:
        invoice_record: dict         # Normalised invoice record
        match_result: str            # "MATCHED" | "WITHIN_TOLERANCE" | "APPROVED"
        approval_record: dict | None # Populated if invoice went through ApprovalRoutingAgent
        correlation_id: str

    AgentResult fields:
        agent_id: str                # "posting-agent-v1"
        correlation_id: str
        status: str                  # "POSTED" | "POSTING_FAILED" | "VENDOR_BLOCKED"
        sap_doc_id: str | None
        scheduled_payment_date: date | None
        epd_eligible: bool
        epd_deadline: date | None
        next_action: str             # "COMPLETE" | "ROUTE_TO_HUMAN_QUEUE"
        audit_entry: dict
    """
```

---

### 2.4 Agent Registration Configuration

Each agent is registered with the Arbiter orchestrator using the following configuration schema. The `input_schema` enforces contract validation at runtime and is used by the Arbiter to validate the `AgentEvent` before dispatch.

#### IngestAgent

```json
{
  "agentId": "ingest-agent-v1",
  "description": "Receives invoices from email, Ariba API, and scanned document channels. Extracts and normalises structured invoice fields using OCR and document parsing. Routes to duplicate detection on success or to the AP officer human queue on extraction failure.",
  "version": "1.0",
  "inputSchema": {
    "type": "object",
    "required": ["source_channel", "raw_payload", "received_at", "correlation_id"],
    "properties": {
      "source_channel": { "type": "string", "enum": ["email", "ariba", "scan"] },
      "raw_payload": { "type": ["string", "object"] },
      "received_at": { "type": "string", "format": "date-time" },
      "correlation_id": { "type": "string" }
    }
  }
}
```

#### DuplicateDetectionAgent

```json
{
  "agentId": "duplicate-detection-agent-v1",
  "description": "Compares incoming normalised invoice records against SAP historical invoice data using exact and fuzzy matching. Classifies invoices as UNIQUE, PROBABLE_DUPLICATE, or CONFIRMED_DUPLICATE. Blocks confirmed duplicates autonomously; routes probable duplicates to AP officer queue for review.",
  "version": "1.0",
  "inputSchema": {
    "type": "object",
    "required": ["invoice_record", "correlation_id"],
    "properties": {
      "invoice_record": {
        "type": "object",
        "required": ["invoice_number", "abn", "total_amount", "invoice_date"],
        "properties": {
          "invoice_number": { "type": "string" },
          "abn": { "type": "string" },
          "total_amount": { "type": "number" },
          "invoice_date": { "type": "string", "format": "date" }
        }
      },
      "correlation_id": { "type": "string" }
    }
  }
}
```

#### MatchingAgent

```json
{
  "agentId": "matching-agent-v1",
  "description": "Executes 3-way match between the invoice, the referenced SAP Purchase Order, and the SAP Goods Receipt Note. Applies configured tolerance rules (quantity ≤5%, price ≤2%, total ≤$500). Classifies outcome and routes accordingly. Does not resolve exceptions autonomously.",
  "version": "1.0",
  "inputSchema": {
    "type": "object",
    "required": ["invoice_record", "correlation_id"],
    "properties": {
      "invoice_record": {
        "type": "object",
        "required": ["invoice_number", "abn", "po_number", "line_items", "gst_amount", "total_amount"],
        "properties": {
          "invoice_number": { "type": "string" },
          "abn": { "type": "string" },
          "po_number": { "type": ["string", "null"] },
          "line_items": { "type": "array" },
          "gst_amount": { "type": "number" },
          "total_amount": { "type": "number" }
        }
      },
      "correlation_id": { "type": "string" }
    }
  }
}
```

#### ApprovalRoutingAgent

```json
{
  "agentId": "approval-routing-agent-v1",
  "description": "Routes non-PO invoices and failed-match exceptions to the correct cost centre owner in SAP for approval. Enforces the 3-business-day approval SLA with automated chasing at T+2 and T+3. Escalates to AP Manager at T+4. Applies co-approval rule for invoices exceeding $50,000.",
  "version": "1.0",
  "inputSchema": {
    "type": "object",
    "required": ["invoice_record", "match_result", "correlation_id"],
    "properties": {
      "invoice_record": {
        "type": "object",
        "required": ["invoice_number", "supplier_name", "total_amount", "cost_centre_code"],
        "properties": {
          "invoice_number": { "type": "string" },
          "supplier_name": { "type": "string" },
          "total_amount": { "type": "number" },
          "cost_centre_code": { "type": ["string", "null"] }
        }
      },
      "match_result": { "type": "string", "enum": ["NO_PO", "FAILED_MATCH"] },
      "correlation_id": { "type": "string" }
    }
  }
}
```

#### PostingAgent

```json
{
  "agentId": "posting-agent-v1",
  "description": "Posts approved and matched invoices to SAP as financial documents. Schedules payment dates per vendor master terms. Flags early payment discount eligibility. Writes a complete audit trail entry for every posting action to satisfy GST/BAS and Corporations Act record-keeping requirements. Does not execute payment runs.",
  "version": "1.0",
  "inputSchema": {
    "type": "object",
    "required": ["invoice_record", "match_result", "correlation_id"],
    "properties": {
      "invoice_record": {
        "type": "object",
        "required": ["invoice_number", "abn", "total_amount", "gst_amount", "supplier_name"],
        "properties": {
          "invoice_number": { "type": "string" },
          "abn": { "type": "string" },
          "total_amount": { "type": "number" },
          "gst_amount": { "type": "number" },
          "supplier_name": { "type": "string" }
        }
      },
      "match_result": { "type": "string", "enum": ["MATCHED", "WITHIN_TOLERANCE", "APPROVED"] },
      "approval_record": { "type": ["object", "null"] },
      "correlation_id": { "type": "string" }
    }
  }
}
```

---

> **S/4HANA Migration Note:** All five agent registrations include a `sap_api_version` runtime parameter (default: `ECC`; switchable to `S4HANA`) to support the in-flight ERP migration without requiring agent redeployment. The `sap_po_lookup`, `sap_grn_lookup`, `sap_invoice_post`, and `sap_cost_centre_lookup` tools each resolve their endpoint at runtime against this parameter.


---

## 3. Orchestration & Data Flow

### 3.1 Orchestration Architecture

The pipeline is coordinated by a central **Arbiter** orchestrator that manages agent sequencing, passes typed payloads between agents, enforces decision boundaries, and routes exceptions to human queues. Each agent is stateless; all intermediate state is persisted to a shared **invoice processing record** in a NoSQL database keyed on `invoice_id`. This design ensures that any agent can be retried independently without reprocessing upstream steps.

The Arbiter operates in an event-driven model: completion of each agent step emits a typed event that triggers the next agent. At peak load (end-of-month: ~270 invoices/day; end-of-financial-year: ~270+ invoices/day), the Arbiter scales agent invocations concurrently within the concurrency bounds defined in Section 3.4.

---

### 3.2 Primary Happy Path — Step-by-Step Orchestration Flow

The following describes the straight-through processing path for a **standard PO-backed invoice** received via email (68% of volume). This path is the target for >90% of the 3,100 monthly PO-backed invoices.

---

#### Step 1 — Invoice Ingestion (`IngestAgent`)

**Trigger:** A new email arrives in the AP inbox, an Ariba webhook fires for a new supplier portal submission, or a scanned document is deposited to the inbound document store.

**Actions:**
1. `IngestAgent` calls its `extract_invoice_data` tool, applying OCR (for scanned/email PDFs) or structured parsing (for Ariba API payloads).
2. Extracted fields are normalised into the canonical `InvoicePayload` schema (see Section 3.3).
3. `IngestAgent` calls `validate_abn` against the Australian Business Register to confirm the supplier ABN is valid and active.
4. `IngestAgent` calls `lookup_supplier` against the SAP vendor master to resolve `supplier_id` from ABN.
5. Confidence score (`extraction_confidence: float`) is computed across all mandatory fields. If `extraction_confidence < 0.85` on any mandatory field, the invoice is flagged `status: NEEDS_HUMAN_REVIEW` and routed to the AP exception queue — this does **not** proceed to Step 2.
6. On success, `IngestAgent` writes the `InvoiceRecord` to the NoSQL database and emits `INGESTION_COMPLETE` event.

**Output payload to Arbiter:** `InvoiceRecord` (see Section 3.3, Table 1).

---

#### Step 2 — Duplicate Detection (`DuplicateDetectionAgent`)

**Trigger:** Arbiter receives `INGESTION_COMPLETE` event.

**Actions:**
1. `DuplicateDetectionAgent` calls `query_invoice_history` with a composite key of `{supplier_id, invoice_number, invoice_total_aud}` against the SAP invoice history store and the local NoSQL processing record.
2. A secondary fuzzy check is run on `{supplier_id, invoice_date, invoice_total_aud}` with a ±2% tolerance on `invoice_total_aud` and a ±5-day window on `invoice_date` to catch re-submitted invoices with altered numbers.
3. **Decision rule:**
   - If exact composite key match found → `duplicate_status: EXACT_DUPLICATE` → route to AP exception queue with `escalation_reason: DUPLICATE_INVOICE`; processing halts.
   - If fuzzy match found → `duplicate_status: PROBABLE_DUPLICATE` → route to AP exception queue for human confirmation; processing halts.
   - If no match → `duplicate_status: CLEAR` → proceed.
4. `DuplicateDetectionAgent` updates `InvoiceRecord.duplicate_status` and emits `DUPLICATE_CHECK_COMPLETE`.

**Output payload delta:** `duplicate_status: string`, `duplicate_match_ref: string | null`.

---

#### Step 3 — 3-Way Matching (`MatchingAgent`)

**Trigger:** Arbiter receives `DUPLICATE_CHECK_COMPLETE` with `duplicate_status: CLEAR`.

**Actions:**
1. `MatchingAgent` calls `fetch_purchase_order` from SAP using `po_number` extracted by `IngestAgent`.
2. `MatchingAgent` calls `fetch_goods_receipt` from SAP using `po_number` to retrieve all GRN lines associated with the PO.
3. Matching logic is applied line-by-line:
   - **Price tolerance:** invoice unit price vs PO unit price — pass if variance ≤ 2% (configurable per supplier tier in `supplier_tolerance_config`).
   - **Quantity tolerance:** invoice quantity vs GRN quantity — pass if variance ≤ 0 (exact match required by default; configurable).
   - **PO status check:** PO must be in `OPEN` or `PARTIALLY_DELIVERED` status.
4. **Decision rule:**
   - All lines pass → `match_status: MATCHED` → proceed to Step 4.
   - Any line fails tolerance → `match_status: FAILED` → `MatchingAgent` calls `classify_mismatch` to categorise as one of: `PRICE_VARIANCE`, `QUANTITY_DISCREPANCY`, `MISSING_GRN`, `INVALID_PO_NUMBER`.
   - Failed match → route to AP exception queue with `escalation_reason: MATCH_FAILURE` and `mismatch_detail` payload; processing halts pending human resolution (current SLA target: <2 days, down from 4.2 days).
5. On success, `MatchingAgent` updates `InvoiceRecord` and emits `MATCHING_COMPLETE`.

**Output payload delta:** `match_status: string`, `matched_po_id: string`, `matched_grn_ids: string[]`, `mismatch_detail: MismatchDetail | null`.

---

#### Step 4 — Approval Routing (`ApprovalRoutingAgent`)

**Trigger:** Arbiter receives `MATCHING_COMPLETE` with `match_status: MATCHED`.

**Actions:**
1. `ApprovalRoutingAgent` evaluates `invoice_type`:
   - `invoice_type: PO_BACKED` with `match_status: MATCHED` → **no manager approval required** → emit `APPROVAL_COMPLETE` with `approval_status: AUTO_APPROVED`.
   - `invoice_type: NON_PO` → mandatory human approval path (see Section 3.2 Non-PO Path below).
2. For auto-approved PO-backed invoices, `ApprovalRoutingAgent` calls `check_payment_terms` against the SAP vendor master to retrieve `payment_due_date` and `early_payment_discount_date` (if applicable).
3. `payment_priority` is set:
   - If `early_payment_discount_date` is within 5 business days → `payment_priority: HIGH`.
   - Otherwise → `payment_priority: STANDARD`.
4. `InvoiceRecord` is updated with `approval_status`, `payment_due_date`, `early_payment_discount_date`, `payment_priority`.
5. Emits `APPROVAL_COMPLETE`.

**Output payload delta:** `approval_status: string`, `approver_id: string | null`, `payment_due_date: date`, `early_payment_discount_date: date | null`, `payment_priority: enum{HIGH, STANDARD}`.

---

#### Step 5 — SAP Posting (`PostingAgent`)

**Trigger:** Arbiter receives `APPROVAL_COMPLETE` with `approval_status: AUTO_APPROVED` or `approval_status: MANAGER_APPROVED`.

**Actions:**
1. `PostingAgent` calls `post_invoice_to_sap` via the SAP BAPI/RFC interface, submitting the full `InvoiceRecord` as a structured posting document.
2. SAP returns a `sap_document_number: string` on success.
3. `PostingAgent` calls `schedule_payment` to queue the payment run according to `payment_priority` and `payment_due_date`.
4. `PostingAgent` calls `update_audit_log` to write the complete `InvoiceRecord` — including all agent decisions, confidence scores, match results, and timestamps — to the immutable audit log store (GST/BAS compliance and Corporations Act record-keeping obligation).
5. `PostingAgent` calls `notify_supplier` via the email service to send a payment confirmation to the supplier's registered email address, referencing `invoice_number` and `payment_due_date`.
6. `InvoiceRecord.status` is set to `POSTED`. Emits `PROCESSING_COMPLETE`.

**Output payload delta:** `sap_document_number: string`, `payment_scheduled_date: date`, `status: POSTED`.

---

#### Non-PO Invoice Path (Divergence at Step 4)

For the 26% of invoices where `invoice_type: NON_PO`:

1. `ApprovalRoutingAgent` calls `resolve_approver` using a cost-centre-to-manager mapping table maintained in the NoSQL database. The mapping is derived from SAP organisational data and refreshed nightly.
2. An approval task is created in the workflow task store with `approval_deadline` set to 3 business days from `task_created_at`.
3. The assigned manager receives a structured notification via the internal notification service containing: `invoice_number`, `supplier_name`, `invoice_total_aud`, `cost_centre`, `invoice_description`, and a deep-link to the approval interface.
4. **Escalation rule:** If no response is recorded within 2 business days, `ApprovalRoutingAgent` sends a single automated reminder. If no response by `approval_deadline` (day 3), the task is escalated to the manager's direct superior and flagged in the AP exception queue.
5. On manager approval, the workflow task store emits `MANAGER_APPROVED` event; Arbiter triggers Step 5.
6. On manager rejection, `approval_status: REJECTED` is set; `PostingAgent` is not invoked; `InvoiceRecord` is archived with `status: REJECTED` and supplier is notified.

---

### 3.3 Data Passed Between Agents

All inter-agent data is carried in the `InvoiceRecord` object, persisted in the NoSQL database and passed by reference (`invoice_id`) between agents. Each agent reads the current record, appends its output fields, and writes back. The Arbiter never passes raw document bytes between agents — only the `invoice_id` reference and the triggering event type.

**Table 1 — `InvoiceRecord` Schema (cumulative across pipeline)**

| Field | Type | Set By | Description |
|---|---|---|---|
| `invoice_id` | `string (UUID)` | IngestAgent | System-generated unique identifier |
| `source_channel` | `enum{EMAIL, ARIBA, SCAN}` | IngestAgent | Ingestion channel |
| `raw_document_ref` | `string (URI)` | IngestAgent | Pointer to original document in object store |
| `supplier_id` | `string` | IngestAgent | SAP vendor master ID |
| `supplier_name` | `string` | IngestAgent | Supplier legal name |
| `supplier_abn` | `string` | IngestAgent | Australian Business Number |
| `invoice_number` | `string` | IngestAgent | Supplier-issued invoice number |
| `invoice_date` | `date` | IngestAgent | Date on invoice |
| `invoice_received_at` | `timestamp` | IngestAgent | System receipt timestamp |
| `po_number` | `string \| null` | IngestAgent | Referenced purchase order number |
| `invoice_total_aud` | `decimal` | IngestAgent | Total invoice amount (AUD, GST-inclusive) |
| `gst_amount_aud` | `decimal` | IngestAgent | GST component (must equal 10% of ex-GST for BAS compliance check) |
| `line_items` | `LineItem[]` | IngestAgent | Array of `{line_ref, description, quantity, unit_price_aud, line_total_aud}` |
| `extraction_confidence` | `float` | IngestAgent | Lowest field-level confidence score across mandatory fields |
| `invoice_type` | `enum{PO_BACKED, NON_PO}` | IngestAgent | Derived from presence of valid `po_number` |
| `duplicate_status` | `enum{CLEAR, PROBABLE_DUPLICATE, EXACT_DUPLICATE}` | DuplicateDetectionAgent | Outcome of duplicate check |
| `duplicate_match_ref` | `string \| null` | DuplicateDetectionAgent | `invoice_id` of matched record if duplicate found |
| `match_status` | `enum{MATCHED, FAILED, NOT_APPLICABLE}` | MatchingAgent | 3-way match outcome |
| `matched_po_id` | `string \| null` | MatchingAgent | Confirmed SAP PO document number |
| `matched_grn_ids` | `string[]` | MatchingAgent | List of matched GRN document numbers |
| `mismatch_detail` | `MismatchDetail \| null` | MatchingAgent | `{mismatch_type, affected_lines[], variance_pct}` |
| `approval_status` | `enum{PENDING, AUTO_APPROVED, MANAGER_APPROVED, REJECTED}` | ApprovalRoutingAgent | Approval outcome |
| `approver_id` | `string \| null` | ApprovalRoutingAgent | SAP user ID of assigned approver |
| `payment_due_date` | `date` | ApprovalRoutingAgent | Derived from vendor payment terms |
| `early_payment_discount_date` | `date \| null` | ApprovalRoutingAgent | Discount capture deadline if applicable |
| `payment_priority` | `enum{HIGH, STANDARD}` | ApprovalRoutingAgent | Drives payment run scheduling |
| `sap_document_number` | `string \| null` | PostingAgent | SAP FI document number post-posting |
| `payment_scheduled_date` | `date \| null` | PostingAgent | Date payment run is scheduled |
| `status` | `enum{PROCESSING, NEEDS_HUMAN_REVIEW, POSTED, REJECTED, DUPLICATE_HELD}` | All agents | Current pipeline status |
| `audit_trail` | `AuditEntry[]` | All agents | Append-only log of `{agent, action, timestamp, decision, confidence}` |

---

### 3.4 Exception Handling and Retry Strategy

#### Agent-Level Failures (Transient)

Transient failures — network timeouts calling SAP BAPI/RFC, Ariba API rate limits, or OCR service unavailability — are handled by the Arbiter using an **exponential backoff retry policy**:

- **Retry attempts:** 3
- **Initial backoff:** 5 seconds
- **Backoff multiplier:** 2× (5s → 10s → 20s)
- **Maximum retry window:** 35 seconds total
- After 3 failed attempts, the `InvoiceRecord.status` is set to `PROCESSING_ERROR` and the invoice is placed in the AP exception queue with `escalation_reason: AGENT_FAILURE` and the specific `agent_name` and `error_code` recorded in `audit_trail`.

#### Business Rule Failures (Non-Retryable)

The following conditions are non-retryable and route immediately to the AP exception queue without retry:

| Condition | Agent | `escalation_reason` |
|---|---|---|
| `extraction_confidence < 0.85` on any mandatory field | IngestAgent | `LOW_CONFIDENCE_EXTRACTION` |
| ABN not found or cancelled in ABR | IngestAgent | `INVALID_SUPPLIER_ABN` |
| Supplier not in SAP vendor master | IngestAgent | `UNKNOWN_SUPPLIER` |
| `duplicate_status: EXACT_DUPLICATE` | DuplicateDetectionAgent | `DUPLICATE_INVOICE` |
| `duplicate_status: PROBABLE_DUPLICATE` | DuplicateDetectionAgent | `PROBABLE_DUPLICATE` |
| `match_status: FAILED` | MatchingAgent | `MATCH_FAILURE` |
| No approver resolved for cost centre | ApprovalRoutingAgent | `APPROVER_NOT_FOUND` |
| SAP posting rejected (e.g. period closed, GL account invalid) | PostingAgent | `SAP_POSTING_FAILURE` |

All exception queue entries include the full `InvoiceRecord` snapshot at the point of failure, the `escalation_reason`, the `agent_name`, and a human-readable `escalation_summary` generated by the routing agent. AP officers work exceptions via a dedicated exception management interface that surfaces these fields directly — no manual re-keying of invoice data is required.

#### SAP S/4HANA Migration Compatibility

During the ERP consolidation period (until Q3), the `PostingAgent` maintains a **dual-target posting configuration**: it reads `invoice_record.entity_code` (set during ingestion from the supplier's mapped legal entity) to determine whether to route the posting to the legacy SAP ECC instance or the new SAP S/4HANA instance. This routing is transparent to all upstream agents. If `entity_code` cannot be resolved, the invoice is held with `escalation_reason: ENTITY_ROUTING_AMBIGUOUS` for human assignment.

#### Audit and Compliance

Every agent action — including autonomous decisions, confidence scores, match outcomes, and escalation decisions — is written to the append-only `audit_trail` field on the `InvoiceRecord`. This log is replicated to the immutable audit log store within 60 seconds of each write, satisfying Corporations Act record-keeping obligations and providing the financial audit trail required for GST/BAS compliance. The audit log is retained for 7 years.

---

### 3.5 Concurrency Considerations

**Normal load:** At ~200 invoices per business day, the pipeline processes approximately 25 invoices per hour across an 8-hour business day. This is well within single-threaded sequential capacity.

**Peak load:** End-of-month and end-of-financial-year peaks reach ~270 invoices/day (~34/hour). The Arbiter is configured to allow **up to 50 concurrent `IngestAgent` invocations** and **up to 30 concurrent `MatchingAgent` invocations**. `PostingAgent` concurrency is capped at **10 concurrent SAP posting calls** to respect SAP BAPI/RFC connection pool limits negotiated with the SAP Basis team.

**`DuplicateDetectionAgent` — write contention:** Because duplicate detection queries and the invoice history store are updated in near-real-time, a race condition exists where two near-identical invoices ingested within milliseconds of each other could both pass the duplicate check before either is written to history. This is mitigated by an **optimistic locking pattern**: the duplicate check query and the history write are wrapped in a conditional write operation keyed on `{supplier_id, invoice_number}`. If the conditional write fails (key already exists), the second invoice is automatically flagged `duplicate_status: PROBABLE_DUPLICATE` and routed to the exception queue.

**`ApprovalRoutingAgent` — non-PO approval queue depth:** Given the 6.8-day average approval turnaround in the current state, the approval task store may accumulate a backlog during the transition period. The Arbiter monitors `pending_approval_count` and triggers an alert to the AP Manager if the queue exceeds 150 items (equivalent to approximately 3 days of non-PO volume), enabling proactive escalation before SLA breaches occur.

**S/4HANA migration window:** During any planned SAP cutover windows (coordinated with the ERP consolidation programme), the Arbiter will be placed in **ingestion-only mode**: `IngestAgent` and `DuplicateDetectionAgent` continue to run and queue records, but `MatchingAgent`, `ApprovalRoutingAgent`, and `PostingAgent` are suspended. Queued records are processed in `payment_priority` order (HIGH first) when the SAP connection is restored.


---

## 4. Integrations

### 4.1 Integration Summary Table

| External System | Agent(s) | Integration Method | Auth Method |
|---|---|---|---|
| SAP ECC (current ERP) | MatchingAgent, DuplicateDetectionAgent, PostingAgent | `http_request` via SAP RFC/BAPI over REST wrapper | OAuth 2.0 client credentials; service account `svc_ap_automation` |
| SAP S/4HANA (target ERP, Q3 cutover) | MatchingAgent, DuplicateDetectionAgent, PostingAgent | `http_request` via SAP OData API (v4) | OAuth 2.0 client credentials; service account `svc_ap_s4_automation` |
| Ariba Supplier Portal | IngestAgent | `http_request` via Ariba Network API (REST) | OAuth 2.0 bearer token; API key per integration credential set |
| AP Email Inbox (IMAP/SMTP) | IngestAgent | Custom tool `EmailPollingTool` | Service account OAuth 2.0 (Microsoft 365 modern auth); no basic auth |
| OCR / Document Intelligence Service | IngestAgent | `http_request` (REST, multipart/form-data) | API key in `Authorization` header |
| AP Exception & Approval Workflow (internal ticketing) | ApprovalRoutingAgent | Custom tool `WorkflowTicketTool` | API key + HMAC request signing |
| Audit Log Store (append-only NoSQL database) | All agents (via Arbiter) | Custom tool `AuditWriteTool` | Internal service-to-service mTLS |

---

### 4.2 SAP ECC — RFC/BAPI REST Wrapper

SAP ECC does not expose native REST endpoints; a thin REST wrapper deployed on the internal integration middleware translates HTTP calls to RFC/BAPI invocations. This wrapper is maintained by the ERP team and is the same integration surface used by existing AP tooling.

**Used by:** `MatchingAgent`, `DuplicateDetectionAgent`, `PostingAgent`

**Base URL:** `https://erp-integration.globalbuild.internal/sap/ecc/v1`

#### Key Endpoints and Fields

| Operation | Endpoint | Method | Key Request Fields | Key Response Fields |
|---|---|---|---|---|
| Fetch PO header | `/purchase-orders/{po_number}` | GET | `po_number`, `company_code` | `po_number`, `vendor_id`, `po_date`, `currency`, `line_items[]{item_no, material, quantity, unit_price, delivery_date}` |
| Fetch GRN (goods receipt) | `/goods-receipts?po_number={po}&line={line}` | GET | `po_number`, `line_item`, `company_code` | `grn_number`, `received_quantity`, `receipt_date`, `plant`, `storage_location` |
| Duplicate invoice check | `/invoices?vendor_id={id}&invoice_number={inv}` | GET | `vendor_id`, `invoice_number`, `fiscal_year` | `exists: bool`, `document_number`, `posting_date`, `amount`, `status` |
| Post invoice document | `/invoices` | POST | `vendor_id`, `invoice_number`, `invoice_date`, `posting_date`, `currency`, `gross_amount`, `tax_code`, `line_items[]{po_number, po_line, quantity, net_amount, tax_amount, cost_centre}`, `payment_terms`, `reference` | `document_number`, `fiscal_year`, `posting_status`, `message_type`, `message_text` |
| Fetch vendor master | `/vendors/{vendor_id}` | GET | `vendor_id`, `company_code` | `vendor_id`, `abn`, `name`, `payment_terms`, `bank_details`, `account_group`, `blocking_status` |

**Error codes and handling:**

| HTTP Status | SAP Message Type | Meaning | Agent Behaviour |
|---|---|---|---|
| 200 | `S` (Success) | Document posted or record found | Continue pipeline |
| 200 | `W` (Warning) | Posted with tolerance warning | Log warning; continue if within tolerance thresholds defined in Section 3 |
| 400 | `E` (Error) | Business rule violation (e.g. PO closed, tolerance breach) | Non-retryable; escalate to human queue via `WorkflowTicketTool` |
| 404 | — | PO or vendor not found | Non-retryable; raise `MISSING_PO` or `UNKNOWN_VENDOR` exception |
| 409 | — | Duplicate document detected by SAP | Non-retryable; route to `DuplicateDetectionAgent` hold queue |
| 429 | — | Rate limit on wrapper | Retryable; exponential backoff (see §4.8) |
| 500 / 503 | — | Middleware or SAP unavailable | Retryable; exponential backoff; dead-letter after 3 attempts |

**Rate limit:** The ECC REST wrapper enforces a maximum of **10 concurrent connections** and **600 requests/minute** across all consumers. The `PostingAgent` concurrency cap of 10 (defined in Section 3) directly maps to this constraint.

---

### 4.3 SAP S/4HANA — OData API v4

From Q3 cutover, all posting and lookup operations will target the S/4HANA OData v4 endpoints. The dual-routing logic in `PostingAgent` (described in Section 3) switches the base URL and payload schema based on the `erp_target` field in the invoice envelope.

**Used by:** `MatchingAgent`, `DuplicateDetectionAgent`, `PostingAgent`

**Base URL:** `https://s4hana.globalbuild.internal/sap/opu/odata4/sap/`

#### Key Endpoints and Fields

| Operation | OData Service | Entity / Action | Key Request Fields | Key Response Fields |
|---|---|---|---|---|
| Fetch PO | `API_PURCHASEORDER_PROCESS_SRV` | `A_PurchaseOrder`, `A_PurchaseOrderItem` | `PurchaseOrder`, `CompanyCode` | `PurchaseOrder`, `Supplier`, `DocumentCurrency`, items with `OrderQuantity`, `NetPriceAmount`, `Plant` |
| Fetch GRN | `API_MATERIAL_DOCUMENT_SRV` | `A_MaterialDocItem` | `ReferenceDocument` (PO number), `MaterialDocumentItem` | `MaterialDocument`, `GoodsMovementType`, `QuantityInEntryUnit`, `PostingDate` |
| Duplicate check | `API_SUPPLIER_INVOICE_SRV` | `A_SupplierInvoice?$filter=...` | `SupplierInvoiceIDByInvcgParty`, `Supplier`, `FiscalYear` | `SupplierInvoice`, `DocumentDate`, `InvoiceGrossAmount`, `PaymentStatus` |
| Post invoice | `API_SUPPLIER_INVOICE_SRV` | `A_SupplierInvoice` (POST) | `Supplier`, `SupplierInvoiceIDByInvcgParty`, `DocumentDate`, `PostingDate`, `InvoiceGrossAmount`, `DocumentCurrency`, `TaxCode`, `to_SupplierInvoiceItemGLAcct` collection | `SupplierInvoice`, `FiscalYear`, `CompanyCode` |
| Fetch supplier master | `API_BUSINESS_PARTNER` | `A_BusinessPartner`, `A_BusinessPartnerBank` | `BusinessPartner`, `CompanyCode` | `BusinessPartnerFullName`, `TaxNumber1` (ABN), `PaymentTerms`, bank collection |

**Auth:** OAuth 2.0 client credentials flow against the S/4HANA identity provider. Token endpoint: `https://s4hana.globalbuild.internal/oauth/token`. Token cached in memory; refreshed 60 seconds before expiry. Scopes required: `AP_INVOICE_READ`, `AP_INVOICE_POST`, `PO_READ`, `GR_READ`, `BP_READ`.

**Error codes:** OData error responses use `error.code` and `error.message.value`. Codes `MESG/E` class errors are non-retryable business exceptions; HTTP 5xx are retryable per §4.8.

---

### 4.4 Ariba Supplier Portal — Ariba Network API

**Used by:** `IngestAgent`

**Integration method:** `http_request` to the Ariba Network REST API. `IngestAgent` polls for new invoice documents on a scheduled basis (every 5 minutes during business hours; every 15 minutes outside business hours).

**Base URL:** `https://openapi.ariba.com/api/invoice/v2/`

**Auth:** OAuth 2.0 bearer token obtained via client credentials grant. API key passed as `apiKey` query parameter on all requests (Ariba requirement in addition to bearer token). Credentials stored in the secrets manager under key `ariba/ap_ingest`.

#### Key Request/Response Fields

| Operation | Endpoint | Method | Key Request Fields | Key Response Fields |
|---|---|---|---|---|
| Poll new invoices | `/invoices?status=NEW&pageSize=50` | GET | `status`, `pageSize`, `pageToken` (cursor) | `invoices[]{invoiceId, supplierId, invoiceNumber, invoiceDate, totalAmount, currency, lineItems[], attachmentUrl, status}` |
| Acknowledge receipt | `/invoices/{invoiceId}/acknowledge` | POST | `invoiceId`, `acknowledgedAt` (ISO 8601) | `invoiceId`, `acknowledgementStatus` |
| Fetch attachment | `/invoices/{invoiceId}/attachments/{attachmentId}` | GET | `invoiceId`, `attachmentId` | Binary PDF/XML stream |

**Normalisation:** Ariba invoices arrive in cXML format embedded in the REST response. `IngestAgent` maps cXML fields to the canonical `InvoiceEnvelope` schema (defined in Section 3) before passing downstream. The `source` field is set to `"ariba"` and `raw_payload` stores the original cXML string for audit purposes.

**Rate limit:** Ariba Network API enforces **100 requests/minute** per API key. At peak (260 invoices/day from Ariba channel), polling load is well within limits. `IngestAgent` uses cursor-based pagination (`pageToken`) to retrieve batches of 50; a full poll cycle at peak requires ≤6 requests.

---

### 4.5 AP Email Inbox — Custom Tool: `EmailPollingTool`

Strands does not provide a built-in email polling tool. A custom tool is required to connect to the Microsoft 365 shared mailbox `ap@globalbuild.com.au`.

**Used by:** `IngestAgent`

**Tool name:** `EmailPollingTool`

**Implementation:** Serverless function triggered on a 5-minute schedule. Connects via Microsoft Graph API (IMAP is disabled per GlobalBuild IT policy; Graph API is the mandated integration path).

**Auth:** OAuth 2.0 client credentials flow against Microsoft Entra ID tenant. Scopes: `Mail.Read`, `Mail.ReadWrite` on the shared mailbox. Credentials stored in secrets manager under `m365/ap_mailbox`.

#### Key Fields Extracted per Email

| Field | Source | Notes |
|---|---|---|
| `sender_email` | `from.emailAddress.address` | Used for supplier correlation |
| `sender_name` | `from.emailAddress.name` | |
| `subject` | `subject` | Parsed for invoice number hints |
| `received_datetime` | `receivedDateTime` | ISO 8601; used for SLA timestamping |
| `body_text` | `body.content` (text/plain) | Passed to OCR/extraction if no attachment |
| `attachments[]` | `attachments` collection | PDF, TIFF, PNG accepted; others rejected and flagged |
| `message_id` | `id` | Stored in `InvoiceEnvelope.source_reference` for deduplication |

**Post-processing:** After successful ingestion, `EmailPollingTool` moves the email to the `Processed` subfolder and applies the `AP_INGESTED` category tag. Failed ingestions (unreadable attachments, unsupported formats) are moved to `Exceptions` subfolder and a `WorkflowTicketTool` exception ticket is raised.

**Rate limit:** Microsoft Graph API allows **10,000 requests per 10 minutes** per application — not a practical constraint at current volumes.

---

### 4.6 OCR / Document Intelligence Service

**Used by:** `IngestAgent` for all email-attached PDFs and all scanned paper invoices (10% of volume).

**Integration method:** `http_request` (REST, multipart/form-data upload).

**Auth:** API key passed in `Ocp-Apim-Subscription-Key` header. Key stored in secrets manager under `ocr/document_intelligence`.

#### Key Request/Response Fields

| Direction | Field | Type | Notes |
|---|---|---|---|
| Request | `file` | binary | PDF or image; max 50MB |
| Request | `model_id` | string | Fixed value `"prebuilt-invoice"` for standard invoices; `"custom-ap-globalbuild-v2"` for known supplier templates |
| Request | `locale` | string | `"en-AU"` |
| Response | `fields.VendorName.value` | string | Mapped to `InvoiceEnvelope.supplier_name` |
| Response | `fields.VendorTaxId.value` | string | ABN; validated against 11-digit ABN format before use |
| Response | `fields.InvoiceId.value` | string | Mapped to `invoice_number` |
| Response | `fields.InvoiceDate.value` | date | ISO 8601 |
| Response | `fields.DueDate.value` | date | ISO 8601 |
| Response | `fields.SubTotal.value.amount` | decimal | Net amount |
| Response | `fields.TotalTax.value.amount` | decimal | GST amount; cross-checked: GST must equal SubTotal × 0.1 ± $0.02 |
| Response | `fields.InvoiceTotal.value.amount` | decimal | Gross amount |
| Response | `fields.Items[].value` | array | Line items: `description`, `quantity`, `unit_price`, `amount` |
| Response | `fields.PurchaseOrder.value` | string | PO reference if present on invoice |
| Response | `confidence` (per field) | float | Fields with confidence < 0.80 flagged for human review |

**Confidence threshold rule:** If any of `invoice_number`, `abn`, `invoice_total`, or `invoice_date` return confidence < 0.80, `IngestAgent` sets `extraction_confidence: "LOW"` on the envelope and routes to the human exception queue rather than continuing the pipeline. This threshold is configurable via the `OCR_CONFIDENCE_THRESHOLD` environment variable.

**Rate limit:** 15 requests/second. At peak load (~260 invoices/day from email + scan channels), average throughput is well within limits. `IngestAgent` implements a token-bucket client-side limiter capped at 10 requests/second to leave headroom.

**Error codes:**

| HTTP Status | Meaning | Behaviour |
|---|---|---|
| 400 | Unsupported file type or corrupt document | Non-retryable; raise exception ticket |
| 429 | Rate limit exceeded | Retryable; exponential backoff per §4.8 |
| 503 | Service unavailable | Retryable; exponential backoff per §4.8 |

---

### 4.7 AP Exception & Approval Workflow — Custom Tool: `WorkflowTicketTool`

Strands has no built-in tool for creating human-in-the-loop workflow tickets. A custom tool is required to interface with GlobalBuild's internal ticketing/workflow system.

**Used by:** `ApprovalRoutingAgent` (primary); `IngestAgent`, `MatchingAgent`, `DuplicateDetectionAgent`, `PostingAgent` (for exception escalation).

**Tool name:** `WorkflowTicketTool`

**Auth:** API key in `X-API-Key` header plus HMAC-SHA256 request signing using a shared secret. Both credentials stored in secrets manager under `workflow/ap_tickets`.

#### Key Request/Response Fields

| Operation | Endpoint | Method | Key Request Fields | Key Response Fields |
|---|---|---|---|---|
| Create ticket | `/tickets` | POST | `ticket_type` (enum: `APPROVAL_REQUIRED`, `MATCH_EXCEPTION`, `DUPLICATE_HOLD`, `EXTRACTION_FAILURE`, `POSTING_FAILURE`), `invoice_envelope_id`, `priority` (enum: `HIGH`, `NORMAL`), `assigned_queue`, `due_by` (ISO 8601), `context_payload` (JSON), `source_agent` | `ticket_id`, `ticket_url`, `created_at`, `assigned_to` |
| Poll ticket status | `/tickets/{ticket_id}` | GET | `ticket_id` | `ticket_id`, `status` (enum: `OPEN`, `IN_PROGRESS`, `APPROVED`, `REJECTED`, `RESOLVED`), `resolved_by`, `resolution_notes`, `resolved_at` |
| Close ticket | `/tickets/{ticket_id}/close` | PATCH | `ticket_id`, `resolution_code`, `resolved_by_agent` | `ticket_id`, `status: CLOSED"` |

**SLA enforcement:** `ApprovalRoutingAgent` sets `due_by` to 3 business days from `created_at` for non-PO approval tickets, consistent with the business SLA defined in Section 2. The Arbiter polls open tickets every 30 minutes and raises an escalation notification if `due_by` is within 4 hours and status remains `OPEN`.

**`context_payload` schema for `APPROVAL_REQUIRED` tickets:**
```json
{
  "invoice_number": "string",
  "supplier_name": "string",
  "abn": "string",
  "invoice_date": "date",
  "gross_amount": "decimal",
  "currency": "string",
  "cost_centre": "string",
  "requestor": "string",
  "business_justification": "string",
  "supporting_documents_url": "string"
}
```

---

### 4.8 Audit Log Store — Custom Tool: `AuditWriteTool`

**Used by:** All agents (writes are orchestrated by the Arbiter at each pipeline stage transition).

**Tool name:** `AuditWriteTool`

**Integration method:** Append-only write to an internal NoSQL database collection `ap_audit_log`. Writes are synchronous and blocking — no pipeline stage transition completes without a confirmed audit write, satisfying Corporations Act record-keeping obligations.

**Auth:** Internal service-to-service mTLS; client certificate bound to the `svc_ap_automation` service identity.

#### Key Fields Written per Audit Record

| Field | Type | Notes |
|---|---|---|
| `audit_id` | UUID | Generated by `AuditWriteTool` |
| `invoice_envelope_id` | UUID | Correlation key across all records for one invoice |
| `event_type` | string | e.g. `INGESTED`, `DUPLICATE_CHECK_PASS`, `MATCH_SUCCESS`, `MATCH_FAIL`, `APPROVAL_REQUESTED`, `POSTED`, `EXCEPTION_RAISED` |
| `agent_name` | string | Name of the emitting agent |
| `timestamp` | ISO 8601 | UTC |
| `operator` | string | `"system"` for autonomous actions; AP officer ID for human actions |
| `payload_snapshot` | JSON | Full `InvoiceEnvelope` state at time of event (for GST/BAS audit trail) |
| `outcome` | string | `SUCCESS`, `FAILURE`, `ESCALATED` |
| `error_detail` | string | Populated on `FAILURE`; null otherwise |

**Retention:** Audit records are retained for 7 years per Corporations Act s286 obligations. The NoSQL collection is configured with a TTL of 2,557 days (7 years).

---

### 4.9 Retry and Backoff Policy

All retryable errors across integrations follow a consistent exponential backoff policy implemented in a shared `RetryHandler` utility used by all agents.

| Attempt | Delay Before Retry | Condition |
|---|---|---|
| 1st retry | 2 seconds | HTTP 429, 500, 502, 503, 504 |
| 2nd retry | 8 seconds | Same |
| 3rd retry | 30 seconds | Same |
| Dead-letter | — | After 3 failed retries; invoice envelope moved to dead-letter queue; `AuditWriteTool` writes `FAILURE` event; `WorkflowTicketTool` raises `POSTING_FAILURE` or equivalent ticket |

**Non-retryable conditions** (immediate escalation, no retry): HTTP 400, 404, 409; SAP message type `E`; OCR confidence below threshold; business rule violations (PO closed, vendor blocked, tolerance breach exceeded). These are treated as deterministic failures requiring human judgement and are routed directly to the exception queue.

**Jitter:** A random jitter of ±20% is applied to each backoff delay to prevent thundering-herd behaviour during SAP unavailability windows (e.g. nightly batch jobs, S/4HANA cutover maintenance windows).


---

## 5. Human-in-the-Loop Design

The pipeline is designed on a principle of **supervised autonomy**: agents execute all repetitive, rules-based work without human involvement, but escalate to named human roles at precisely defined decision boundaries. This section specifies those boundaries, the mechanics of routing approval responses back into the Arbiter-coordinated pipeline, the audit trail structure, and the compliance controls that constrain specific agent behaviours.

---

### 5.1 Human Escalation Triggers, Routing, and SLAs

The following table defines every condition under which the pipeline suspends autonomous processing and requires human action. Triggers are emitted by specific agents and routed via the `WorkflowTicketTool` (defined in Section 4) to the appropriate human role.

| # | Trigger Condition | Emitting Agent | Who Is Notified | SLA | Action Required |
|---|---|---|---|---|---|
| T1 | OCR confidence score < 0.80 on any of: `supplier_abn`, `invoice_total`, `gst_amount`, `invoice_date` | `IngestAgent` | AP Officer (queue: `ap.exceptions`) | **4 business hours** | Review raw document image in exception UI; confirm or correct extracted fields; mark ticket `VERIFIED` or `REJECTED` |
| T2 | `DuplicateDetectionAgent` flags `PROBABLE_DUPLICATE` (fuzzy match score 0.85–0.94) | `DuplicateDetectionAgent` | AP Officer (queue: `ap.exceptions`) | **4 business hours** | Compare flagged invoice pair; confirm duplicate or clear for processing; decision recorded against `invoice_id` and `duplicate_candidate_id` |
| T3 | `DuplicateDetectionAgent` flags `CONFIRMED_DUPLICATE` (score ≥ 0.95) | `DuplicateDetectionAgent` | AP Supervisor + originating supplier contact | **Immediate notification; 1 business day resolution** | AP Supervisor reviews and formally rejects invoice; rejection reason logged to SAP vendor master against `vendor_id` |
| T4 | `MatchingAgent` returns `MATCH_FAILED` — price variance > 2% or quantity variance > 1 unit against PO line | `MatchingAgent` | AP Officer (queue: `ap.exceptions`) + Procurement contact for the originating `po_number` | **1 business day** | AP Officer contacts supplier or Procurement to resolve discrepancy; updates `resolution_notes` field; sets ticket to `RESOLVED` or `ESCALATED` |
| T5 | `MatchingAgent` returns `GRN_MISSING` — no Goods Receipt Note found in SAP for `po_line_item` within 2 business days of invoice receipt | `MatchingAgent` | Warehouse/Receiving Manager (routed by `cost_centre` from PO) | **1 business day** | Receiving Manager confirms receipt in SAP or advises expected date; `MatchingAgent` re-polls on resolution |
| T6 | Non-PO invoice received (`po_number` = null); `invoice_total` ≤ $10,000 | `ApprovalRoutingAgent` | Cost centre manager (resolved from `gl_account` → `cost_centre` → manager mapping in SAP) | **3 business days** | Manager approves or rejects via approval response email or workflow portal; response routed back to Arbiter (see Section 5.2) |
| T7 | Non-PO invoice received; `invoice_total` > $10,000 | `ApprovalRoutingAgent` | Cost centre manager **and** Finance Manager | **3 business days** | Dual approval required; both parties must respond `APPROVED` before `PostingAgent` proceeds |
| T8 | `ApprovalRoutingAgent` receives no response within 3 business days (T6 or T7) — first chase | `ApprovalRoutingAgent` | Original approver(s) — automated reminder via `WorkflowTicketTool` | **1 additional business day** | Approver responds; if no response after 1 further business day, T9 triggers |
| T9 | No approval response after 4 business days total (T6/T7 + T8 elapsed) | `ApprovalRoutingAgent` | AP Supervisor | **Same business day** | AP Supervisor manually escalates to department head or rejects invoice; outcome logged |
| T10 | `PostingAgent` receives SAP posting error code outside the retryable set (e.g. `VENDOR_BLOCKED`, `PERIOD_CLOSED`, `DUPLICATE_DOC`) | `PostingAgent` | AP Officer (queue: `ap.posting_errors`) | **4 business hours** | AP Officer resolves SAP configuration issue (e.g. unblocks vendor, opens posting period) and triggers manual repost or instructs pipeline to abandon |
| T11 | Any agent returns an unhandled exception after 3 retry attempts | Arbiter | AP Supervisor + System Operations | **2 business hours** | Triage root cause; determine whether invoice requires manual processing; Arbiter places invoice in `SUSPENDED` state |

**SLA breach behaviour:** The `WorkflowTicketTool` records a `sla_due_at` timestamp on ticket creation. A scheduled polling function checks open tickets every 30 minutes. On SLA breach, the ticket priority is elevated to `URGENT` and a secondary notification is sent to the AP Supervisor. SLA performance is reported weekly to the CFO dashboard.

---

### 5.2 Routing Approval Responses Back into the Orchestration

When `ApprovalRoutingAgent` suspends a non-PO invoice pending manager approval (T6 or T7), the Arbiter sets the invoice's pipeline state to `AWAITING_APPROVAL` and records the following in the workflow state store (NoSQL database, keyed on `invoice_id`):

```
{
  "invoice_id": "INV-2024-08471",
  "pipeline_state": "AWAITING_APPROVAL",
  "approval_ticket_id": "WF-00341",
  "approvers_required": ["manager.jane.smith@company.com"],
  "approvers_responded": [],
  "approval_outcome": null,
  "suspended_at": "2024-11-14T09:32:00Z",
  "sla_due_at": "2024-11-19T17:00:00Z"
}
```

Approval responses are accepted via two channels:

1. **Workflow portal response**: The approver clicks `APPROVE` or `REJECT` in the internal workflow portal. The portal writes `approval_outcome` (`APPROVED` / `REJECTED`) and `approver_id` directly to the workflow state store via an authenticated API call, then publishes an `approval.response` event to the Arbiter's event bus.

2. **Email reply**: The approval notification email contains a tokenised reply-to address (e.g. `ap-approval+WF-00341@company.com`). The `EmailPollingTool` (defined in Section 4) polls this inbox, parses the response keyword (`APPROVE` / `REJECT`) from the email body using a deterministic keyword extractor, and writes the outcome to the workflow state store before publishing the same `approval.response` event. If the email body is ambiguous (no recognised keyword), the tool flags the ticket as `RESPONSE_UNCLEAR` and notifies the AP Officer to chase the approver directly.

On receipt of the `approval.response` event, the Arbiter:

- Validates that all required approvers have responded (for T7 dual-approval, both `approvers_responded` entries must be present and `APPROVED`).
- If `APPROVED`: transitions pipeline state to `APPROVAL_GRANTED`, re-queues the invoice for `PostingAgent` with `approval_ticket_id` attached as a mandatory audit reference.
- If `REJECTED`: transitions pipeline state to `REJECTED`, triggers supplier notification via the email service, and closes the workflow ticket with `rejection_reason` populated.
- If any approver responds `REJECTED` in a dual-approval scenario: the invoice is immediately rejected regardless of the other approver's response; the Arbiter does not wait for the second response.

The `PostingAgent` will not post any non-PO invoice to SAP unless `approval_ticket_id` is present and the workflow state store confirms `approval_outcome = APPROVED`. This is enforced as a hard pre-condition check in the `PostingAgent` handler, not a soft advisory.

---

### 5.3 Audit Trail

All human-in-the-loop interactions are logged at two levels: **pipeline-level** (Arbiter event log) and **document-level** (per-invoice audit record).

#### 5.3.1 Arbiter Event Log

Every state transition, agent invocation, escalation trigger, and approval event is written to an append-only event log in the NoSQL database. Each log entry contains:

| Field | Description |
|---|---|
| `event_id` | UUID, system-generated |
| `invoice_id` | Links event to invoice record |
| `event_type` | e.g. `AGENT_INVOKED`, `ESCALATION_TRIGGERED`, `APPROVAL_RECEIVED`, `STATE_TRANSITION`, `SLA_BREACHED` |
| `agent_name` | e.g. `MatchingAgent`, `ApprovalRoutingAgent` |
| `trigger_code` | T1–T11 reference from Section 5.1 |
| `actor` | System identity (agent name) or human identity (`user_id` from workflow portal or email address) |
| `previous_state` | Pipeline state before event |
| `new_state` | Pipeline state after event |
| `payload_snapshot` | JSON snapshot of relevant fields at time of event (e.g. `match_result`, `variance_pct`, `approval_outcome`) |
| `timestamp` | UTC ISO 8601 |
| `session_id` | Arbiter session identifier for the invoice's end-to-end processing run |

The event log is **immutable**: no update or delete operations are permitted. Corrections are recorded as new events of type `CORRECTION` referencing the original `event_id`.

#### 5.3.2 Per-Invoice Audit Record

A consolidated audit record is materialised for each invoice upon final state (`POSTED`, `REJECTED`, or `ABANDONED`). This record is written to the AP audit store and retained for **7 years** in compliance with Corporations Act record-keeping obligations. It includes:

- Full extraction output from `IngestAgent` including OCR confidence scores per field
- Duplicate detection result and match scores from `DuplicateDetectionAgent`
- 3-way match result including `po_number`, `grn_number`, `variance_pct`, and `match_decision` from `MatchingAgent`
- Approval chain: all approvers notified, timestamps of notifications, response timestamps, and `approval_outcome` per approver
- SAP document number (`sap_doc_id`) on successful posting
- Total elapsed processing time from `ingest_timestamp` to `final_state_timestamp`
- Identity of any human who intervened, with the specific field(s) they modified and the before/after values

#### 5.3.3 GST/BAS Compliance Logging

For every invoice posted to SAP, `PostingAgent` logs the following fields to the AP audit store in a GST-specific sub-record: `supplier_abn`, `invoice_date`, `invoice_total`, `gst_amount`, `gst_code` (SAP tax code), and `sap_doc_id`. This sub-record is structured to support direct extraction for BAS preparation and ATO audit response without requiring manual reconstruction from SAP.

---

### 5.4 Compliance Controls Mapped to Agent Behaviours

The following controls address the regulatory and financial governance requirements identified in the assessment. Each control is mapped to the specific agent behaviour that enforces it.

| Compliance Requirement | Control | Enforcing Agent / Mechanism |
|---|---|---|
| **No payment without valid ABN** (GST Act) | `IngestAgent` rejects any invoice where `supplier_abn` fails the ATO ABN checksum validation algorithm. Invoice is placed in `REJECTED` state; AP Officer is notified via T1 escalation. Pipeline will not advance. | `IngestAgent` — hard rejection, non-retryable |
| **No payment without GST amount present** (GST/BAS compliance) | `IngestAgent` requires `gst_amount` ≥ 0 to be explicitly extracted. If OCR confidence on `gst_amount` < 0.80, T1 escalation is triggered. Zero-GST invoices (e.g. input-taxed supplies) must have `gst_code = GST_FREE` explicitly set by human reviewer. | `IngestAgent` — field-level confidence gate |
| **No duplicate payments** (financial control) | `DuplicateDetectionAgent` blocks all invoices with `CONFIRMED_DUPLICATE` status. `PROBABLE_DUPLICATE` invoices are suspended pending human review (T2). `PostingAgent` pre-condition check verifies `duplicate_status ≠ CONFIRMED_DUPLICATE` before posting. | `DuplicateDetectionAgent` + `PostingAgent` pre-condition |
| **Segregation of duties — non-PO invoice approval** (Corporations Act / internal financial controls) | `ApprovalRoutingAgent` enforces that the AP Officer who ingested the invoice cannot be the approver. Approver is always resolved from the SAP cost centre → manager mapping, not selected by the AP Officer. For invoices > $10,000, dual approval is mandatory (T7). | `ApprovalRoutingAgent` — approver resolution logic |
| **Audit trail for all financial postings** (Corporations Act s286 — 7-year record retention) | Per-invoice audit record (Section 5.3.2) is written on every terminal state and retained for 7 years in the AP audit store. The record is immutable and includes the full decision chain. | Arbiter — materialised on terminal state |
| **Human authorisation for all non-PO spend** (internal financial policy) | `PostingAgent` hard pre-condition: `po_number = null` invoices require `approval_ticket_id` present and `approval_outcome = APPROVED` in workflow state store. Agent will throw a non-retryable `MISSING_APPROVAL` exception if this condition is not met, regardless of other field validity. | `PostingAgent` — hard pre-condition check |
| **S/4HANA migration compatibility — no orphaned postings** (ERP consolidation constraint) | `PostingAgent` routes to SAP ECC or SAP S/4HANA based on the `entity_code` → `sap_instance` mapping (Section 3). No cross-instance posting is permitted. If `entity_code` is unmapped, T10 escalation is triggered rather than defaulting to either instance. | `PostingAgent` — instance routing logic |
| **Exception resolution within defined SLA** (late payment penalty reduction — CFO KPI) | All T4 and T5 tickets carry a `sla_due_at` of 1 business day. SLA breach triggers AP Supervisor notification. Unresolved exceptions are reported on the CFO weekly dashboard against the target of eliminating late payment penalties to < $10,000/year. | `WorkflowTicketTool` SLA monitor + Arbiter event log |
| **No autonomous posting of high-value non-PO invoices** (financial risk control) | Invoices with `po_number = null` and `invoice_total` > $10,000 require dual approval (T7) and are flagged in the audit record with `high_value_non_po = true`. This flag is available to the external auditor via the AP audit store. | `ApprovalRoutingAgent` — threshold-based routing |


---


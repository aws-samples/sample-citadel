# Agent 1 Assessment Guidelines

This directory contains assessment framework guidelines for Agent 1 (Document Review & Information Gathering).

## Purpose

These guidelines provide the structure for conducting comprehensive readiness assessments across four weighted dimensions. They are **not exact questions** but rather:

- **Points to extract**: Key information that needs to be gathered
- **Sample questions**: Example questions that can be adapted based on context
- **Scoring guidance**: High-level criteria for assessing readiness levels

## Assessment Dimensions

### 1. Technical Feasibility (30% weight)
**File**: `technical_assessment_guidelines.json`

Evaluates technical readiness across:
- Current architecture & systems
- Integration landscape
- Data strategy & readiness
- Security & identity
- Observability & operations
- Model & AI infrastructure
- Scalability & performance
- Development & deployment

### 2. Governance, Risk & Compliance (25% weight)
**File**: `governance_assessment_guidelines.json`

Evaluates governance maturity across:
- AI governance framework
- Regulatory & compliance requirements
- Risk management
- Data governance
- Model governance & explainability
- Audit & traceability
- Security governance
- Change management & approval

### 3. Business Feasibility (25% weight)
**File**: `business_assessment_guidelines.json`

Evaluates organizational readiness across:
- Business objectives & value alignment
- Stakeholder engagement & buy-in
- Organizational culture & innovation
- User adoption & change readiness
- Change management capability
- Process maturity & automation
- Skills & capabilities
- Success metrics & measurement

### 4. Commercial & Economics (20% weight)
**File**: `commercial_assessment_guidelines.json`

Evaluates financial viability across:
- Budget & investment
- Cost modeling & estimation
- Operational costs & sustainability
- Return on investment (ROI)
- Resource allocation
- Cost-benefit analysis
- Financial governance & controls
- Economic viability & market factors

## How Agent 1 Uses These Guidelines

1. **Adaptive Questioning**: Agent uses these guidelines to generate contextually appropriate questions based on:
   - User expertise level
   - Industry context
   - Information already gathered
   - Gaps identified in documents

2. **Information Extraction**: When processing documents, Agent looks for information related to these points

3. **Gap Analysis**: Agent identifies which points are missing or incomplete and generates follow-up questions

4. **Structured Output**: Agent organizes gathered information according to these categories for Agent 2 to consume

## Integration with Knowledge Base

These guidelines will be loaded into Agent 1's knowledge base (Amazon Bedrock Knowledge Base) to enable:
- Semantic search for relevant questions based on conversation context
- Dynamic question generation adapted to user responses
- Comprehensive coverage across all assessment dimensions
- Consistent assessment structure across different organizations

## Next Steps

1. Load these guidelines into Bedrock Knowledge Base
2. Configure Agent 1 system prompt to reference and use these guidelines
3. Implement adaptive questioning logic based on these frameworks
4. Test with sample conversations to validate coverage and relevance

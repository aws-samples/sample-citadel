# Agent 2: High-Level Design Consultant - Detailed Design

## Agent Overview
**Name**: High-Level Design Consultant  
**Module**: Module 2 (High-Level Design)  
**Primary Function**: Generate consultant-level High-Level Design (HLD) document from Agent 1 assessment data. Transform assessment findings into business-focused solution design with conceptual technical approach for handoff to Agent 3 (technical architect).

**Role**: Consultant (like Agent 1 is a BA). Creates business-focused HLD covering business solution, commercial viability, governance, and conceptual technical approach - NOT detailed technical design.

## Implementation Status
✅ **Fully Implemented** - Agent deployed on Amazon Bedrock AgentCore Runtime with progressive section-based HLD generation (18 sections), AWS Knowledge MCP integration, and automatic PDF generation.

## Functional Requirements

### Core Capabilities
- ✅ **Progressive HLD Generation**: Section-by-section generation of 18-section consultant-level HLD
- ✅ **Assessment Data Integration**: Retrieves and references Agent 1 assessment data across all 4 dimensions
- ✅ **AWS Pattern Research**: Searches AWS Knowledge MCP for conceptual solution patterns
- ✅ **Business-Focused Documentation**: Generates markdown with business language and conceptual diagrams
- ✅ **Automatic PDF Generation**: Converts final markdown to PDF using pandoc
- ✅ **Progress Tracking**: Real-time section completion tracking with metadata

### HLD Document Structure (18 Sections)

#### Section 1: Document Control (3 sections)
- 1.1 Document Purpose
- 1.2 Revision History
- 1.3 Stakeholders

#### Section 2: Executive Summary (1 section)
- 2.0 Executive Summary (800 words)

#### Section 3: Business Solution (5 sections)
- 3.1 Problem Statement
- 3.2 Solution Objectives
- 3.3 Proposed Solution Approach (business view)
- 3.4 Functional and Non-Functional Requirements
- 3.5 Change Management Strategy

#### Section 4: Commercial (3 sections)
- 4.1 Investment Summary
- 4.2 Business Case and ROI
- 4.3 Delivery Approach and Timeline

#### Section 5: Governance (4 sections)
- 5.1 Compliance and Regulatory Requirements
- 5.2 Risk Assessment and Mitigation
- 5.3 Security and Privacy Approach (high-level)
- 5.4 Governance Framework

#### Section 6: Technical Approach (2 sections)
- 6.1 Conceptual Architecture (boxes and arrows, not detailed design)
- 6.2 Technical Approach and Principles (guidance for Agent 3)

### Assessment Dimensions Integration

Agent 2 receives assessment data from Agent 1 across four dimensions and maps them to HLD sections:

#### Business (25% Weight) → Sections 3.1-3.5, 2.0
**Input**: Value alignment, user adoption, organizational culture, stakeholder buy-in  
**Output Sections**: Problem statement, objectives, solution approach, functional requirements, change management

#### Commercial (20% Weight) → Sections 4.1-4.3, 2.0
**Input**: Budget constraints, ROI expectations, operational costs, resource allocation  
**Output Sections**: Investment summary, business case/ROI, delivery approach

#### Governance (25% Weight) → Sections 5.1-5.4, 2.0
**Input**: Regulatory requirements, risk tolerance, governance framework, audit requirements  
**Output Sections**: Compliance, risk assessment, security approach, governance framework

#### Technical (30% Weight) → Sections 6.1-6.2, 2.0
**Input**: Current architecture, infrastructure, integration, data strategy, performance requirements  
**Output Sections**: Conceptual architecture, technical principles (for Agent 3)

## Technical Architecture

### Core Components
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Agent 1 Output  │───▶│  Design Engine   │───▶│  HLD Document   │
│ (Assessment)    │    │  (Agent 2 Core)  │    │  (18 Sections)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ AWS Knowledge   │    │ Section-by-      │    │ PDF Generation  │
│  MCP Server     │    │ Section Storage  │    │    (Pandoc)     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Sliding Window  │    │   DynamoDB       │    │   CloudWatch    │
│ Conversation    │    │ Progress Track   │    │    Logging      │
│ Manager (20msg) │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### AWS Services Integration
- ✅ **Amazon Bedrock AgentCore Runtime**: Agent hosting with auto-scaling
- ✅ **Amazon Nova Pro**: Design generation model (temperature 0.3, max_tokens 10000)
- ✅ **Sliding Window Conversation Manager**: Token management with 20-message window
- ✅ **Amazon S3**: Section-based storage with metadata tracking
- ✅ **Amazon DynamoDB**: Progress tracking and design state management
- ✅ **AWS Knowledge MCP Server**: External AWS documentation access (conceptual patterns)
- ✅ **Pandoc + XeLaTeX**: PDF generation from markdown

### Design Generation Workflow
1. ✅ **Initialize Structure**: Create 18-section framework with metadata.json
2. ✅ **Get Next Section**: Retrieve next pending section with context from template
3. ✅ **Retrieve Assessment Data**: Load Agent 1 data for relevant dimensions
4. ✅ **Search AWS Patterns**: Find relevant conceptual AWS solution patterns (optional)
5. ✅ **Generate Section Content**: Create 300-1000 word section with business focus
6. ✅ **Save Section**: Store to S3 and update progress metadata
7. ✅ **Repeat**: Continue until all 18 sections complete
8. ✅ **Assemble Document**: Concatenate all sections into final HLD
9. ✅ **Generate PDF**: Convert markdown to PDF with table of contents

## Content Guidelines

### Business Focus
- Write for executives and business stakeholders
- Explain WHAT and WHY, not detailed HOW
- Focus on business outcomes, not technical implementation
- Use business language, avoid deep technical jargon

### Conceptual Technical Approach
- Show major components and how they interact (conceptual diagram)
- Explain technology choices at strategic level (why AWS, why serverless, etc.)
- NO detailed architecture (no VPCs, subnets, security groups, etc.)
- NO implementation details (Agent 3 handles this)

### Commercial Viability
- Clear cost breakdown and ROI justification
- Delivery timeline and phasing
- Resource requirements (high-level)

### Governance & Risk
- Compliance requirements and approach
- Risk assessment with mitigation strategies
- Security principles (not detailed controls)

### Handoff to Agent 3
- HLD provides strategic direction and constraints
- Agent 3 (technical architect) creates detailed technical design
- Focus on WHAT needs to be built, not HOW to build it

## Tools

### Core Tools
1. **initialize_hld_structure()**: Set up 18-section framework
2. **get_next_section_to_generate()**: Get next section to work on
3. **get_assessment_data(dimension)**: Retrieve assessment findings
4. **search_aws_patterns(query)**: Find conceptual AWS patterns
5. **save_design_output(section_id, content)**: Save section
6. **assemble_hld_document()**: Create final document

## Success Metrics
- Document completeness: All 18 sections generated
- Business focus: Appropriate abstraction level for consultant role
- Assessment integration: References to Agent 1 findings
- Handoff quality: Clear guidance for Agent 3
- Generation time: ~15-20 minutes for full HLD

## Data Models

### HLD Template Structure (hld_template.json)
```json
{
  "document_title": "High-Level Design - Agentic AI Solution",
  "version": "1.0",
  "total_sections": 18,
  "sections": [
    {
      "id": "3.4",
      "title": "Functional and Non-Functional Requirements",
      "folder": "3_business_solution",
      "filename": "3.4_requirements.md",
      "description": "What the solution must do (functional) and how well it must perform (non-functional)",
      "word_count_target": 1200,
      "assessment_dimensions": ["business", "technical", "governance"],
      "required_content": [
        "Core functional requirements",
        "Performance requirements (response times, throughput)",
        "Scalability requirements (expected growth, peak loads)",
        "Availability requirements (SLAs, uptime, RTO/RPO)",
        "Operational requirements (monitoring, support)"
      ]
    }
  ]
}
```

### Metadata Structure (S3)
```json
{
  "session_id": "uuid",
  "total_sections": 18,
  "completed_sections": 10,
  "sections": {
    "3.4": {
      "status": "COMPLETE",
      "title": "Functional and Non-Functional Requirements",
      "path": "3_business_solution/3.4_requirements.md",
      "word_count": 1180,
      "completed_at": 1234567890
    }
  },
  "last_updated": 1234567890
}
```

### DynamoDB Progress Tracking
```json
{
  "p_key": "session_id",
  "s_key": "design:hld:latest",
  "section_id": "3.4",
  "section_title": "Functional and Non-Functional Requirements",
  "word_count": 1180,
  "completion_percentage": 55,
  "timestamp": 1234567890,
  "record_type": "latest",
  "s3_location": "s3://bucket/session/design/hld/3_business_solution/3.4_requirements.md"
}
```

## Tool Implementation

### 1. initialize_hld_structure()
- ✅ **Template Loading**: Reads hld_template.json with 18 section definitions
- ✅ **Metadata Creation**: Creates metadata.json in S3 with all sections marked PENDING
- ✅ **Progress Initialization**: Sets up tracking for 18-section generation

### 2. get_next_section_to_generate()
- ✅ **Section Selection**: Returns next PENDING section in order
- ✅ **Context Provision**: Provides description, word count target, assessment dimensions, required content
- ✅ **Progress Reporting**: Shows completed/total sections and percentage

### 3. get_assessment_data(dimension)
- ✅ **Agent 1 Integration**: Retrieves assessment data from Agent 1's S3 storage
- ✅ **Dimension-Specific**: Gets data for technical, business, commercial, or governance
- ✅ **Structured Output**: Returns inference_result, metadata, field_sources

### 4. search_aws_patterns(query)
- ✅ **AWS Knowledge MCP**: Searches AWS documentation via JSON-RPC
- ✅ **Pattern Discovery**: Finds relevant solution architectures and best practices
- ✅ **Timeout Handling**: 30-second timeout with error handling

### 5. read_aws_documentation(url)
- ✅ **Documentation Retrieval**: Reads specific AWS doc URLs via MCP
- ✅ **Markdown Format**: Returns documentation in markdown format
- ✅ **Service Details**: Gets detailed implementation guidance

### 6. save_design_output(section_id, content)
- ✅ **S3 Storage**: Saves section to structured path
- ✅ **Metadata Update**: Updates section status to COMPLETE with word count
- ✅ **Progress Calculation**: Recalculates completion percentage
- ✅ **DynamoDB Logging**: Records section completion with timestamp

### 7. get_design_output(section_id)
- ✅ **Section Retrieval**: Gets existing section content for review/iteration
- ✅ **Status Check**: Returns PENDING status if section not yet generated

### 8. assemble_hld_document(generate_pdf)
- ✅ **Section Concatenation**: Combines all 18 sections in order
- ✅ **Markdown Assembly**: Creates final high_level_design.md
- ✅ **PDF Generation**: Runs pandoc with xelatex engine
- ✅ **S3 Upload**: Saves both .md and .pdf to S3

### 9. get_hld_progress()
- ✅ **Progress Overview**: Shows completed vs pending sections
- ✅ **Section List**: Lists all sections with status and word counts
- ✅ **Percentage Calculation**: Overall completion percentage

## Environment Configuration

### Required Environment Variables
```bash
# AWS Configuration
AWS_REGION=ap-southeast-2

# Storage
SESSION_BUCKET=citadel-sessions-dev
SESSION_MEMORY_TABLE=citadel-session-memory-dev


```

### System Dependencies (for PDF generation)
```bash
# Required for pandoc PDF generation
pandoc
texlive-xetex
texlive-fonts-recommended
```

## Processing Logic

### Progressive Section Generation
```python
# Global session state
session = {
    'session_id': 'from_payload'
}

# Conversation manager for token efficiency
conversation_manager = SlidingWindowConversationManager(
    window_size=20,  # Maximum 20 messages
    should_truncate_results=True  # Truncate large tool results
)

# Bedrock model configuration
bedrock_model = BedrockModel(
    model_id="amazon.nova-pro-v1:0",
    temperature=0.3,
    top_p=0.8,
    max_tokens=10000
)

# 1. Initialize structure
initialize_hld_structure()

# 2. Loop through all 18 sections
while sections_remaining:
    # Get next section with context
    section = get_next_section_to_generate()
    
    # Retrieve assessment data for relevant dimensions
    for dimension in section.assessment_dimensions:
        assessment_data = get_assessment_data(dimension)
    
    # Research AWS patterns (optional, conceptual only)
    patterns = search_aws_patterns(section.title)
    
    # Generate section content (300-1200 words)
    content = generate_section(section, assessment_data, patterns)
    
    # Save section and update progress
    save_design_output(section.id, content)

# 3. Assemble final document
assemble_hld_document(generate_pdf=True)
```

### Content Quality Standards
- ✅ **Word Count Targets**: 300-1200 words per section (~15,000-20,000 total)
- ✅ **Required Content**: All checklist items from template included
- ✅ **Assessment References**: Explicit references to Agent 1 data
- ✅ **Business Language**: Consultant-level, not technical implementation
- ✅ **Conceptual Diagrams**: Simple boxes and arrows, not detailed architecture
- ✅ **Markdown Formatting**: Blank lines between paragraphs for PDF rendering

## Integration Points

### Input Interfaces
- ✅ **Agent 1 Assessment Data**: S3-based assessment results per dimension
- ✅ **Session Context**: Conversation state and session ID
- ✅ **HLD Template**: Static template with 30 section definitions

### Output Interfaces
- ✅ **Agent 3 Design Handoff**: Complete HLD document (markdown + PDF)
- ✅ **Progress Tracking**: Real-time section completion status
- ✅ **S3 Artifacts**: Individual sections + assembled document

## Quality Assurance

### Design Validation
- ✅ **Template Compliance**: All sections follow template structure
- ✅ **Assessment Integration**: Designs reference specific Agent 1 findings
- ✅ **Business Focus**: Appropriate abstraction level for consultant role
- ✅ **Completeness**: All 18 sections generated before assembly

### Content Quality
- ✅ **Comprehensive Coverage**: Business, commercial, governance, and conceptual technical approach
- ✅ **Visual Clarity**: Simple conceptual diagrams enhance understanding
- ✅ **Actionable Guidance**: Clear strategic direction for Agent 3
- ✅ **Professional Format**: Enterprise-grade documentation standards

## Performance Considerations

### Design Optimization
- ✅ **Section-Based Generation**: Manageable 200-1500 word chunks
- ✅ **Template-Driven**: Consistent structure and quality
- ✅ **Progress Tracking**: Real-time visibility into generation status
- ✅ **Resume Capability**: Can pause and resume generation

### Scalability
- ✅ **Session Isolation**: Each session generates independently
- ✅ **S3 Storage**: Scalable section-based storage
- ✅ **Metadata Efficiency**: Lightweight JSON tracking
- ✅ **Concurrent Sessions**: Multiple HLD generations in parallel

## Security & Compliance

### Data Protection
- ✅ **S3 Encryption**: Server-side encryption for all sections
- ✅ **DynamoDB Encryption**: Encrypted progress tracking
- ✅ **Session Isolation**: Design data isolated by session ID
- ✅ **TTL Cleanup**: Automatic data expiration after 90 days

### Design Integrity
- ✅ **Version Control**: Timestamped section saves
- ✅ **Source Attribution**: Links to AWS documentation sources
- ✅ **Audit Trail**: Complete generation history in DynamoDB

## Monitoring & Observability

### Key Metrics
- ✅ **Section Completion Rate**: Sections completed per session
- ✅ **AWS Documentation Usage**: MCP call frequency and success rate
- ✅ **Generation Time**: Time per section and total HLD generation
- ✅ **PDF Generation Success**: Pandoc conversion success rate
- ✅ **Conversation Window**: Token management and message truncation effectiveness

### Alerting
- ✅ **Incomplete Designs**: Alert when HLD remains unfinished
- ✅ **MCP Connectivity**: Alert for AWS Knowledge MCP issues
- ✅ **PDF Generation Failures**: Alert for pandoc errors
- ✅ **Quality Degradation**: Alert when word counts or quality decline

## Testing & Validation

### Test Coverage
- ✅ **Section Generation**: Individual section generation testing
- ✅ **Template Compliance**: Validation against 18-section hld_template.json
- ✅ **Assessment Integration**: Verify Agent 1 data retrieval
- ✅ **PDF Generation**: End-to-end markdown to PDF conversion

### Validation Tools
- ✅ **Local Testing**: Run agent locally with test session IDs
- ✅ **Progress Monitoring**: Check metadata.json and DynamoDB state
- ✅ **Document Review**: Validate assembled HLD quality and business focus
- ✅ **PDF Verification**: Ensure proper formatting and rendering

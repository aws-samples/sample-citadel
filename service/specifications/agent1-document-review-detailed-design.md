# Agent 1: Document Review & Information Gathering - Detailed Design

## Agent Overview
**Name**: Assessment Agent  
**Module**: Module 1 (Assessment & Evaluation)  
**Primary Function**: Gather information about customer's current systems and business requirements through document extraction and conversational assessment, following a business-first BA/consultant approach

**Assessment Order**: Business (25%) → Commercial (20%) → Technical (30%) → Governance (25%)

## Implementation Status
✅ **Fully Implemented** - Agent deployed on Amazon Bedrock AgentCore Runtime with Haiku 4.5, conversation management, document processing, gap analysis, and incremental progress tracking.

## Functional Requirements

### Core Capabilities
- ✅ **Business-First Approach**: Starts with business dimension to validate problem before technical assessment
- ✅ **Bedrock Data Automation Integration**: Uses blueprint-based extraction for structured document analysis
- ✅ **Multi-dimensional Assessment**: Business, Commercial, Technical, Governance (in that order)
- ✅ **Claude Sonnet Gap Analysis**: Dedicated LLM-powered gap identification and question generation
- ✅ **Incremental Saving**: Saves after every user response, merges automatically with existing data
- ✅ **Conversation Management**: SummarizingConversationManager handles long conversations
- ✅ **Percentage-Based Progress**: Overall progress = average of dimension completion percentages
- ✅ **Session-based Processing**: Maintains state across document uploads and conversations
- ✅ **Smart Data Merging**: Combines extracted data with user responses using confidence scoring
- ✅ **Real-time Progress Tracking**: DynamoDB-based session memory with completion percentages

### Input Processing
- ✅ **Document Upload Handler**: Session-scoped document storage in S3
- ✅ **Blueprint Selection**: Dynamic blueprint selection based on assessment dimension
- ✅ **Bedrock Data Automation**: Automated content parsing using pre-configured blueprints
- ✅ **Confidence Analysis**: Field-level confidence scoring and completeness tracking

### Information Extraction
- ✅ **Structured Extraction**: Blueprint-based field extraction with explainability data
- ✅ **Field Completeness Analysis**: Automatic detection of empty and filled fields
- ✅ **Confidence Metrics**: Min/max/average confidence calculation across extracted fields
- ✅ **Storage Optimization**: Full data stored in S3, summaries returned to agent for token efficiency

## Technical Architecture

### Current Implementation
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   AgentCore     │───▶│  Bedrock Data    │───▶│ Claude Sonnet   │
│   Runtime       │    │   Automation     │    │ Gap Analysis    │
│  (Haiku 4.5)    │    │                  │    │   (4.5 Model)   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Session S3    │    │   DynamoDB       │    │  Smart Merging  │
│   Storage       │    │ Session Memory   │    │     Engine      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Conversation   │    │   CloudWatch     │    │   FastAPI       │
│   Summarizer    │    │    Logging       │    │  CORS Support   │
│                 │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### AWS Services Integration
- ✅ **Amazon Bedrock AgentCore**: Agent runtime with auto-scaling and memory management
- ✅ **Claude Haiku 4.5**: Main agent model for reasoning and conversation
- ✅ **SummarizingConversationManager**: Manages long conversations (30% summarization, 10 recent messages)
- ✅ **Amazon Bedrock Data Automation**: Blueprint-based document extraction
- ✅ **Amazon S3**: Session-scoped document and extracted data storage
- ✅ **Amazon DynamoDB**: Session memory with timestamped snapshots and latest state
- ✅ **Claude Sonnet 4.5**: Dedicated gap analysis and question generation
- ✅ **AgentCore Gateway**: Assessment guidelines retrieval via OAuth

### Processing Pipeline
1. ✅ **Session Initialization**: Global session state management in AgentCore micro VM
2. ✅ **Business-First Assessment**: Always starts with business dimension unless user requests otherwise
3. ✅ **Document Upload**: Session-scoped S3 storage with document key tracking
4. ✅ **Blueprint Extraction**: Bedrock Data Automation with dimension-specific blueprints
5. ✅ **Confidence Analysis**: Field completeness and confidence scoring
6. ✅ **Gap Analysis**: Claude Sonnet 4.5-powered comparison against assessment guidelines (not saved, just used for guidance)
7. ✅ **Interactive Questioning**: ONE question at a time, targeting ONE field
8. ✅ **Incremental Saving**: Save after EVERY user response, tool merges automatically
9. ✅ **Progress Tracking**: Real-time percentage-based progress (average of dimensions)
10. ✅ **Dimension Transition**: User controls when to move on, agent announces transition
11. ✅ **Conversation Summarization**: Automatic summarization when context gets long
12. ✅ **Observability**: CloudWatch logging and X-Ray tracing for monitoring and debugging

## Data Models

### Session State Structure
```json
{
  "session_id": "string",
  "last_document_upload_key": "string",
  "assessment_progress": {
    "technical": {"completion_percentage": "number"},
    "business": {"completion_percentage": "number"},
    "commercial": {"completion_percentage": "number"},
    "governance": {"completion_percentage": "number"}
  }
}
```

**Progress Calculation**: Overall progress = (business% + commercial% + technical% + governance%) / 4

### Extracted Content Structure (S3)
```json
{
  "inference_result": {
    "field_name": "extracted_value",
    "another_field": "extracted_value"
  },
  "explainability_info": [{
    "field_name": {
      "success": true,
      "confidence": 0.85,
      "geometry": "bounding_box_data",
      "type": "string",
      "value": "extracted_value"
    }
  }],
  "_metadata": {
    "last_updated": "timestamp",
    "field_sources": {
      "field_name": {
        "source": "extraction|user_input",
        "timestamp": "number",
        "confidence": "number"
      }
    },
    "gap_filling_active": "boolean"
  }
}
```

### DynamoDB Session Memory
```json
{
  "p_key": "session_id",
  "s_key": "assessment:latest|assessment:timestamp",
  "dimension": "technical|business|commercial|governance",
  "data": "assessment_data",
  "timestamp": "number",
  "completion_percentage": "number",
  "record_type": "latest|snapshot|extraction",
  "ttl": "number"
}
```

## Tool Implementation

### 1. query_assessment_guidelines(dimension, category)
- ✅ **AgentCore Gateway Integration**: OAuth-based Confluence access
- ✅ **Dimension-based Retrieval**: Gets current BA/consultant-style guidelines for specific assessment areas
- ✅ **Secrets Manager**: OAuth credentials stored securely in AWS Secrets Manager

### 2. extract_document_content(dimension)
- ✅ **Blueprint Selection**: Environment variable-based blueprint ARN lookup
- ✅ **Bedrock Data Automation**: Async job processing with status polling
- ✅ **Confidence Analysis**: Min/max/average confidence calculation
- ✅ **Field Completeness**: Total/filled/empty field counting
- ✅ **Session Storage**: Full data stored in S3, summary returned to agent
- ✅ **DynamoDB Logging**: Extraction metadata logged for audit trail

### 3. analyze_document_gaps(dimension)
- ✅ **Claude Sonnet Integration**: Dedicated LLM for sophisticated gap analysis
- ✅ **Guidelines Comparison**: Compares extracted data against current assessment requirements
- ✅ **Structured Output**: JSON format with prioritized questions and completeness assessment
- ✅ **Confidence-based Analysis**: Identifies low-confidence fields needing verification
- ✅ **Not Saved**: Gap analysis is used for guidance only, not persisted as assessment data

### 4. get_blueprint_fields(dimension)
- ✅ **Schema Retrieval**: Gets exact blueprint field names and descriptions
- ✅ **Field Mapping**: Helps agent map user responses to correct field names
- ✅ **JSON Parsing**: Handles blueprint schema as JSON string from Bedrock API

### 5. get_assessment_data(dimension)
- ✅ **Current State Retrieval**: Loads existing assessment data from S3
- ✅ **Field Source Tracking**: Shows which fields came from extraction vs user input
- ✅ **Completeness View**: Shows filled vs empty fields

### 6. get_session_state()
- ✅ **Progress Overview**: Shows completion percentage for all dimensions
- ✅ **Overall Progress**: Calculates average of dimension percentages
- ✅ **Session History**: Recent activity and timestamps

### 7. save_assessment_data(session_id, dimension, data)
- ✅ **Incremental Saving**: Saves single field or multiple fields
- ✅ **S3 Smart Merging**: Loads existing data, merges new data, keeps unchanged fields
- ✅ **Source Tracking**: Records whether data came from extraction or user input
- ✅ **Progress Calculation**: Updates completion percentages automatically
- ✅ **DynamoDB Persistence**: Timestamped snapshots and latest state tracking
- ✅ **EventBridge Events**: Publishes progress updates for UI

## Environment Configuration

### Required Environment Variables
```bash
# AWS Configuration
AWS_REGION=ap-southeast-2

# Storage (with fallback defaults in code)
DOCUMENT_BUCKET=citadel-documents-dev  # Default fallback
SESSION_BUCKET=citadel-sessions-dev    # Default fallback
SESSION_MEMORY_TABLE=citadel-session-memory-dev  # Default fallback

# Bedrock Data Automation Blueprints
EXTRACT_BLUEPRINT_ARN_TECHNICAL=arn:aws:bedrock:region:account:blueprint/id
EXTRACT_BLUEPRINT_ARN_BUSINESS=arn:aws:bedrock:region:account:blueprint/id
EXTRACT_BLUEPRINT_ARN_COMMERCIAL=arn:aws:bedrock:region:account:blueprint/id
EXTRACT_BLUEPRINT_ARN_GOVERNANCE=arn:aws:bedrock:region:account:blueprint/id

# AgentCore Gateway
AGENTCORE_GATEWAY_URL=https://gateway-url
ACGW_SECRETS_ARN=arn:aws:secretsmanager:region:account:secret:name


```

### OAuth Secrets Structure
```json
{
  "client_id": "oauth_client_id",
  "client_secret": "oauth_client_secret",
  "token_url": "https://auth.atlassian.com/oauth/token",
  "confluence_domain": "domain-name"
}
```

## Processing Logic

### Document Analysis Workflow
1. ✅ **Start with Business**: Always begin with business dimension to validate problem
2. ✅ **Check Existing State**: Use get_session_state() and get_assessment_data() to see what's already filled
3. ✅ **Document Upload (Optional)**: If user uploads document, extract with appropriate dimension
4. ✅ **Blueprint Fields**: Get exact field names using get_blueprint_fields()
5. ✅ **Gap Analysis**: Use analyze_document_gaps() to identify what's missing (don't save this)
6. ✅ **Contextual Questioning**: Summarize what's already known, then ask ONE question about ONE field
7. ✅ **Immediate Saving**: After EVERY user response, call save_assessment_data() with field name and value
8. ✅ **Smart Merging**: Tool automatically merges with existing data, tracks source
9. ✅ **Repeat**: Ask next question, save response, ask next question, save response
10. ✅ **Dimension Transition**: When user says "let's move on", announce completion percentage and move to next dimension
11. ✅ **Follow Order**: Business → Commercial → Technical → Governance

### Session Management
```python
# Global session state in AgentCore micro VM
session = {
    'session_id': 'from_payload',
    'last_document_upload_key': 'tracked_per_upload'
}

# DynamoDB persistence with dual records
# Latest state: assessment:latest
# Historical snapshots: assessment:{timestamp}
```

### Gap Analysis Algorithm (Claude Sonnet 4.5)
```python
def analyze_document_gaps(session_id, dimension):
    # 1. Load extracted data from S3
    # 2. Get current guidelines via query_assessment_guidelines()
    # 3. Use Claude Sonnet 4.5 for expert analysis
    # 4. Return structured JSON with priorities and questions
    
    prompt = f"""
    You are an expert assessment gap analyzer. Perform comprehensive analysis of document 
    extraction completeness for {dimension} assessment.
    
    Compare extracted data against guidelines:
    - Critical missing information
    - Low confidence fields (< 0.7)
    - Incomplete responses
    - Prioritized follow-up questions
    - Completeness assessment
    
    Return structured JSON with priorities and actionable insights.
    """
    
    # Uses Claude Sonnet 4.5 (au.anthropic.claude-sonnet-4-5-20250929-v1:0)
    # for sophisticated gap analysis and question generation
```

## Integration Points

### Input Interfaces
- ✅ **AgentCore Runtime**: HTTP-based invocation with streaming responses
- ✅ **Session Management**: Global session state within agent instance
- ✅ **Document Upload**: Session-scoped S3 storage with key tracking

### Output Interfaces
- ✅ **DynamoDB Session Memory**: Shared state accessible to all agents
- ✅ **S3 Consolidated Data**: Merged extraction and user input data
- ✅ **Streaming Responses**: Real-time conversation via AgentCore

## Quality Assurance

### Validation Rules
- ✅ **Blueprint Validation**: Environment variable checks for blueprint ARNs
- ✅ **Confidence Thresholds**: 0.7 threshold for verification requirements
- ✅ **Field Completeness**: Automatic empty field detection and reporting
- ✅ **Session Continuity**: Global session state prevents data loss

### Error Handling
- ✅ **Extraction Failures**: Graceful error handling with detailed error messages
- ✅ **Missing Blueprints**: Clear error messages for missing environment variables
- ✅ **S3 Access**: Handles missing files and access errors
- ✅ **DynamoDB Resilience**: TTL-based cleanup and error recovery

## Performance Considerations

### Scalability
- ✅ **AgentCore Auto-scaling**: Automatic scaling based on demand
- ✅ **Session Isolation**: Each session runs in isolated micro VM
- ✅ **Async Processing**: Bedrock Data Automation jobs run asynchronously
- ✅ **Token Optimization**: Full data stored in S3, summaries returned to agent

### Optimization
- ✅ **Blueprint Caching**: Environment variable-based blueprint selection
- ✅ **Confidence-based Prioritization**: Focus on low-confidence fields first
- ✅ **Smart Merging**: Efficient S3 read/write operations
- ✅ **Session Memory**: DynamoDB-based state management with TTL cleanup

## Security & Compliance

### Data Protection
- ✅ **S3 Encryption**: Server-side encryption for all stored documents
- ✅ **DynamoDB Encryption**: Encrypted session state storage
- ✅ **OAuth Security**: Secure credential storage in AWS Secrets Manager
- ✅ **Session Isolation**: AgentCore micro VM isolation per session

### Privacy Considerations
- ✅ **TTL Cleanup**: Automatic data expiration after 90 days
- ✅ **Session Scoping**: Data isolated by session ID
- ✅ **Source Tracking**: Clear audit trail of data sources
- ✅ **Confidence Transparency**: Extraction confidence scores provided to users

## Monitoring & Observability

### Key Metrics
- ✅ **AgentCore Metrics**: Built-in performance and usage metrics
- ✅ **Extraction Confidence**: Field-level confidence scoring and reporting
- ✅ **Session Progress**: Completion percentages per dimension and overall average
- ✅ **Gap Analysis Quality**: Claude Sonnet 4.5 analysis effectiveness
- ✅ **Conversation Management**: Summarization frequency and token usage optimization
- ✅ **Incremental Saves**: Save frequency and merge success rate

### Alerting
- ✅ **AgentCore Monitoring**: Real-time agent health and availability
- ✅ **CloudWatch Integration**: Comprehensive logging and metrics
- ✅ **X-Ray Tracing**: Distributed tracing across services
- ✅ **GenAI Dashboard**: Specialized monitoring for AI workloads

## Testing & Validation

### Test Coverage
- ✅ **Unit Tests**: Individual tool function testing
- ✅ **Integration Tests**: End-to-end workflow validation
- ✅ **CLI Testing**: Interactive testing via agent_local_cli_interactive.py
- ✅ **Session Continuity**: Custom session ID testing for state management

### Validation Tools
- ✅ **Local CLI**: Interactive testing with custom session IDs
- ✅ **Document Upload**: Upload command for testing extraction workflows
- ✅ **Gap Analysis**: Real-time gap analysis testing with Claude Sonnet
- ✅ **Progress Tracking**: Session state validation via DynamoDB queries

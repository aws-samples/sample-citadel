/**
 * Operations Registry
 *
 * Static registry mapping SaaS integration types to their available operation
 * descriptors. AgentCore types (AWS_LAMBDA, AWS_SMITHY, MCP_SERVER) discover
 * operations dynamically and are intentionally excluded.
 *
 * Follows the Open/Closed Principle: new integration types are added as new
 * keys without modifying existing entries.
 *
 * @module operations-registry
 */

interface OperationParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface OperationDescriptor {
  operationId: string;
  name: string;
  description: string;
  method: string;
  parameters: OperationParameter[];
}

const AGENTCORE_TYPES = new Set(['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER']);

const OPERATIONS_REGISTRY: Record<string, OperationDescriptor[]> = {
  CONFLUENCE: [
    {
      operationId: 'get_page',
      name: 'Get Page',
      description: 'Retrieve a Confluence page by its ID',
      method: 'GET',
      parameters: [
        { name: 'pageId', type: 'string', required: true, description: 'The ID of the page to retrieve' },
        { name: 'expand', type: 'string', required: false, description: 'Comma-separated list of properties to expand' },
      ],
    },
    {
      operationId: 'search_pages',
      name: 'Search Pages',
      description: 'Search for Confluence pages using CQL',
      method: 'GET',
      parameters: [
        { name: 'cql', type: 'string', required: true, description: 'Confluence Query Language expression' },
        { name: 'limit', type: 'number', required: false, description: 'Maximum number of results' },
      ],
    },
    {
      operationId: 'create_page',
      name: 'Create Page',
      description: 'Create a new Confluence page',
      method: 'POST',
      parameters: [
        { name: 'spaceKey', type: 'string', required: true, description: 'Space key where the page will be created' },
        { name: 'title', type: 'string', required: true, description: 'Page title' },
        { name: 'body', type: 'string', required: true, description: 'Page body content in storage format' },
        { name: 'parentId', type: 'string', required: false, description: 'Parent page ID' },
      ],
    },
    {
      operationId: 'update_page',
      name: 'Update Page',
      description: 'Update an existing Confluence page',
      method: 'PUT',
      parameters: [
        { name: 'pageId', type: 'string', required: true, description: 'The ID of the page to update' },
        { name: 'title', type: 'string', required: true, description: 'Updated page title' },
        { name: 'body', type: 'string', required: true, description: 'Updated page body content' },
        { name: 'version', type: 'number', required: true, description: 'Current version number for optimistic locking' },
      ],
    },
  ],

  JIRA: [
    {
      operationId: 'get_issue',
      name: 'Get Issue',
      description: 'Retrieve a Jira issue by its key or ID',
      method: 'GET',
      parameters: [
        { name: 'issueIdOrKey', type: 'string', required: true, description: 'The ID or key of the issue' },
        { name: 'fields', type: 'string', required: false, description: 'Comma-separated list of fields to return' },
      ],
    },
    {
      operationId: 'search_issues',
      name: 'Search Issues',
      description: 'Search for Jira issues using JQL',
      method: 'GET',
      parameters: [
        { name: 'jql', type: 'string', required: true, description: 'JQL query string' },
        { name: 'maxResults', type: 'number', required: false, description: 'Maximum number of results to return' },
        { name: 'startAt', type: 'number', required: false, description: 'Index of the first result to return' },
      ],
    },
    {
      operationId: 'create_issue',
      name: 'Create Issue',
      description: 'Create a new Jira issue',
      method: 'POST',
      parameters: [
        { name: 'projectKey', type: 'string', required: true, description: 'Project key for the new issue' },
        { name: 'summary', type: 'string', required: true, description: 'Issue summary' },
        { name: 'issueType', type: 'string', required: true, description: 'Issue type name (e.g., Bug, Task, Story)' },
        { name: 'description', type: 'string', required: false, description: 'Issue description' },
      ],
    },
    {
      operationId: 'update_issue',
      name: 'Update Issue',
      description: 'Update an existing Jira issue',
      method: 'PUT',
      parameters: [
        { name: 'issueIdOrKey', type: 'string', required: true, description: 'The ID or key of the issue to update' },
        { name: 'summary', type: 'string', required: false, description: 'Updated summary' },
        { name: 'description', type: 'string', required: false, description: 'Updated description' },
        { name: 'status', type: 'string', required: false, description: 'Transition to this status' },
      ],
    },
    {
      operationId: 'add_comment',
      name: 'Add Comment',
      description: 'Add a comment to a Jira issue',
      method: 'POST',
      parameters: [
        { name: 'issueIdOrKey', type: 'string', required: true, description: 'The ID or key of the issue' },
        { name: 'body', type: 'string', required: true, description: 'Comment body text' },
      ],
    },
  ],

  SLACK: [
    {
      operationId: 'send_message',
      name: 'Send Message',
      description: 'Send a message to a Slack channel',
      method: 'POST',
      parameters: [
        { name: 'channel', type: 'string', required: true, description: 'Channel ID or name to send the message to' },
        { name: 'text', type: 'string', required: true, description: 'Message text content' },
        { name: 'threadTs', type: 'string', required: false, description: 'Thread timestamp to reply in a thread' },
      ],
    },
    {
      operationId: 'list_channels',
      name: 'List Channels',
      description: 'List available Slack channels in the workspace',
      method: 'GET',
      parameters: [
        { name: 'limit', type: 'number', required: false, description: 'Maximum number of channels to return' },
        { name: 'cursor', type: 'string', required: false, description: 'Pagination cursor for next page' },
      ],
    },
    {
      operationId: 'get_channel_history',
      name: 'Get Channel History',
      description: 'Retrieve message history from a Slack channel',
      method: 'GET',
      parameters: [
        { name: 'channel', type: 'string', required: true, description: 'Channel ID to fetch history from' },
        { name: 'limit', type: 'number', required: false, description: 'Maximum number of messages to return' },
        { name: 'oldest', type: 'string', required: false, description: 'Only messages after this timestamp' },
      ],
    },
  ],

  SERVICENOW: [
    {
      operationId: 'get_incident',
      name: 'Get Incident',
      description: 'Retrieve a ServiceNow incident by sys_id',
      method: 'GET',
      parameters: [
        { name: 'sysId', type: 'string', required: true, description: 'The sys_id of the incident' },
      ],
    },
    {
      operationId: 'list_incidents',
      name: 'List Incidents',
      description: 'List ServiceNow incidents with optional filters',
      method: 'GET',
      parameters: [
        { name: 'query', type: 'string', required: false, description: 'Encoded query string for filtering' },
        { name: 'limit', type: 'number', required: false, description: 'Maximum number of results' },
      ],
    },
    {
      operationId: 'create_incident',
      name: 'Create Incident',
      description: 'Create a new ServiceNow incident',
      method: 'POST',
      parameters: [
        { name: 'shortDescription', type: 'string', required: true, description: 'Short description of the incident' },
        { name: 'description', type: 'string', required: false, description: 'Detailed description' },
        { name: 'urgency', type: 'string', required: false, description: 'Urgency level (1=High, 2=Medium, 3=Low)' },
        { name: 'assignmentGroup', type: 'string', required: false, description: 'Assignment group sys_id' },
      ],
    },
    {
      operationId: 'update_incident',
      name: 'Update Incident',
      description: 'Update an existing ServiceNow incident',
      method: 'PATCH',
      parameters: [
        { name: 'sysId', type: 'string', required: true, description: 'The sys_id of the incident to update' },
        { name: 'state', type: 'string', required: false, description: 'Incident state' },
        { name: 'shortDescription', type: 'string', required: false, description: 'Updated short description' },
        { name: 'assignedTo', type: 'string', required: false, description: 'Assigned user sys_id' },
      ],
    },
  ],

  ZENDESK: [
    {
      operationId: 'get_ticket',
      name: 'Get Ticket',
      description: 'Retrieve a Zendesk ticket by ID',
      method: 'GET',
      parameters: [
        { name: 'ticketId', type: 'number', required: true, description: 'The ID of the ticket' },
      ],
    },
    {
      operationId: 'list_tickets',
      name: 'List Tickets',
      description: 'List Zendesk tickets with optional filters',
      method: 'GET',
      parameters: [
        { name: 'status', type: 'string', required: false, description: 'Filter by ticket status' },
        { name: 'sortBy', type: 'string', required: false, description: 'Field to sort results by' },
        { name: 'perPage', type: 'number', required: false, description: 'Number of results per page' },
      ],
    },
    {
      operationId: 'create_ticket',
      name: 'Create Ticket',
      description: 'Create a new Zendesk support ticket',
      method: 'POST',
      parameters: [
        { name: 'subject', type: 'string', required: true, description: 'Ticket subject line' },
        { name: 'description', type: 'string', required: true, description: 'Ticket description body' },
        { name: 'priority', type: 'string', required: false, description: 'Ticket priority (low, normal, high, urgent)' },
        { name: 'type', type: 'string', required: false, description: 'Ticket type (problem, incident, question, task)' },
      ],
    },
    {
      operationId: 'update_ticket',
      name: 'Update Ticket',
      description: 'Update an existing Zendesk ticket',
      method: 'PUT',
      parameters: [
        { name: 'ticketId', type: 'number', required: true, description: 'The ID of the ticket to update' },
        { name: 'status', type: 'string', required: false, description: 'Updated ticket status' },
        { name: 'priority', type: 'string', required: false, description: 'Updated priority' },
        { name: 'comment', type: 'string', required: false, description: 'Comment to add to the ticket' },
      ],
    },
  ],

  PAGERDUTY: [
    {
      operationId: 'list_incidents',
      name: 'List Incidents',
      description: 'List PagerDuty incidents with optional filters',
      method: 'GET',
      parameters: [
        { name: 'statuses', type: 'string', required: false, description: 'Comma-separated incident statuses to filter by' },
        { name: 'serviceIds', type: 'string', required: false, description: 'Comma-separated service IDs to filter by' },
        { name: 'limit', type: 'number', required: false, description: 'Maximum number of results' },
      ],
    },
    {
      operationId: 'get_incident',
      name: 'Get Incident',
      description: 'Retrieve a PagerDuty incident by ID',
      method: 'GET',
      parameters: [
        { name: 'incidentId', type: 'string', required: true, description: 'The ID of the incident' },
      ],
    },
    {
      operationId: 'create_incident',
      name: 'Create Incident',
      description: 'Create a new PagerDuty incident',
      method: 'POST',
      parameters: [
        { name: 'title', type: 'string', required: true, description: 'Incident title' },
        { name: 'serviceId', type: 'string', required: true, description: 'ID of the service to create the incident on' },
        { name: 'urgency', type: 'string', required: false, description: 'Incident urgency (high or low)' },
        { name: 'body', type: 'string', required: false, description: 'Incident body details' },
      ],
    },
    {
      operationId: 'acknowledge_incident',
      name: 'Acknowledge Incident',
      description: 'Acknowledge a triggered PagerDuty incident',
      method: 'PUT',
      parameters: [
        { name: 'incidentId', type: 'string', required: true, description: 'The ID of the incident to acknowledge' },
      ],
    },
  ],

  SHAREPOINT: [
    {
      operationId: 'get_file',
      name: 'Get File',
      description: 'Retrieve a file from a SharePoint document library',
      method: 'GET',
      parameters: [
        { name: 'siteId', type: 'string', required: true, description: 'The ID of the SharePoint site' },
        { name: 'driveId', type: 'string', required: true, description: 'The ID of the document library drive' },
        { name: 'itemId', type: 'string', required: true, description: 'The ID of the file item' },
      ],
    },
    {
      operationId: 'list_files',
      name: 'List Files',
      description: 'List files in a SharePoint document library folder',
      method: 'GET',
      parameters: [
        { name: 'siteId', type: 'string', required: true, description: 'The ID of the SharePoint site' },
        { name: 'driveId', type: 'string', required: true, description: 'The ID of the document library drive' },
        { name: 'folderId', type: 'string', required: false, description: 'Folder ID to list (default: root)' },
      ],
    },
    {
      operationId: 'upload_file',
      name: 'Upload File',
      description: 'Upload a file to a SharePoint document library',
      method: 'PUT',
      parameters: [
        { name: 'siteId', type: 'string', required: true, description: 'The ID of the SharePoint site' },
        { name: 'driveId', type: 'string', required: true, description: 'The ID of the document library drive' },
        { name: 'fileName', type: 'string', required: true, description: 'Name of the file to upload' },
        { name: 'content', type: 'string', required: true, description: 'File content' },
      ],
    },
    {
      operationId: 'search_files',
      name: 'Search Files',
      description: 'Search for files across SharePoint sites',
      method: 'GET',
      parameters: [
        { name: 'query', type: 'string', required: true, description: 'Search query string' },
        { name: 'siteId', type: 'string', required: false, description: 'Limit search to a specific site' },
      ],
    },
  ],

  SALESFORCE: [
    {
      operationId: 'get_record',
      name: 'Get Record',
      description: 'Retrieve a Salesforce record by ID',
      method: 'GET',
      parameters: [
        { name: 'objectType', type: 'string', required: true, description: 'Salesforce object type (e.g., Account, Contact)' },
        { name: 'recordId', type: 'string', required: true, description: 'The ID of the record' },
      ],
    },
    {
      operationId: 'query_records',
      name: 'Query Records',
      description: 'Query Salesforce records using SOQL',
      method: 'GET',
      parameters: [
        { name: 'soql', type: 'string', required: true, description: 'SOQL query string' },
      ],
    },
    {
      operationId: 'create_record',
      name: 'Create Record',
      description: 'Create a new Salesforce record',
      method: 'POST',
      parameters: [
        { name: 'objectType', type: 'string', required: true, description: 'Salesforce object type' },
        { name: 'fields', type: 'object', required: true, description: 'Field values for the new record' },
      ],
    },
    {
      operationId: 'update_record',
      name: 'Update Record',
      description: 'Update an existing Salesforce record',
      method: 'PATCH',
      parameters: [
        { name: 'objectType', type: 'string', required: true, description: 'Salesforce object type' },
        { name: 'recordId', type: 'string', required: true, description: 'The ID of the record to update' },
        { name: 'fields', type: 'object', required: true, description: 'Field values to update' },
      ],
    },
  ],

  GITHUB: [
    {
      operationId: 'get_repository',
      name: 'Get Repository',
      description: 'Retrieve information about a GitHub repository',
      method: 'GET',
      parameters: [
        { name: 'owner', type: 'string', required: true, description: 'Repository owner (user or organization)' },
        { name: 'repo', type: 'string', required: true, description: 'Repository name' },
      ],
    },
    {
      operationId: 'list_issues',
      name: 'List Issues',
      description: 'List issues in a GitHub repository',
      method: 'GET',
      parameters: [
        { name: 'owner', type: 'string', required: true, description: 'Repository owner' },
        { name: 'repo', type: 'string', required: true, description: 'Repository name' },
        { name: 'state', type: 'string', required: false, description: 'Filter by state (open, closed, all)' },
      ],
    },
    {
      operationId: 'create_issue',
      name: 'Create Issue',
      description: 'Create a new issue in a GitHub repository',
      method: 'POST',
      parameters: [
        { name: 'owner', type: 'string', required: true, description: 'Repository owner' },
        { name: 'repo', type: 'string', required: true, description: 'Repository name' },
        { name: 'title', type: 'string', required: true, description: 'Issue title' },
        { name: 'body', type: 'string', required: false, description: 'Issue body content' },
      ],
    },
    {
      operationId: 'create_pull_request',
      name: 'Create Pull Request',
      description: 'Create a new pull request in a GitHub repository',
      method: 'POST',
      parameters: [
        { name: 'owner', type: 'string', required: true, description: 'Repository owner' },
        { name: 'repo', type: 'string', required: true, description: 'Repository name' },
        { name: 'title', type: 'string', required: true, description: 'Pull request title' },
        { name: 'head', type: 'string', required: true, description: 'Branch containing changes' },
        { name: 'base', type: 'string', required: true, description: 'Branch to merge into' },
        { name: 'body', type: 'string', required: false, description: 'Pull request description' },
      ],
    },
  ],

  MICROSOFT: [
    {
      operationId: 'send_email',
      name: 'Send Email',
      description: 'Send an email via Microsoft Graph API',
      method: 'POST',
      parameters: [
        { name: 'to', type: 'string', required: true, description: 'Recipient email address' },
        { name: 'subject', type: 'string', required: true, description: 'Email subject line' },
        { name: 'body', type: 'string', required: true, description: 'Email body content' },
        { name: 'contentType', type: 'string', required: false, description: 'Body content type (text or html)' },
      ],
    },
    {
      operationId: 'list_emails',
      name: 'List Emails',
      description: 'List emails from the user mailbox via Microsoft Graph API',
      method: 'GET',
      parameters: [
        { name: 'folder', type: 'string', required: false, description: 'Mail folder to list from (default: inbox)' },
        { name: 'top', type: 'number', required: false, description: 'Maximum number of emails to return' },
        { name: 'filter', type: 'string', required: false, description: 'OData filter expression' },
      ],
    },
    {
      operationId: 'get_calendar_events',
      name: 'Get Calendar Events',
      description: 'Retrieve calendar events via Microsoft Graph API',
      method: 'GET',
      parameters: [
        { name: 'startDateTime', type: 'string', required: false, description: 'Start of time range in ISO 8601 format' },
        { name: 'endDateTime', type: 'string', required: false, description: 'End of time range in ISO 8601 format' },
        { name: 'top', type: 'number', required: false, description: 'Maximum number of events to return' },
      ],
    },
    {
      operationId: 'create_calendar_event',
      name: 'Create Calendar Event',
      description: 'Create a new calendar event via Microsoft Graph API',
      method: 'POST',
      parameters: [
        { name: 'subject', type: 'string', required: true, description: 'Event subject' },
        { name: 'startDateTime', type: 'string', required: true, description: 'Event start time in ISO 8601 format' },
        { name: 'endDateTime', type: 'string', required: true, description: 'Event end time in ISO 8601 format' },
        { name: 'attendees', type: 'string', required: false, description: 'Comma-separated list of attendee email addresses' },
        { name: 'body', type: 'string', required: false, description: 'Event body or description' },
      ],
    },
  ],
};


/**
 * Data store operations mapping. Each data store type maps to an array of
 * operation ID strings. Unknown types fall back to generic read/write.
 */
const DATASTORE_OPERATIONS: Record<string, string[]> = {
  S3: ['read_object', 'write_object', 'list_objects', 'delete_object'],
  DYNAMODB: ['get_item', 'put_item', 'query', 'scan', 'delete_item'],
  RDS_POSTGRESQL: ['execute_query', 'list_tables'],
  RDS_MYSQL: ['execute_query', 'list_tables'],
  AURORA_POSTGRESQL: ['execute_query', 'list_tables'],
  AURORA_MYSQL: ['execute_query', 'list_tables'],
  KNOWLEDGE_BASE: ['query_knowledge_base', 'retrieve_documents'],
  REDSHIFT: ['execute_query', 'list_tables'],
  OPENSEARCH: ['search', 'index_document', 'delete_document'],
  NEPTUNE: ['execute_query', 'list_graphs'],
  TIMESTREAM: ['query', 'write_records'],
  DOCUMENTDB: ['find', 'insert', 'update', 'delete'],
  ELASTICACHE_REDIS: ['get', 'set', 'delete', 'scan'],
};

const GENERIC_DATASTORE_OPERATIONS = ['read', 'write'];

/**
 * Returns operation descriptors for a given integration type.
 * Returns an empty array for AgentCore types and unknown types.
 */
export function getOperations(integrationType: string): OperationDescriptor[] {
  if (AGENTCORE_TYPES.has(integrationType)) {
    return [];
  }
  return Object.prototype.hasOwnProperty.call(OPERATIONS_REGISTRY, integrationType)
    ? OPERATIONS_REGISTRY[integrationType]
    : [];
}

/**
 * Returns a single operation descriptor by integration type and operation ID,
 * or undefined if not found.
 */
export function getOperation(
  integrationType: string,
  operationId: string,
): OperationDescriptor | undefined {
  const operations = getOperations(integrationType);
  return operations.find((op) => op.operationId === operationId);
}

/**
 * Returns the list of operation IDs available for a given data store type.
 * Falls back to generic read/write for unknown types.
 */
export function getDataStoreOperations(dataStoreType: string): string[] {
  return Object.prototype.hasOwnProperty.call(DATASTORE_OPERATIONS, dataStoreType)
    ? DATASTORE_OPERATIONS[dataStoreType]
    : GENERIC_DATASTORE_OPERATIONS;
}

export type { OperationDescriptor, OperationParameter };

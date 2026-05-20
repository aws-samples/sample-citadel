import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { AppSyncResolverEvent } from 'aws-lambda';

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const AGENT_BUCKET_NAME = process.env.AGENT_BUCKET_NAME!;
const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE!;

interface GetAgentCodeArgs {
  agentId: string;
}

interface UpdateAgentCodeArgs {
  input: {
    agentId: string;
    code: string;
  };
}

export const handler = async (event: AppSyncResolverEvent<any>) => {
  console.log('Agent Code Resolver Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    switch (fieldName) {
      case 'getAgentCode':
        return await getAgentCode(event.arguments as GetAgentCodeArgs);
      case 'updateAgentCode':
        return await updateAgentCode(event.arguments as UpdateAgentCodeArgs);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: any) {
    console.error(`Error in ${fieldName}:`, error);
    throw error;
  }
};

async function getAgentCode(args: GetAgentCodeArgs) {
  const { agentId } = args;

  try {
    // Get agent config from DynamoDB to retrieve filename
    const getConfigCommand = new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
    });

    const configResponse = await docClient.send(getConfigCommand);
    
    if (!configResponse.Item) {
      throw new Error(`Agent config not found for agentId: ${agentId}`);
    }

    // Parse config to get filename
    let config = configResponse.Item.config;
    if (typeof config === 'string') {
      config = JSON.parse(config);
    }

    const filename = config.filename || `${agentId}.py`;
    const key = `agents/${filename}`;

    // Get code from S3
    const s3Command = new GetObjectCommand({
      Bucket: AGENT_BUCKET_NAME,
      Key: key,
    });

    const s3Response = await s3Client.send(s3Command);
    const code = await s3Response.Body?.transformToString();

    return {
      agentId,
      code: code || '# Agent code not found\n',
      version: s3Response.VersionId,
      lastModified: s3Response.LastModified?.toISOString(),
    };
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      // Return default code if file doesn't exist
      return {
        agentId,
        code: `# Agent: ${agentId}
# Add your agent code here

def handler(event, context):
    """
    Main handler for the agent.
    
    Args:
        event: The event data passed to the agent
        context: Runtime information
    
    Returns:
        dict: Response from the agent
    """
    pass
`,
        version: null,
        lastModified: null,
      };
    }
    console.error('Error getting agent code:', error);
    throw error;
  }
}

async function updateAgentCode(args: UpdateAgentCodeArgs) {
  const { agentId, code } = args.input;

  try {
    // Get agent config from DynamoDB to retrieve filename
    const getConfigCommand = new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
    });

    const configResponse = await docClient.send(getConfigCommand);
    
    if (!configResponse.Item) {
      throw new Error(`Agent config not found for agentId: ${agentId}`);
    }

    // Parse config to get filename
    let config = configResponse.Item.config;
    if (typeof config === 'string') {
      config = JSON.parse(config);
    }

    const filename = config.filename || `${agentId}.py`;
    const key = `agents/${filename}`;

    // Update code in S3
    const s3Command = new PutObjectCommand({
      Bucket: AGENT_BUCKET_NAME,
      Key: key,
      Body: code,
      ContentType: 'text/x-python',
    });

    const s3Response = await s3Client.send(s3Command);

    return {
      agentId,
      code,
      version: s3Response.VersionId,
      lastModified: new Date().toISOString(),
    };
  } catch (error: any) {
    console.error('Error updating agent code:', error);
    throw new Error(`Failed to update agent code: ${error.message}`);
  }
}

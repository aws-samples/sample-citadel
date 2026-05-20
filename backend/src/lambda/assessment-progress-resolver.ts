import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const SESSION_MEMORY_TABLE = process.env.SESSION_MEMORY_TABLE!;

export const handler = async (event: any) => {
  const sessionId = event.arguments.sessionId;
  const dimensions = ['technical', 'business', 'commercial', 'governance'];
  
  console.log('Fetching assessment progress for sessionId:', sessionId);
  console.log('Using table:', SESSION_MEMORY_TABLE);
  
  const results = await Promise.all(
    dimensions.map(async (dimension) => {
      try {
        const key = {
          p_key: sessionId,
          s_key: `assessment:${dimension}:latest`
        };
        console.log(`Querying dimension ${dimension} with key:`, key);
        
        const response = await docClient.send(new GetCommand({
          TableName: SESSION_MEMORY_TABLE,
          Key: key
        }));
        
        console.log(`Response for ${dimension}:`, response.Item);
        
        const completionPercentage = response.Item?.completion_percentage || 0;
        return {
          dimension,
          completionPercentage,
          isComplete: completionPercentage === 100
        };
      } catch (error) {
        console.error(`Error fetching ${dimension}:`, error);
        return {
          dimension,
          completionPercentage: 0,
          isComplete: false
        };
      }
    })
  );
  
  console.log('Final results:', results);
  return results;
};

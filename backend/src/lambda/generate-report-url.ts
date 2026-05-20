import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const SESSION_BUCKET = process.env.SESSION_BUCKET || 'citadel-sessions-test';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const PROJECTS_TABLE = process.env.PROJECTS_TABLE || 'citadel-projects-dev';

export const handler = async (event: any) => {
  const { projectId } = event.arguments;

  try {
    // Get project name from DynamoDB
    const projectResult = await docClient.send(new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { id: projectId },
    }));

    const projectName = projectResult.Item?.name || 'Project';
    const sanitizedName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${sanitizedName}-assessment-report.pdf`;

    const command = new GetObjectCommand({
      Bucket: SESSION_BUCKET,
      Key: `${projectId}/design/high_level_design.pdf`,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
      ResponseContentType: 'application/pdf',
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    return {
      url,
      expiresIn: 3600,
    };
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    throw new Error('Failed to generate report download URL');
  }
};

import { S3Event } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const eventBridge = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

export const handler = async (event: S3Event) => {
  console.log('PDF created event:', JSON.stringify(event, null, 2));

  const entries = event.Records.map((record) => ({
    Source: 'citadel.documents',
    DetailType: 'pdf.created',
    EventBusName: EVENT_BUS_NAME,
    Detail: JSON.stringify({
      bucket: record.s3.bucket.name,
      key: record.s3.object.key,
      size: record.s3.object.size,
      timestamp: record.eventTime,
    }),
  }));

  const result = await eventBridge.send(new PutEventsCommand({ Entries: entries }));
  console.log('EventBridge result:', JSON.stringify(result, null, 2));

  return { statusCode: 200, body: `Published ${entries.length} event(s)` };
};

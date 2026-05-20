/**
 * Document Upload Resolver Lambda
 * Generates pre-signed URLs for uploading documents to S3
 */

import { AppSyncResolverHandler } from "aws-lambda";
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BedrockAgentClient, IngestKnowledgeBaseDocumentsCommand, GetKnowledgeBaseDocumentsCommand, DeleteKnowledgeBaseDocumentsCommand } from "@aws-sdk/client-bedrock-agent";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { v4 as uuidv4 } from "uuid";
import { getUserId } from "../utils/appsync";

const s3Client = new S3Client({});
const bedrockAgentClient = new BedrockAgentClient({});
const ssmClient = new SSMClient({});
const eventBridgeClient = new EventBridgeClient({});
const DOCUMENT_BUCKET = process.env.DOCUMENT_BUCKET!;
const KB_ID_PARAM = process.env.KB_ID_PARAM!;
const DS_ID_PARAM = process.env.DS_ID_PARAM!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

// Cached at Lambda container level
let _kbId: string | undefined;
let _dsId: string | undefined;

async function getKbIds(): Promise<{ kbId: string; dsId: string }> {
  if (!_kbId || !_dsId) {
    const [kb, ds] = await Promise.all([
      ssmClient.send(new GetParameterCommand({ Name: KB_ID_PARAM })),
      ssmClient.send(new GetParameterCommand({ Name: DS_ID_PARAM })),
    ]);
    _kbId = kb.Parameter!.Value!;
    _dsId = ds.Parameter!.Value!;
  }
  return { kbId: _kbId, dsId: _dsId };
}

interface GenerateUploadUrlInput {
  projectId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

interface UploadUrlResponse {
  uploadUrl: string;
  documentKey: string;
  expiresIn: number;
}

/**
 * Generate a pre-signed URL for uploading a document
 */
async function generateUploadUrl(
  input: GenerateUploadUrlInput,
  userId: string
): Promise<UploadUrlResponse> {
  const { projectId, fileName, fileType, fileSize } = input;

  // Validate file size (max 10MB)
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (fileSize > maxSize) {
    throw new Error(
      `File size ${fileSize} exceeds maximum allowed size of ${maxSize} bytes (10MB)`
    );
  }

  // Validate file type
  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
    "text/plain",
    "text/markdown",
  ];

  if (!allowedTypes.includes(fileType)) {
    throw new Error(
      `File type ${fileType} is not allowed. Supported types: PDF, DOCX, TXT, MD`
    );
  }

  // Generate unique document key
  const docParts = fileName.split(".");
  const fileExtension = docParts.pop();
  const docName = docParts.at(0);
  //const documentId = uuidv4();
  const documentKey = `${projectId}/${docName}.${fileExtension}`;

  console.log("Generating upload URL:", {
    projectId,
    userId,
    fileName,
    fileType,
    fileSize,
    documentKey,
  });

  // Create S3 PutObject command
  const command = new PutObjectCommand({
    Bucket: DOCUMENT_BUCKET,
    Key: documentKey,
    ContentType: fileType,
    Metadata: {
      projectId,
      userId,
      originalFileName: fileName,
      uploadedAt: new Date().toISOString(),
    },
  });

  // Generate pre-signed URL (valid for 15 minutes)
  const expiresIn = 900; // 15 minutes
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });

  console.log("Generated upload URL:", {
    documentKey,
    expiresIn,
  });

  return {
    uploadUrl,
    documentKey,
    expiresIn,
  };
}

/**
 * Ingest an uploaded document into the Bedrock Knowledge Base
 */
async function ingestDocument(projectId: string, documentKey: string): Promise<{ documentKey: string; status: string }> {
  const { kbId, dsId } = await getKbIds();
  const s3Uri = `s3://${DOCUMENT_BUCKET}/${documentKey}`;
  const parts = documentKey.split('/');
  const filename = parts.slice(1).join('/');

  const command = new IngestKnowledgeBaseDocumentsCommand({
    knowledgeBaseId: kbId,
    dataSourceId: dsId,
    documents: [{
      content: {
        dataSourceType: 'CUSTOM',
        custom: {
          customDocumentIdentifier: { id: documentKey },
          sourceType: 'S3_LOCATION',
          s3Location: { uri: s3Uri },
        },
      },
      metadata: {
        type: 'IN_LINE_ATTRIBUTE',
        inlineAttributes: [
          { key: 'session_id', value: { type: 'STRING', stringValue: projectId } },
          { key: 'filename',   value: { type: 'STRING', stringValue: filename } },
        ],
      },
    }],
  });

  const response = await bedrockAgentClient.send(command) as any;
  const status = response.ingestedDocuments?.[0]?.status?.status ?? 'UNKNOWN';
  return { documentKey, status };
}

/**
 * List documents uploaded for a project
 */
async function listProjectDocuments(projectId: string): Promise<{ documentKey: string; fileName: string; size: number; lastModified: string }[]> {
  const response = await s3Client.send(new ListObjectsV2Command({ Bucket: DOCUMENT_BUCKET, Prefix: `${projectId}/` }));
  return (response.Contents || []).map((obj) => ({
    documentKey: obj.Key!,
    fileName: obj.Key!.split('/').slice(1).join('/'),
    size: obj.Size ?? 0,
    lastModified: obj.LastModified?.toISOString() ?? '',
  }));
}

/**
 * Get document ingestion status from Bedrock KB
 */
async function getDocumentIngestionStatus(documentKey: string): Promise<{ documentKey: string; status: string; statusReason?: string; updatedAt?: string }> {
  const { kbId, dsId } = await getKbIds();
  const response = await bedrockAgentClient.send(new GetKnowledgeBaseDocumentsCommand({
    knowledgeBaseId: kbId,
    dataSourceId: dsId,
    documentIdentifiers: [{ dataSourceType: 'CUSTOM', custom: { id: documentKey } }],
  }));
  const detail = response.documentDetails?.[0];
  return {
    documentKey,
    status: detail?.status ?? 'NOT_FOUND',
    statusReason: detail?.statusReason,
    updatedAt: detail?.updatedAt?.toISOString(),
  };
}

/**
 * Notify agent that a document is ready via EventBridge
 */
async function notifyDocumentReady(projectId: string, documentKey: string, fileName: string, fileSize: number, fileType: string): Promise<{ success: boolean }> {
  const sizeKB = Math.round(fileSize / 1024);
  await eventBridgeClient.send(new PutEventsCommand({
    Entries: [{
      Source: 'citadel',
      DetailType: 'message.sent_to_agent',
      Detail: JSON.stringify({
        projectId,
        agentId: 'agent_intake_single',
        message: `A document has been uploaded and indexed: ${fileName} (${sizeKB}KB, ${fileType}). Extract information from it.`,
        messageId: `doc-upload-${uuidv4()}`,
        userId: 'system',
        timestamp: new Date().toISOString(),
        metadata: { documentKey, trigger: 'document_indexed' },
      }),
      EventBusName: EVENT_BUS_NAME,
    }],
  }));
  return { success: true };
}

/**
 * Delete a document from S3 and Bedrock KB
 */
async function deleteDocument(projectId: string, documentKey: string): Promise<{ documentKey: string; status: string }> {
  const { kbId, dsId } = await getKbIds();
  await bedrockAgentClient.send(new DeleteKnowledgeBaseDocumentsCommand({
    knowledgeBaseId: kbId,
    dataSourceId: dsId,
    documentIdentifiers: [{ dataSourceType: 'CUSTOM', custom: { id: documentKey } }],
  }));
  await s3Client.send(new DeleteObjectCommand({ Bucket: DOCUMENT_BUCKET, Key: documentKey }));
  return { documentKey, status: 'DELETED' };
}

/**
 * Lambda handler
 */
export const handler: AppSyncResolverHandler<any, any> = async (event) => {
  console.log(
    "Document upload resolver event:",
    JSON.stringify(event, null, 2)
  );

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      case "generateDocumentUploadUrl":
        return await generateUploadUrl(args.input, userId);
      case "listProjectDocuments":
        return await listProjectDocuments(args.projectId);
      case "ingestDocument":
        return await ingestDocument(args.projectId, args.documentKey);
      case "getDocumentIngestionStatus":
        return await getDocumentIngestionStatus(args.documentKey);
      case "notifyDocumentReady":
        return await notifyDocumentReady(args.projectId, args.documentKey, args.fileName, args.fileSize, args.fileType);
      case "deleteDocument":
        return await deleteDocument(args.projectId, args.documentKey);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error("Document upload resolver error:", error);
    throw error;
  }
};

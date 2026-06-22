/**
 * Document Upload Resolver Lambda
 * Generates pre-signed URLs for uploading documents to S3 and surfaces
 * ingestion status. Ingestion itself is server-authoritative: an S3
 * ObjectCreated event drives ingestion and a poller fires the assessment
 * trigger, so this resolver no longer ingests or notifies. listProjectDocuments
 * / getDocumentIngestionStatus read the authoritative DynamoDB jobs table as the
 * source of truth, falling back to a direct Bedrock KB query when the table is
 * unavailable (or not yet wired in this env).
 */

import { AppSyncResolverHandler } from "aws-lambda";
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BedrockAgentClient, DeleteKnowledgeBaseDocumentsCommand } from "@aws-sdk/client-bedrock-agent";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getUserId } from "../utils/appsync";
import {
  getKbIds,
  pollStatuses,
} from "./document-ingestion-shared";

const s3Client = new S3Client({});
const bedrockAgentClient = new BedrockAgentClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const DOCUMENT_BUCKET = process.env.DOCUMENT_BUCKET!;

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

interface ProjectDocument {
  documentKey: string;
  fileName: string;
  size: number;
  lastModified: string;
  status?: string;
  statusReason?: string;
}

/** Read jobs rows for a project keyed by documentKey. Throws on table errors. */
async function readJobsForProject(projectId: string): Promise<Map<string, { status: string; statusReason?: string }>> {
  const tableName = process.env.INGESTION_TABLE;
  const map = new Map<string, { status: string; statusReason?: string }>();
  if (!tableName) {
    // Table not wired into this environment yet — signal "no data" so the
    // caller falls back to the KB query path.
    throw new Error("INGESTION_TABLE not configured");
  }
  let nextToken: Record<string, any> | undefined;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: { ":pid": projectId },
      ExclusiveStartKey: nextToken,
    }));
    for (const item of (resp.Items ?? []) as any[]) {
      if (item.documentKey) map.set(item.documentKey, { status: item.status ?? "UNKNOWN", statusReason: item.statusReason });
    }
    nextToken = resp.LastEvaluatedKey;
  } while (nextToken);
  return map;
}

/**
 * List documents uploaded for a project. The jobs table is the source of
 * truth for ingestion status; on any table read failure we degrade gracefully
 * to a direct Bedrock KB query (never failing the whole list).
 */
async function listProjectDocuments(projectId: string): Promise<ProjectDocument[]> {
  const response = await s3Client.send(new ListObjectsV2Command({ Bucket: DOCUMENT_BUCKET, Prefix: `${projectId}/` }));
  const items: ProjectDocument[] = (response.Contents || []).map((obj) => ({
    documentKey: obj.Key!,
    fileName: obj.Key!.split('/').slice(1).join('/'),
    size: obj.Size ?? 0,
    lastModified: obj.LastModified?.toISOString() ?? '',
    status: undefined,
    statusReason: undefined,
  }));

  if (items.length === 0) return items;

  // Preferred path: authoritative jobs table.
  try {
    const jobs = await readJobsForProject(projectId);
    return items.map((item) => {
      const j = jobs.get(item.documentKey);
      return { ...item, status: j?.status ?? 'NOT_FOUND', statusReason: j?.statusReason };
    });
  } catch (tableErr) {
    console.error('listProjectDocuments: jobs-table read failed, falling back to KB query', tableErr);
  }

  // Fallback path: direct Bedrock KB query (chunked <=10 inside pollStatuses).
  try {
    const statusMap = await pollStatuses(items.map((it) => it.documentKey));
    return items.map((item) => {
      const s = statusMap.get(item.documentKey);
      return { ...item, status: s?.status ?? 'NOT_FOUND', statusReason: s?.statusReason };
    });
  } catch (err) {
    console.error('listProjectDocuments: failed to fetch KB ingestion status, degrading to UNKNOWN', err);
    return items.map((item) => ({ ...item, status: 'UNKNOWN' }));
  }
}

/**
 * Get document ingestion status. Reads the jobs table first (source of truth),
 * falling back to a direct Bedrock KB query when the row is absent or the table
 * read fails.
 */
async function getDocumentIngestionStatus(documentKey: string): Promise<{ documentKey: string; status: string; statusReason?: string; updatedAt?: string }> {
  const tableName = process.env.INGESTION_TABLE;
  const projectId = documentKey.split('/')[0];

  if (tableName) {
    try {
      const resp = await ddb.send(new GetCommand({ TableName: tableName, Key: { projectId, documentKey } }));
      if (resp.Item) {
        return {
          documentKey,
          status: resp.Item.status ?? 'UNKNOWN',
          statusReason: resp.Item.statusReason,
          updatedAt: resp.Item.updatedAt,
        };
      }
    } catch (err) {
      console.error('getDocumentIngestionStatus: jobs-table read failed, falling back to KB query', err);
    }
  }

  // Fallback: direct KB query.
  const statusMap = await pollStatuses([documentKey]);
  const s = statusMap.get(documentKey);
  return { documentKey, status: s?.status ?? 'NOT_FOUND', statusReason: s?.statusReason, updatedAt: s?.updatedAt };
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
      case "getDocumentIngestionStatus":
        return await getDocumentIngestionStatus(args.documentKey);
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

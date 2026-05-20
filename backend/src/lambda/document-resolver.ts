/**
 * Document Resolver Lambda
 * Handles reading session documents, version history, and on-demand PDF generation
 */

import { AppSyncResolverHandler } from "aws-lambda";
import { S3Client, GetObjectCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const SESSION_BUCKET = process.env.SESSION_BUCKET!;
const PDF_GENERATOR_FUNCTION = process.env.PDF_GENERATOR_FUNCTION!;

// Map projectId + documentKey → S3 key: {projectId}/{documentKey}
function s3Key(projectId: string, documentKey: string): string {
  return `${projectId}/${documentKey}`;
}

async function getProjectDocument(projectId: string, documentKey: string, versionId?: string) {
  const cmd = new GetObjectCommand({
    Bucket: SESSION_BUCKET,
    Key: s3Key(projectId, documentKey),
    ...(versionId && { VersionId: versionId }),
  });
  const res = await s3.send(cmd);
  const content = await res.Body!.transformToString("utf-8");
  return {
    documentKey,
    content,
    versionId: res.VersionId ?? null,
    lastModified: res.LastModified?.toISOString() ?? null,
  };
}

async function listDocumentVersions(projectId: string, documentKey: string) {
  const cmd = new ListObjectVersionsCommand({
    Bucket: SESSION_BUCKET,
    Prefix: s3Key(projectId, documentKey),
  });
  const res = await s3.send(cmd);
  return (res.Versions ?? []).map((v) => ({
    versionId: v.VersionId!,
    lastModified: v.LastModified!.toISOString(),
    size: v.Size ?? 0,
    isLatest: v.IsLatest ?? false,
  }));
}

async function generateDocumentPdf(projectId: string, documentKey: string): Promise<{ url: string; expiresIn: number }> {
  const key = s3Key(projectId, documentKey);
  const pdfKey = key.replace(/\.md$/, ".pdf");

  // Invoke PDF generator synchronously
  await lambda.send(new InvokeCommand({
    FunctionName: PDF_GENERATOR_FUNCTION,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify({
      Records: [{
        s3: {
          bucket: { name: SESSION_BUCKET },
          object: { key },
        },
      }],
    })),
  }));

  // Return presigned URL to the generated PDF
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: SESSION_BUCKET,
    Key: pdfKey,
  }), { expiresIn: 900 });

  return { url, expiresIn: 900 };
}

export const handler: AppSyncResolverHandler<any, any> = async (event) => {
  const { info, arguments: args } = event;
  const { projectId, documentKey, versionId } = args;

  switch (info.fieldName) {
    case "getProjectDocument":
      return getProjectDocument(projectId, documentKey);
    case "getDocumentVersion":
      return getProjectDocument(projectId, documentKey, versionId);
    case "listDocumentVersions":
      return listDocumentVersions(projectId, documentKey);
    case "generateDocumentPdf":
      return generateDocumentPdf(projectId, documentKey);
    default:
      throw new Error(`Unknown field: ${info.fieldName}`);
  }
};

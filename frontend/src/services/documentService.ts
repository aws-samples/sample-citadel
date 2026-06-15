/**
 * Document Service
 * Handles document uploads via pre-signed URLs
 */

import serverService from './server';

export interface GenerateUploadUrlInput {
  projectId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

export interface DocumentUploadUrl {
  uploadUrl: string;
  documentKey: string;
  expiresIn: number;
}

// GraphQL Mutation
const generateDocumentUploadUrlMutation = /* GraphQL */ `
  mutation GenerateDocumentUploadUrl($input: GenerateUploadUrlInput!) {
    generateDocumentUploadUrl(input: $input) {
      uploadUrl
      documentKey
      expiresIn
    }
  }
`;

/**
 * Generate a pre-signed URL for uploading a document
 */
export async function generateUploadUrl(
  input: GenerateUploadUrlInput
): Promise<DocumentUploadUrl> {
  try {
    const response = await serverService.mutate<{ generateDocumentUploadUrl: DocumentUploadUrl }>(
      generateDocumentUploadUrlMutation,
      { input }
    );

    return response.generateDocumentUploadUrl;
  } catch (error) {
    console.error('Error generating upload URL:', error);
    throw error;
  }
}

/**
 * Upload a file to S3 using a pre-signed URL
 */
export async function uploadFileToS3(
  file: File,
  uploadUrl: string
): Promise<void> {
  try {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': file.type,
      },
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error('Error uploading file to S3:', error);
    throw error;
  }
}

/**
 * Complete document upload flow
 */
export async function uploadDocument(
  projectId: string,
  file: File
): Promise<string> {
  // Generate pre-signed URL
  const { uploadUrl, documentKey } = await generateUploadUrl({
    projectId,
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
  });

  // Upload file to S3
  await uploadFileToS3(file, uploadUrl);

  // Return document key
  return documentKey;
}

// GraphQL for document reading
const getProjectDocumentQuery = /* GraphQL */ `
  query GetProjectDocument($projectId: ID!, $documentKey: String!) {
    getProjectDocument(projectId: $projectId, documentKey: $documentKey) {
      documentKey content versionId lastModified
    }
  }
`;

const listDocumentVersionsQuery = /* GraphQL */ `
  query ListDocumentVersions($projectId: ID!, $documentKey: String!) {
    listDocumentVersions(projectId: $projectId, documentKey: $documentKey) {
      versionId lastModified size isLatest
    }
  }
`;

const getDocumentVersionQuery = /* GraphQL */ `
  query GetDocumentVersion($projectId: ID!, $documentKey: String!, $versionId: String!) {
    getDocumentVersion(projectId: $projectId, documentKey: $documentKey, versionId: $versionId) {
      documentKey content versionId lastModified
    }
  }
`;

const generateDocumentPdfMutation = /* GraphQL */ `
  mutation GenerateDocumentPdf($projectId: ID!, $documentKey: String!) {
    generateDocumentPdf(projectId: $projectId, documentKey: $documentKey) {
      url expiresIn
    }
  }
`;

const ingestDocumentMutation = /* GraphQL */ `
  mutation IngestDocument($projectId: ID!, $documentKey: String!) {
    ingestDocument(projectId: $projectId, documentKey: $documentKey) {
      documentKey status
    }
  }
`;

export interface ProjectDocument {
  documentKey: string;
  content: string;
  versionId?: string;
  lastModified?: string;
}

export interface DocumentVersion {
  versionId: string;
  lastModified: string;
  size: number;
  isLatest: boolean;
}

export async function getProjectDocument(projectId: string, documentKey: string): Promise<ProjectDocument | null> {
  try {
    const res = await serverService.query<{ getProjectDocument: ProjectDocument }>(
      getProjectDocumentQuery, { projectId, documentKey }
    );
    return res.getProjectDocument;
  } catch {
    return null;
  }
}

export async function listDocumentVersions(projectId: string, documentKey: string): Promise<DocumentVersion[]> {
  const res = await serverService.query<{ listDocumentVersions: DocumentVersion[] }>(
    listDocumentVersionsQuery, { projectId, documentKey }
  );
  return res.listDocumentVersions ?? [];
}

export async function getDocumentVersion(projectId: string, documentKey: string, versionId: string): Promise<ProjectDocument> {
  const res = await serverService.query<{ getDocumentVersion: ProjectDocument }>(
    getDocumentVersionQuery, { projectId, documentKey, versionId }
  );
  return res.getDocumentVersion;
}

export async function generateDocumentPdf(projectId: string, documentKey: string): Promise<string> {
  const res = await serverService.mutate<{ generateDocumentPdf: { url: string } }>(
    generateDocumentPdfMutation, { projectId, documentKey }
  );
  return res.generateDocumentPdf.url;
}

export async function ingestDocument(projectId: string, documentKey: string): Promise<void> {
  await serverService.mutate(ingestDocumentMutation, { projectId, documentKey });
}

// ── Document Ingestion Status Polling ────────────────────────────────────────

const listProjectDocumentsQuery = /* GraphQL */ `
  query ListProjectDocuments($projectId: ID!) {
    listProjectDocuments(projectId: $projectId) {
      documentKey fileName size lastModified
    }
  }
`;

export interface ProjectDocumentItem {
  documentKey: string;
  fileName: string;
  size: number;
  lastModified: string;
}

export async function listProjectDocuments(projectId: string): Promise<ProjectDocumentItem[]> {
  const response = await serverService.query<{ listProjectDocuments: ProjectDocumentItem[] }>(
    listProjectDocumentsQuery, { projectId }
  );
  return response.listProjectDocuments || [];
}

const getDocumentIngestionStatusQuery = /* GraphQL */ `
  query GetDocumentIngestionStatus($projectId: ID!, $documentKey: String!) {
    getDocumentIngestionStatus(projectId: $projectId, documentKey: $documentKey) {
      documentKey status statusReason updatedAt
    }
  }
`;

export interface DocumentIngestionStatus {
  documentKey: string;
  status: string;
  statusReason?: string;
  updatedAt?: string;
}

export async function getDocumentIngestionStatus(projectId: string, documentKey: string): Promise<DocumentIngestionStatus> {
  const response = await serverService.query<{ getDocumentIngestionStatus: DocumentIngestionStatus }>(
    getDocumentIngestionStatusQuery, { projectId, documentKey }
  );
  return response.getDocumentIngestionStatus;
}

const TERMINAL_STATUSES = ['INDEXED', 'PARTIALLY_INDEXED', 'FAILED', 'METADATA_UPDATE_FAILED', 'IGNORED', 'NOT_FOUND'];
const SUCCESS_STATUSES = ['INDEXED', 'PARTIALLY_INDEXED'];

export interface WaitForIndexedOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onStatusChange?: (status: string) => void;
}

export async function waitForDocumentIndexed(
  projectId: string,
  documentKey: string,
  opts: WaitForIndexedOptions = {},
): Promise<DocumentIngestionStatus> {
  const { timeoutMs = 300_000, pollIntervalMs = 3_000, onStatusChange } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await getDocumentIngestionStatus(projectId, documentKey);
    onStatusChange?.(result.status);
    if (SUCCESS_STATUSES.includes(result.status)) return result;
    if (TERMINAL_STATUSES.includes(result.status)) throw new Error(`Indexing failed: ${result.status} — ${result.statusReason ?? ''}`);
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error('TIMEOUT');
}

// ── Notify Document Ready ────────────────────────────────────────────────────

const notifyDocumentReadyMutation = /* GraphQL */ `
  mutation NotifyDocumentReady($projectId: ID!, $documentKey: String!, $fileName: String!, $fileSize: Int!, $fileType: String!) {
    notifyDocumentReady(projectId: $projectId, documentKey: $documentKey, fileName: $fileName, fileSize: $fileSize, fileType: $fileType) {
      success
    }
  }
`;

export async function notifyDocumentReady(
  projectId: string, documentKey: string, fileName: string, fileSize: number, fileType: string,
): Promise<void> {
  await serverService.mutate(notifyDocumentReadyMutation, { projectId, documentKey, fileName, fileSize, fileType });
}

// ── Delete Document ──────────────────────────────────────────────────────────

const deleteDocumentMutation = /* GraphQL */ `
  mutation DeleteDocument($projectId: ID!, $documentKey: String!) {
    deleteDocument(projectId: $projectId, documentKey: $documentKey) {
      documentKey status
    }
  }
`;

export async function deleteDocument(projectId: string, documentKey: string): Promise<void> {
  await serverService.mutate(deleteDocumentMutation, { projectId, documentKey });
}

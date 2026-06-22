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

// ── Document Ingestion Status Polling ────────────────────────────────────────

const listProjectDocumentsQuery = /* GraphQL */ `
  query ListProjectDocuments($projectId: ID!) {
    listProjectDocuments(projectId: $projectId) {
      documentKey fileName size lastModified status statusReason
    }
  }
`;

export interface ProjectDocumentItem {
  documentKey: string;
  fileName: string;
  size: number;
  lastModified: string;
  status?: string;
  statusReason?: string;
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

const SUCCESS_STATUSES = ['INDEXED', 'PARTIALLY_INDEXED'];
// IGNORED is a Bedrock dedup/no-op (the doc already exists and is indexed), not a
// failure — treat it as transient and keep polling for the true status.
const FAILURE_STATUSES = ['FAILED', 'METADATA_UPDATE_FAILED'];

export interface WaitForIndexedOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Grace window during which a NOT_FOUND / empty status is treated as a TRANSIENT
   * pre-indexing state (Bedrock is eventually consistent right after ingestion) rather
   * than a terminal failure. The window ends once any concrete status is observed OR
   * this duration elapses, whichever comes first.
   */
  gracePeriodMs?: number;
  onStatusChange?: (status: string) => void;
}

export async function waitForDocumentIndexed(
  projectId: string,
  documentKey: string,
  opts: WaitForIndexedOptions = {},
): Promise<DocumentIngestionStatus> {
  const { timeoutMs = 300_000, pollIntervalMs = 3_000, gracePeriodMs = 30_000, onStatusChange } = opts;
  const deadline = Date.now() + timeoutMs;
  const graceDeadline = Date.now() + gracePeriodMs;
  let sawConcreteStatus = false;

  while (Date.now() < deadline) {
    const result = await getDocumentIngestionStatus(projectId, documentKey);
    onStatusChange?.(result.status);

    if (SUCCESS_STATUSES.includes(result.status)) return result;
    if (FAILURE_STATUSES.includes(result.status)) {
      throw new Error(`Indexing failed: ${result.status} — ${result.statusReason ?? ''}`);
    }

    const isNotFound = !result.status || result.status === 'NOT_FOUND';
    if (isNotFound) {
      // Transient pre-indexing state: keep polling while still inside the grace window and
      // before any concrete status has been seen.
      if (!sawConcreteStatus && Date.now() < graceDeadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      // Grace window elapsed (or a concrete status was already observed): treat as terminal.
      throw new Error(`Indexing failed: NOT_FOUND — ${result.statusReason ?? 'document not found after grace period'}`);
    }

    // Non-terminal concrete status (STARTING/PENDING/IN_PROGRESS): keep polling.
    sawConcreteStatus = true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error('TIMEOUT');
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

/**
 * Unit tests for the pure-logic helpers in reconcile-apps-meta.ts.
 *
 * Per the Step 4 task spec, we exercise only the decision/projection
 * helpers — the main loop, AWS clients, and the Pass 1 / Pass 2 orchestration
 * are integration-level concerns out of scope here. AWS clients are mocked
 * defensively to verify the helpers do NOT touch any SDK.
 */

import {
  classifyDrift,
  projectRegistryRecordToMeta,
  firstDifferingField,
  runReconciliation,
} from '../reconcile-apps-meta';
import { AppMetaRow } from '../../src/utils/apps-table-meta';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

// Mock RegistryService with a per-test-controllable `listResources` so the
// runReconciliation tests below stay in the pure-helper file. The AWS SDK
// (DynamoDBClient) is mocked via aws-sdk-client-mock so the reconciler can
// run end-to-end without real network calls.
const mockListResources = jest.fn();
jest.mock('../../src/services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
  })),
}));

const ddbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Returns a fully-populated projection. Override fields per-test. */
function makeProjection(overrides: Partial<AppMetaRow> = {}): AppMetaRow {
  return {
    appId: 'app-123',
    orgId: 'org-1',
    name: 'My App',
    description: 'desc',
    status: 'DRAFT',
    workflowIds: ['wf-1'],
    routingConfig: '',
    createdBy: 'alice',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

/** Returns a fully-populated meta row (DDB Item shape). */
function makeMetaRow(overrides: Partial<AppMetaRow> = {}): Partial<AppMetaRow> {
  // Spread last so test overrides win even when they explicitly set undefined.
  return {
    appId: 'app-123',
    orgId: 'org-1',
    name: 'My App',
    description: 'desc',
    status: 'DRAFT',
    workflowIds: ['wf-1'],
    routingConfig: '',
    createdBy: 'alice',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyDrift
// ---------------------------------------------------------------------------

describe('classifyDrift', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it("returns 'missing' when metaRow is null", () => {
    expect(classifyDrift(makeProjection(), null)).toBe('missing');
  });

  it("returns 'missing' when metaRow is undefined", () => {
    expect(classifyDrift(makeProjection(), undefined)).toBe('missing');
  });

  it("returns 'in-sync' when every comparison field matches", () => {
    expect(classifyDrift(makeProjection(), makeMetaRow())).toBe('in-sync');
  });

  it("returns 'stale' when name differs", () => {
    expect(
      classifyDrift(
        makeProjection({ name: 'Registry Name' }),
        makeMetaRow({ name: 'Old Meta Name' }),
      ),
    ).toBe('stale');
  });

  it("returns 'stale' when status differs", () => {
    expect(
      classifyDrift(
        makeProjection({ status: 'APPROVED' }),
        makeMetaRow({ status: 'DRAFT' }),
      ),
    ).toBe('stale');
  });

  it("returns 'stale' when orgId differs", () => {
    expect(
      classifyDrift(
        makeProjection({ orgId: 'org-1' }),
        makeMetaRow({ orgId: 'org-2' }),
      ),
    ).toBe('stale');
  });

  it("returns 'stale' when version differs", () => {
    expect(
      classifyDrift(
        makeProjection({ version: 2 }),
        makeMetaRow({ version: 1 }),
      ),
    ).toBe('stale');
  });

  it("returns 'in-sync' when fields differ on a key NOT in the comparison set", () => {
    // description, workflowIds, routingConfig, createdBy, createdAt,
    // updatedAt all live OUTSIDE the (name, status, orgId, version) drift
    // comparison set — they must not promote 'in-sync' to 'stale'.
    const projection = makeProjection();
    const metaRow = {
      ...makeMetaRow(),
      description: 'mutated description',
      workflowIds: ['wf-totally-different'],
      routingConfig: '{"strategy":"changed"}',
      createdBy: 'bob',
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-02T00:00:00.000Z',
      // Add an extra field that the row doesn't normally carry — should
      // also be ignored.
      extra: 'extra-field-value',
    } as Partial<AppMetaRow> & { extra: string };
    expect(classifyDrift(projection, metaRow)).toBe('in-sync');
  });

  it("returns 'orphan' when projection is null but metaRow is present", () => {
    expect(classifyDrift(null, makeMetaRow())).toBe('orphan');
  });

  it("returns 'orphan' when projection is undefined but metaRow is present", () => {
    expect(classifyDrift(undefined, makeMetaRow())).toBe('orphan');
  });

  it("treats a numeric version on the meta row as equal to the same number on projection", () => {
    // DDB DocumentClient returns numbers as JS numbers; defensive coercion
    // also tolerates a stringified number on either side without flagging
    // it as drift.
    expect(
      classifyDrift(
        makeProjection({ version: 5 }),
        makeMetaRow({ version: 5 }),
      ),
    ).toBe('in-sync');
    expect(
      classifyDrift(
        makeProjection({ version: 5 }),
        makeMetaRow({ version: '5' as unknown as number }),
      ),
    ).toBe('in-sync');
  });

  it('does not call any AWS SDK from the helper', () => {
    classifyDrift(makeProjection(), makeMetaRow());
    classifyDrift(makeProjection(), null);
    classifyDrift(null, makeMetaRow());
    expect(ddbMock.calls().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// firstDifferingField
// ---------------------------------------------------------------------------

describe('firstDifferingField', () => {
  it('returns null when all comparison fields match', () => {
    expect(firstDifferingField(makeProjection(), makeMetaRow())).toBeNull();
  });

  it("returns 'name' when name differs first", () => {
    expect(
      firstDifferingField(
        makeProjection({ name: 'A' }),
        makeMetaRow({ name: 'B' }),
      ),
    ).toBe('name');
  });

  it("returns 'status' when only status differs", () => {
    expect(
      firstDifferingField(
        makeProjection({ status: 'APPROVED' }),
        makeMetaRow({ status: 'DRAFT' }),
      ),
    ).toBe('status');
  });
});

// ---------------------------------------------------------------------------
// projectRegistryRecordToMeta
// ---------------------------------------------------------------------------

describe('projectRegistryRecordToMeta', () => {
  it('projects every field correctly when manifest carries them all', () => {
    const customDescriptor = {
      appId: 'app-xyz',
      manifest: {
        orgId: 'org-acme',
        version: 4,
        status: 'PUBLISHED',
        createdBy: 'user-1',
        workflowIds: ['wf-a', 'wf-b'],
        routingConfig: { strategy: 'round-robin' },
      },
    };
    const record = {
      recordId: 'app-xyz',
      name: 'XYZ App',
      description: 'a human description',
      status: 'APPROVED',
      customDescriptorContent: JSON.stringify(customDescriptor),
      createdAt: new Date('2024-03-01T12:00:00.000Z'),
      updatedAt: new Date('2024-03-02T12:00:00.000Z'),
    };

    const meta = projectRegistryRecordToMeta(record);

    expect(meta).toEqual({
      appId: 'app-xyz',
      orgId: 'org-acme',
      name: 'XYZ App',
      description: 'a human description',
      // manifest.status wins over record.status — matches resolver write.
      status: 'PUBLISHED',
      workflowIds: ['wf-a', 'wf-b'],
      // routingConfig serialised to a string (resolver-side contract).
      routingConfig: '{"strategy":"round-robin"}',
      createdBy: 'user-1',
      createdAt: '2024-03-01T12:00:00.000Z',
      updatedAt: '2024-03-02T12:00:00.000Z',
      version: 4,
    });
  });

  it('applies defaults for every field missing from the manifest', () => {
    const record = {
      recordId: 'app-empty',
      name: 'Empty',
      description: undefined,
      status: 'DRAFT',
      customDescriptorContent: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    };

    const meta = projectRegistryRecordToMeta(record);

    expect(meta).toEqual({
      appId: 'app-empty',
      orgId: '', // default
      name: 'Empty',
      description: '', // extractHumanDescription(undefined) → ''
      // manifest absent → record.status; record.status='DRAFT' wins.
      status: 'DRAFT',
      workflowIds: [], // default
      routingConfig: '', // default
      createdBy: '', // default
      createdAt: '', // undefined Date → ''
      updatedAt: '', // undefined Date → ''
      version: 1, // default
    });
  });

  it('falls back to descriptor.orgId / descriptor.createdBy / descriptor.version when manifest is absent', () => {
    const customDescriptor = {
      orgId: 'org-from-descriptor',
      createdBy: 'descriptor-user',
      version: 7,
      // No manifest at all.
    };
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: '',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify(customDescriptor),
    };

    const meta = projectRegistryRecordToMeta(record);

    expect(meta.orgId).toBe('org-from-descriptor');
    expect(meta.createdBy).toBe('descriptor-user');
    expect(meta.version).toBe(7);
  });

  it("falls back to record.status when manifest.status is missing", () => {
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: '',
      status: 'APPROVED',
      customDescriptorContent: JSON.stringify({
        manifest: { orgId: 'o', workflowIds: [] },
      }),
    };
    expect(projectRegistryRecordToMeta(record).status).toBe('APPROVED');
  });

  it("defaults status to 'DRAFT' when neither manifest nor record provides it", () => {
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: '',
      status: undefined as unknown as string,
      customDescriptorContent: undefined,
    };
    expect(projectRegistryRecordToMeta(record).status).toBe('DRAFT');
  });

  it('extracts the embedded human description from a JSON-blob description field', () => {
    // Mirrors the legacy fabricator pattern where the entire manifest is
    // serialised into the Registry description column and the human-
    // readable text lives at .description or .info.description.
    const record1 = {
      recordId: 'app-1',
      name: 'App',
      description: JSON.stringify({ description: 'Human readable text' }),
      status: 'DRAFT',
      customDescriptorContent: undefined,
    };
    expect(projectRegistryRecordToMeta(record1).description).toBe(
      'Human readable text',
    );

    const record2 = {
      recordId: 'app-2',
      name: 'App2',
      description: JSON.stringify({
        info: { description: 'OpenAPI-style description' },
      }),
      status: 'DRAFT',
      customDescriptorContent: undefined,
    };
    expect(projectRegistryRecordToMeta(record2).description).toBe(
      'OpenAPI-style description',
    );
  });

  it('preserves a plain-text description unchanged', () => {
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: 'plain text only',
      status: 'DRAFT',
      customDescriptorContent: undefined,
    };
    expect(projectRegistryRecordToMeta(record).description).toBe(
      'plain text only',
    );
  });

  it('serialises a structured manifest.routingConfig to JSON', () => {
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: '',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        manifest: { routingConfig: { strategy: 'first', weight: 0.5 } },
      }),
    };
    expect(projectRegistryRecordToMeta(record).routingConfig).toBe(
      '{"strategy":"first","weight":0.5}',
    );
  });

  it('passes through an already-stringified manifest.routingConfig unchanged', () => {
    const stringified = '{"strategy":"first"}';
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: '',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        manifest: { routingConfig: stringified },
      }),
    };
    expect(projectRegistryRecordToMeta(record).routingConfig).toBe(stringified);
  });

  it('tolerates malformed customDescriptorContent without throwing', () => {
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: '',
      status: 'DRAFT',
      customDescriptorContent: '{ not valid json',
    };
    expect(() => projectRegistryRecordToMeta(record)).not.toThrow();
    const meta = projectRegistryRecordToMeta(record);
    // Falls back to defaults for every manifest-sourced field.
    expect(meta.orgId).toBe('');
    expect(meta.workflowIds).toEqual([]);
    expect(meta.version).toBe(1);
  });

  it('tolerates a non-object customDescriptorContent (e.g. JSON array)', () => {
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: '',
      status: 'DRAFT',
      customDescriptorContent: '[1,2,3]',
    };
    const meta = projectRegistryRecordToMeta(record);
    expect(meta.orgId).toBe('');
    expect(meta.workflowIds).toEqual([]);
  });

  it('coerces non-array workflowIds to an empty array', () => {
    const record = {
      recordId: 'app-1',
      name: 'App',
      description: '',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        manifest: { workflowIds: 'not-an-array' },
      }),
    };
    expect(projectRegistryRecordToMeta(record).workflowIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runReconciliation — end-to-end with mocked AWS clients and Registry.
// ---------------------------------------------------------------------------

describe('runReconciliation', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    ddbMock.reset();
    docClientMock.reset();
    mockListResources.mockReset();
    process.env = { ...ORIGINAL_ENV };
    process.env.REGISTRY_ID = 'reg-test';
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.AWS_REGION = 'us-west-2';
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns a 'dry-run' summary with zeroed counters when both Registry and AppsTable are empty", async () => {
    mockListResources.mockResolvedValue([]);
    docClientMock.on(ScanCommand).resolves({ Items: [] });

    const summary = await runReconciliation({ apply: false });

    expect(summary).toEqual({
      mode: 'dry-run',
      scannedRegistry: 0,
      scannedMeta: 0,
      inSync: 0,
      missing: 0,
      stale: 0,
      orphan: 0,
      fixed: 0,
      errors: 0,
    });
  });

  it("returns mode='apply' when called with apply: true", async () => {
    mockListResources.mockResolvedValue([]);
    docClientMock.on(ScanCommand).resolves({ Items: [] });

    const summary = await runReconciliation({ apply: true });
    expect(summary.mode).toBe('apply');
  });

  it('throws when REGISTRY_ID is unset', async () => {
    delete process.env.REGISTRY_ID;
    await expect(runReconciliation({ apply: false })).rejects.toThrow(
      /REGISTRY_ID/,
    );
  });

  it('throws when APPS_TABLE is unset', async () => {
    delete process.env.APPS_TABLE;
    await expect(runReconciliation({ apply: false })).rejects.toThrow(
      /APPS_TABLE/,
    );
  });
});

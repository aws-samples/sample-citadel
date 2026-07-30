/**
 * replay-package-fixture.test.ts — schema-stability regression guard for
 * the CIT-026 replay package envelope (design §5 / docs/REPLAY_PACKAGE.md).
 *
 * A canned v1.0.0 fixture (matching the documented contract exactly) must
 * parse and satisfy every documented invariant WITHOUT any transformation
 * step — this guards E10/CIT-100's "ingest a replay package unchanged"
 * acceptance criterion. If a future change to the envelope shape breaks
 * this test, it is a signal that either (a) the change is breaking and
 * needs a schemaVersion major bump + doc update, or (b) the fixture/doc
 * needs to be updated to match an additive-safe change.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FIXTURE_PATH = resolve(__dirname, 'fixtures/replay-package-v1.0.0.json');

interface ReplayPackageEnvelopeFixture {
  schemaVersion: string;
  generatedAt: string;
  producerCommit: string | null;
  kind: 'execution' | 'conversation';
  correlationId: string;
  orgId: string;
  sanitisation: {
    redactPiiVersion: string;
    secretPatternsVersion: string;
    gate: 'passed';
  };
  sections: {
    agentConfig: unknown;
    workflow: unknown;
    execSpec: unknown;
    modelConfig: unknown;
    governanceMode: unknown;
    nodes: Array<{
      nodeId: string;
      inputs: unknown;
      outputs: unknown;
      status: unknown;
      retries: unknown;
      usage: unknown;
    }>;
    toolResults: { partial: boolean; results: unknown[]; provenance: string };
    findings: unknown[];
    usageTotals: unknown;
    traceIds: { correlationId: string };
  };
}

describe('replay package v1.0.0 fixture — eval-ingestion contract (CIT-100)', () => {
  let fixture: ReplayPackageEnvelopeFixture;

  beforeAll(() => {
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    fixture = JSON.parse(raw) as ReplayPackageEnvelopeFixture;
  });

  test('parses as valid JSON without any transformation step', () => {
    expect(fixture).toBeDefined();
  });

  test('schemaVersion is semver-shaped and pinned to the documented major (1.x.x)', () => {
    expect(fixture.schemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fixture.schemaVersion.startsWith('1.')).toBe(true);
  });

  test('every documented top-level envelope field is present', () => {
    expect(fixture).toHaveProperty('schemaVersion');
    expect(fixture).toHaveProperty('generatedAt');
    expect(fixture).toHaveProperty('producerCommit');
    expect(fixture).toHaveProperty('kind');
    expect(fixture).toHaveProperty('correlationId');
    expect(fixture).toHaveProperty('orgId');
    expect(fixture).toHaveProperty('sanitisation');
    expect(fixture).toHaveProperty('sections');
  });

  test('sanitisation.gate is always "passed" (a package that failed the gate is never persisted)', () => {
    expect(fixture.sanitisation.gate).toBe('passed');
  });

  test('sections.toolResults is honestly partial with a CIT-121 provenance note (never claims completeness)', () => {
    expect(fixture.sections.toolResults.partial).toBe(true);
    expect(fixture.sections.toolResults.provenance).toMatch(/CIT-121/);
  });

  test('every documented section key is present, even when the underlying value is null/empty (additive-safe consumers never need a null-check crash)', () => {
    const sections = fixture.sections;
    expect(sections).toHaveProperty('agentConfig');
    expect(sections).toHaveProperty('workflow');
    expect(sections).toHaveProperty('execSpec');
    expect(sections).toHaveProperty('modelConfig');
    expect(sections).toHaveProperty('governanceMode');
    expect(sections).toHaveProperty('nodes');
    expect(sections).toHaveProperty('toolResults');
    expect(sections).toHaveProperty('findings');
    expect(sections).toHaveProperty('usageTotals');
    expect(sections).toHaveProperty('traceIds');
    expect(Array.isArray(sections.nodes)).toBe(true);
    expect(Array.isArray(sections.findings)).toBe(true);
  });

  test('traceIds.correlationId equals the top-level correlationId (design: correlation_id == executionId)', () => {
    expect(fixture.sections.traceIds.correlationId).toBe(fixture.correlationId);
  });

  test('every node entry carries the full documented shape', () => {
    for (const node of fixture.sections.nodes) {
      expect(node).toHaveProperty('nodeId');
      expect(node).toHaveProperty('inputs');
      expect(node).toHaveProperty('outputs');
      expect(node).toHaveProperty('status');
      expect(node).toHaveProperty('retries');
      expect(node).toHaveProperty('usage');
    }
  });

  test('the fixture contains no secret-pattern hits (a package that failed the gate could never have been published)', () => {
    // Lazily require here rather than a static cross-package import — this
    // is a frontend-side regression fixture guarding the documented JSON
    // shape, not a backend unit test; duplicating the tiny set of
    // known-bad substrings keeps this test self-contained.
    const serialized = JSON.stringify(fixture);
    const knownBadSubstrings = [
      '-----BEGIN',
      'ghp_',
      'sk_live_',
      'xoxb-',
      'AIza',
    ];
    for (const bad of knownBadSubstrings) {
      expect(serialized).not.toContain(bad);
    }
  });
});

/**
 * Tests for validateImportDescriptor (US-IMP-001).
 *
 * Mirrors the validateManifest test style. Asserts that each of
 * invocation.protocol, invocation.target, and origin.ownership produces a
 * specific, field-naming error when missing/invalid, and that a fully valid
 * descriptor passes.
 */
import { validateImportDescriptor } from '../agent-config-resolver';

describe('validateImportDescriptor (US-IMP-001)', () => {
  const validDescriptor = {
    invocation: {
      protocol: 'AGENTCORE_RUNTIME',
      target: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent',
      auth: { mode: 'SIGV4' },
      mode: 'sync',
    },
    origin: {
      substrate: 'agentcore_runtime',
      discoveredAt: '2026-06-25T00:00:00.000Z',
      ownership: 'external',
    },
  };

  it('accepts a fully valid import descriptor', () => {
    const result = validateImportDescriptor(validDescriptor);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('names invocation.protocol when it is missing', () => {
    const result = validateImportDescriptor({
      invocation: { target: 't', auth: { mode: 'NONE' }, mode: 'sync' },
      origin: validDescriptor.origin,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invocation.protocol'))).toBe(true);
  });

  it('names invocation.protocol when it is not one of the nine protocols', () => {
    const result = validateImportDescriptor({
      invocation: { ...validDescriptor.invocation, protocol: 'TELEPATHY' },
      origin: validDescriptor.origin,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invocation.protocol'))).toBe(true);
  });

  it('names invocation.target when it is missing', () => {
    const result = validateImportDescriptor({
      invocation: { protocol: 'MCP', auth: { mode: 'NONE' }, mode: 'sync' },
      origin: validDescriptor.origin,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invocation.target'))).toBe(true);
  });

  it('names invocation.target when it is an empty/whitespace string', () => {
    const result = validateImportDescriptor({
      invocation: { ...validDescriptor.invocation, target: '   ' },
      origin: validDescriptor.origin,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invocation.target'))).toBe(true);
  });

  it("names origin.ownership when it is not 'external'", () => {
    const result = validateImportDescriptor({
      invocation: validDescriptor.invocation,
      origin: { ...validDescriptor.origin, ownership: 'internal' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('origin.ownership'))).toBe(true);
  });

  it('names origin.ownership when origin is missing entirely', () => {
    const result = validateImportDescriptor({
      invocation: validDescriptor.invocation,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('origin.ownership'))).toBe(true);
  });

  it('names all three fields when everything is missing (empty object)', () => {
    const result = validateImportDescriptor({});
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invocation.protocol'))).toBe(true);
    expect(result.errors.some((e) => e.includes('invocation.target'))).toBe(true);
    expect(result.errors.some((e) => e.includes('origin.ownership'))).toBe(true);
    expect(result.errors).toHaveLength(3);
  });

  it('does not throw on null / undefined / primitive input', () => {
    expect(validateImportDescriptor(null).valid).toBe(false);
    expect(validateImportDescriptor(undefined).valid).toBe(false);
    expect(validateImportDescriptor('not-an-object').valid).toBe(false);
    expect(validateImportDescriptor(null).errors).toHaveLength(3);
  });

  it('accepts every one of the nine protocols', () => {
    const protocols = [
      'AGENTCORE_RUNTIME',
      'BEDROCK_AGENT',
      'LAMBDA_INVOKE',
      'HTTP_ENDPOINT',
      'MCP',
      'A2A',
      'STEP_FUNCTIONS',
      'SAGEMAKER_ENDPOINT',
      'SQS_ASYNC',
    ];
    for (const protocol of protocols) {
      const result = validateImportDescriptor({
        invocation: { protocol, target: 'some-target', auth: { mode: 'NONE' }, mode: 'sync' },
        origin: validDescriptor.origin,
      });
      expect(result.valid).toBe(true);
    }
  });
});

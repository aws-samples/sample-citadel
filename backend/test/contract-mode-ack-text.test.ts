/**
 * Contract drift test — Wave 2.E.
 *
 * The MODE_FLIP_ACKNOWLEDGEMENT_TEXT string is the gate that the backend
 * resolver enforces verbatim against the frontend modal's typed input.
 * Drift between the resolver constant and the frontend constant would
 * silently break the production flip flow without anything else
 * surfacing the bug at type-check time. This test loads both files as
 * plain text and asserts byte-for-byte equality on the literal value.
 */

import * as fs from 'fs';
import * as path from 'path';

describe('MODE_FLIP_ACKNOWLEDGEMENT_TEXT cross-package contract', () => {
  const ACK = 'I understand this affects production governance enforcement';

  it('appears verbatim in the backend resolver', () => {
    const file = fs.readFileSync(
      path.resolve(__dirname, '../src/lambda/governance-ui-resolver.ts'),
      'utf8',
    );
    expect(file).toContain(ACK);
  });

  it('appears verbatim in the frontend service', () => {
    const file = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/services/governanceService.ts'),
      'utf8',
    );
    expect(file).toContain(ACK);
  });

  it('the constant exported from the frontend matches the verbatim text', () => {
    const file = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/services/governanceService.ts'),
      'utf8',
    );
    const match = /MODE_FLIP_ACKNOWLEDGEMENT_TEXT\s*=\s*['"]([^'"]+)['"]/.exec(file);
    expect(match).not.toBeNull();
    expect(match![1]).toEqual(ACK);
  });
});

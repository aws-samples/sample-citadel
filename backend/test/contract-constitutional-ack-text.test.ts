/**
 * Contract drift test — Wave 4.C.2.
 *
 * The CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT string is the gate that
 * the backend resolver enforces verbatim against the frontend rule-editor
 * dialog's acknowledgement checkbox. Drift between the resolver constant
 * and the frontend constant would silently break the production rule-edit
 * flow without anything else surfacing the bug at type-check time. This
 * test loads both files as plain text and asserts byte-for-byte equality
 * on the literal value (mirrors the Wave 2.B / 2.E ack drift test).
 */

import * as fs from 'fs';
import * as path from 'path';

describe('CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT cross-package contract', () => {
  const ACK =
    'I understand this changes the constitutional layer used at engine step 8';

  it('appears verbatim in the backend resolver', () => {
    const file = fs.readFileSync(
      path.resolve(__dirname, '../src/lambda/governance-ui-resolver.ts'),
      'utf8',
    );
    expect(file).toContain(ACK);
  });

  it('appears verbatim in the frontend service', () => {
    const file = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../frontend/src/services/governanceService.ts',
      ),
      'utf8',
    );
    expect(file).toContain(ACK);
  });

  it('the constant exported from the backend resolver matches the verbatim text', () => {
    const file = fs.readFileSync(
      path.resolve(__dirname, '../src/lambda/governance-ui-resolver.ts'),
      'utf8',
    );
    const match = /CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT\s*=\s*['"]([^'"]+)['"]/.exec(
      file,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toEqual(ACK);
  });

  it('the constant exported from the frontend service matches the verbatim text', () => {
    const file = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../frontend/src/services/governanceService.ts',
      ),
      'utf8',
    );
    const match = /CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT\s*=\s*['"]([^'"]+)['"]/.exec(
      file,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toEqual(ACK);
  });
});

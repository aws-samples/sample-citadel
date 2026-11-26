/**
 * Schema contract for the Tier-3 ACCEPT-state fields (additive, READ-only).
 *
 * B1 added the read-only `ProposedManifest` GraphQL type; the Tier-3 ACCEPT
 * step (acceptProposedManifestTier3) stamps reviewState='accepted' plus
 * reviewedBy/reviewedAt. Those audit fields must be exposed READ-only on the
 * `ProposedManifest` type. `reviewState` stays a plain String (NOT an enum), so
 * the 'accepted' value needs no enum change.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Extract the `type ProposedManifest { ... }` block (no nested braces). */
function proposedManifestBlock(): string {
  const schema = readFileSync(join(__dirname, '..', 'schema.graphql'), 'utf8');
  const match = schema.match(/type ProposedManifest \{[^}]*\}/);
  if (!match) {
    throw new Error('type ProposedManifest not found in schema.graphql');
  }
  return match[0];
}

describe('schema.graphql ProposedManifest review-audit fields', () => {
  it('exposes reviewedBy: String read-only', () => {
    expect(proposedManifestBlock()).toMatch(/\breviewedBy:\s*String\b/);
  });

  it('exposes reviewedAt: String read-only', () => {
    expect(proposedManifestBlock()).toMatch(/\breviewedAt:\s*String\b/);
  });

  it('keeps reviewState as a plain String (accepted needs no enum change)', () => {
    expect(proposedManifestBlock()).toMatch(/\breviewState:\s*String\b/);
  });
});

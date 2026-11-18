/**
 * Tests that all consent catalogue labels start with ✅.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONSENT_CATALOGUE } from '../intakeConsentService';

describe('consent catalogue labels carry emoji', () => {
  it('every CONSENT_CATALOGUE label starts with ✅', () => {
    for (const [, entry] of Object.entries(CONSENT_CATALOGUE)) {
      expect(entry.label).toMatch(/^✅/);
    }
  });

  it('the canonical JSON file labels all start with ✅', () => {
    const jsonPath = path.resolve(
      __dirname,
      '../../../../service/agent_intake_single/tools/consent_catalogue.json',
    );
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    for (const [, entry] of Object.entries(json) as [string, { label: string }][]) {
      expect(entry.label).toMatch(/^✅/);
    }
  });
});

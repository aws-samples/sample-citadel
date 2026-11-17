/**
 * Tests — backend VALID_ACTIONS matches the canonical consent_catalogue.json.
 */
import { jest, describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: jest.fn() }) },
  GetCommand: jest.fn(),
  PutCommand: jest.fn(),
  ScanCommand: jest.fn(),
}));
jest.mock('../../utils/auth-event', () => ({
  requireCallerOrg: jest.fn(),
  extractOrgFromEvent: jest.fn(),
  OrgUnresolvedError: class extends Error {},
}));
jest.mock('../../utils/org-membership', () => ({
  lookupOwnerOrganization: jest.fn(),
}));

describe('intake-consent-resolver catalogue parity', () => {
  const CATALOGUE_PATH = path.resolve(
    __dirname,
    '../../../../service/agent_intake_single/tools/consent_catalogue.json',
  );

  it('consent_catalogue.json exists at the expected repo-relative path', () => {
    expect(fs.existsSync(CATALOGUE_PATH)).toBe(true);
  });

  it('VALID_ACTIONS matches the keys in consent_catalogue.json', () => {
    const json = JSON.parse(fs.readFileSync(CATALOGUE_PATH, 'utf-8'));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { VALID_ACTIONS } = require('../intake-consent-resolver') as {
      VALID_ACTIONS: Set<string>;
    };
    expect(new Set(Object.keys(json))).toEqual(VALID_ACTIONS);
  });
});

/**
 * Scope tests — `scopeCovers` + `scopeSpecificity` correctness.
 */

import { scopeCovers, scopeSpecificity } from '../scope';
import { makeRequest, makeScope } from './fixtures';

describe('scopeCovers — decisionType matching', () => {
  it('wildcard "*" matches any actionType', () => {
    const scope = makeScope({ decisionType: '*', domain: 'payment' });
    const request = makeRequest({ actionType: 'execute_tool', domain: 'payment' });
    expect(scopeCovers(scope, request)).toBe(true);
  });

  it('exact match returns true', () => {
    const scope = makeScope({ decisionType: 'invoke_agent', domain: '*' });
    const request = makeRequest({ actionType: 'invoke_agent', domain: 'payment' });
    expect(scopeCovers(scope, request)).toBe(true);
  });

  it('mismatch returns false', () => {
    const scope = makeScope({ decisionType: 'invoke_agent', domain: '*' });
    const request = makeRequest({ actionType: 'execute_tool', domain: 'payment' });
    expect(scopeCovers(scope, request)).toBe(false);
  });
});

describe('scopeCovers — domain matching', () => {
  it('wildcard "*" matches any domain', () => {
    const scope = makeScope({ decisionType: '*', domain: '*' });
    const request = makeRequest({ domain: 'fraud' });
    expect(scopeCovers(scope, request)).toBe(true);
  });

  it('mismatch returns false', () => {
    const scope = makeScope({ decisionType: '*', domain: 'payment' });
    const request = makeRequest({ domain: 'fraud' });
    expect(scopeCovers(scope, request)).toBe(false);
  });
});

describe('scopeCovers — conditions', () => {
  it('every condition key must equal the same context key', () => {
    const scope = makeScope({
      conditions: { region: 'us-east-1', tier: 'gold' },
    });
    const request = makeRequest({
      context: { region: 'us-east-1', tier: 'gold' },
    });
    expect(scopeCovers(scope, request)).toBe(true);
  });

  it('any mismatched condition fails', () => {
    const scope = makeScope({ conditions: { region: 'us-east-1' } });
    const request = makeRequest({ context: { region: 'eu-west-1' } });
    expect(scopeCovers(scope, request)).toBe(false);
  });

  it('missing context key fails (undefined !== expected)', () => {
    const scope = makeScope({ conditions: { region: 'us-east-1' } });
    const request = makeRequest({ context: {} });
    expect(scopeCovers(scope, request)).toBe(false);
  });
});

describe('scopeCovers — limits', () => {
  it('actual <= limit passes', () => {
    const scope = makeScope({ limits: { amount: 100 } });
    const request = makeRequest({ context: { amount: 50 } });
    expect(scopeCovers(scope, request)).toBe(true);
  });

  it('actual > limit fails', () => {
    const scope = makeScope({ limits: { amount: 100 } });
    const request = makeRequest({ context: { amount: 150 } });
    expect(scopeCovers(scope, request)).toBe(false);
  });

  it('actual === limit passes (boundary)', () => {
    const scope = makeScope({ limits: { amount: 100 } });
    const request = makeRequest({ context: { amount: 100 } });
    expect(scopeCovers(scope, request)).toBe(true);
  });

  it('non-numeric actual is ignored', () => {
    const scope = makeScope({ limits: { amount: 100 } });
    const request = makeRequest({ context: { amount: 'unknown' } });
    expect(scopeCovers(scope, request)).toBe(true);
  });

  it('missing actual passes', () => {
    const scope = makeScope({ limits: { amount: 100 } });
    const request = makeRequest({ context: {} });
    expect(scopeCovers(scope, request)).toBe(true);
  });
});

describe('scopeSpecificity', () => {
  it('returns |conditions| + |limits|', () => {
    const scope = makeScope({
      conditions: { a: 1, b: 2 },
      limits: { c: 10 },
    });
    expect(scopeSpecificity(scope)).toBe(3);
  });

  it('zero when both empty', () => {
    expect(scopeSpecificity(makeScope())).toBe(0);
  });
});

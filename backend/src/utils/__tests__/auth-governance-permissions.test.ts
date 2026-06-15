/**
 * Governance-track permission tests for the Cognito `architect` role.
 *
 * Per QT1-5 + QT2B-7: the existing `architect` role absorbs all new
 * governance permissions. No new Cognito groups are introduced.
 *
 * Story coverage:
 * — adr:create (this file, RED-GREEN below)
 * — adr:reopen (later wave)
 * — spec:approve (later wave)
 */

import { hasPermission } from '../auth';
import type { AuthContext } from '../../types';

function ctx(roles: string[]): AuthContext {
  return { userId: 'u1', username: 'u1', groups: [], roles };
}

describe('Governance permissions — architect role', () => {
  describe('adr:create', () => {
    test('architect role has adr:create', () => {
      expect(hasPermission(ctx(['architect']), 'adr:create')).toBe(true);
    });

    test('developer role does NOT have adr:create', () => {
      expect(hasPermission(ctx(['developer']), 'adr:create')).toBe(false);
    });

    test('project_manager role does NOT have adr:create', () => {
      expect(hasPermission(ctx(['project_manager']), 'adr:create')).toBe(false);
    });

    test('admin bypass grants adr:create even without explicit listing', () => {
      expect(hasPermission(ctx(['admin']), 'adr:create')).toBe(true);
    });

    test('no role + no admin denies adr:create', () => {
      expect(hasPermission(ctx([]), 'adr:create')).toBe(false);
    });
  });

  describe('regression — existing architect permissions preserved', () => {
    const architect = ctx(['architect']);

    test.each([
      'project:read',
      'project:update',
      'agent:interact',
      'conversation:read',
      'conversation:write',
      'document:upload',
    ])('architect retains existing permission %s', (perm) => {
      expect(hasPermission(architect, perm)).toBe(true);
    });
  });
});

describe('registry permissions (Decision #7)', () => {
  const architect = ctx(['architect']);
  const developer = ctx(['developer']);
  const admin = ctx(['admin']);
  const pm = ctx(['project_manager']);

  test('architect has registry:create', () => {
    expect(hasPermission(architect, 'registry:create')).toBe(true);
  });

  test('architect has registry:update', () => {
    expect(hasPermission(architect, 'registry:update')).toBe(true);
  });

  test('architect has registry:submit', () => {
    expect(hasPermission(architect, 'registry:submit')).toBe(true);
  });

  test('developer has registry:read', () => {
    expect(hasPermission(developer, 'registry:read')).toBe(true);
  });

  test('admin has registry:create', () => {
    expect(hasPermission(admin, 'registry:create')).toBe(true);
  });

  test('admin has registry:update', () => {
    expect(hasPermission(admin, 'registry:update')).toBe(true);
  });

  test('admin has registry:delete', () => {
    expect(hasPermission(admin, 'registry:delete')).toBe(true);
  });

  test('admin has registry:approve', () => {
    expect(hasPermission(admin, 'registry:approve')).toBe(true);
  });

  test('admin has registry:read', () => {
    expect(hasPermission(admin, 'registry:read')).toBe(true);
  });

  test('developer does NOT have registry:create', () => {
    expect(hasPermission(developer, 'registry:create')).toBe(false);
  });

  test('project_manager does NOT have registry:create', () => {
    expect(hasPermission(pm, 'registry:create')).toBe(false);
  });

  test('project_manager does NOT have registry:read', () => {
    expect(hasPermission(pm, 'registry:read')).toBe(false);
  });

  test('project_manager does NOT have registry:update', () => {
    expect(hasPermission(pm, 'registry:update')).toBe(false);
  });

  test('architect does NOT have registry:delete', () => {
    expect(hasPermission(architect, 'registry:delete')).toBe(false);
  });

  test('architect does NOT have registry:approve', () => {
    expect(hasPermission(architect, 'registry:approve')).toBe(false);
  });
});

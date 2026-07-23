/**
 * Tests for useUserDisplayName hook
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUserDisplayName, isUserId, formatUserDisplayName, clearUserDisplayNameCache } from '../useUserDisplayName';

// Mock the userManagementService
jest.mock('../../services/userManagementService', () => ({
  userManagementService: {
    getUser: jest.fn(),
    listUsers: jest.fn(),
  },
}));

import { userManagementService } from '../../services/userManagementService';

const mockGetUser = userManagementService.getUser as jest.MockedFunction<typeof userManagementService.getUser>;
const mockListUsers = userManagementService.listUsers as jest.MockedFunction<typeof userManagementService.listUsers>;

describe('useUserDisplayName', () => {
  beforeEach(() => {
    clearUserDisplayNameCache();
    mockGetUser.mockReset();
    mockListUsers.mockReset();
    // Default: bulk load returns empty list (individual getUser will be used)
    mockListUsers.mockResolvedValue([]);
  });

  it('returns "unknown" for null/undefined userId', () => {
    const { result } = renderHook(() => useUserDisplayName(null));
    expect(result.current).toBe('unknown');
  });

  it('returns the userId as-is when it is not a UUID', () => {
    const { result } = renderHook(() => useUserDisplayName('John Doe'));
    expect(result.current).toBe('John Doe');
  });

  it('resolves a UUID userId to a display name', async () => {
    const userId = 'e9fe7448-60d1-7021-2c07-b58fd0c23d16';
    mockGetUser.mockResolvedValueOnce({
      userId,
      email: 'jane@example.com',
      name: 'Jane Smith',
      givenName: 'Jane',
      familyName: 'Smith',
      status: 'CONFIRMED',
      createdAt: '2024-01-01',
      enabled: true,
    });

    const { result } = renderHook(() => useUserDisplayName(userId));

    // Initially shows empty string (no GUID flash)
    expect(result.current).toBe('');

    // After resolution, shows the full name
    await waitFor(() => {
      expect(result.current).toBe('Jane Smith');
    });

    expect(mockGetUser).toHaveBeenCalledWith(userId);
  });

  it('falls back to email when givenName/familyName are empty', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    mockGetUser.mockResolvedValueOnce({
      userId,
      email: 'dev@company.com',
      name: '',
      givenName: '',
      familyName: '',
      status: 'CONFIRMED',
      createdAt: '2024-01-01',
      enabled: true,
    });

    const { result } = renderHook(() => useUserDisplayName(userId));

    await waitFor(() => {
      expect(result.current).toBe('dev@company.com');
    });
  });

  it('uses the cache on subsequent calls for the same userId', async () => {
    const userId = 'e9fe7448-60d1-7021-2c07-b58fd0c23d16';
    mockGetUser.mockResolvedValueOnce({
      userId,
      email: 'jane@example.com',
      name: 'Jane Smith',
      givenName: 'Jane',
      familyName: 'Smith',
      status: 'CONFIRMED',
      createdAt: '2024-01-01',
      enabled: true,
    });

    // First call
    const { result: result1 } = renderHook(() => useUserDisplayName(userId));
    await waitFor(() => {
      expect(result1.current).toBe('Jane Smith');
    });

    // Second call — should use cache, no additional API call
    const { result: result2 } = renderHook(() => useUserDisplayName(userId));
    expect(result2.current).toBe('Jane Smith');
    expect(mockGetUser).toHaveBeenCalledTimes(1);
  });

  it('shows truncated ID on API error', async () => {
    const userId = 'deadbeef-1234-5678-9abc-def012345678';
    mockListUsers.mockResolvedValueOnce([]); // bulk load returns nothing
    mockGetUser.mockRejectedValueOnce(new Error('User not found'));

    const { result } = renderHook(() => useUserDisplayName(userId));

    await waitFor(() => {
      expect(result.current).toBe('deadbeef…');
    });
  });

  it('resolves from bulk-loaded user list without calling getUser', async () => {
    const userId = 'aaaabbbb-1111-2222-3333-444455556666';
    mockListUsers.mockResolvedValueOnce([
      {
        userId,
        email: 'bulk@example.com',
        name: '',
        givenName: 'Bulk',
        familyName: 'User',
        status: 'CONFIRMED',
        createdAt: '2024-01-01',
        enabled: true,
      },
    ]);

    const { result } = renderHook(() => useUserDisplayName(userId));

    await waitFor(() => {
      expect(result.current).toBe('Bulk User');
    });

    // getUser should NOT have been called — resolved from bulk load
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe('isUserId', () => {
  it('returns true for valid UUIDs', () => {
    expect(isUserId('e9fe7448-60d1-7021-2c07-b58fd0c23d16')).toBe(true);
    expect(isUserId('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUserId('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(true);
  });

  it('returns false for non-UUIDs', () => {
    expect(isUserId('john@example.com')).toBe(false);
    expect(isUserId('John Doe')).toBe(false);
    expect(isUserId('user-1')).toBe(false);
    expect(isUserId('')).toBe(false);
  });
});

describe('formatUserDisplayName', () => {
  it('prefers givenName + familyName', () => {
    expect(formatUserDisplayName({
      userId: 'id-1',
      email: 'j@e.com',
      name: 'J Smith',
      givenName: 'Jane',
      familyName: 'Smith',
      status: 'CONFIRMED',
      createdAt: '',
      enabled: true,
    })).toBe('Jane Smith');
  });

  it('falls back to name field', () => {
    expect(formatUserDisplayName({
      userId: 'id-1',
      email: 'j@e.com',
      name: 'J Smith',
      givenName: '',
      familyName: '',
      status: 'CONFIRMED',
      createdAt: '',
      enabled: true,
    })).toBe('J Smith');
  });

  it('falls back to email', () => {
    expect(formatUserDisplayName({
      userId: 'id-1',
      email: 'j@e.com',
      name: '',
      givenName: '',
      familyName: '',
      status: 'CONFIRMED',
      createdAt: '',
      enabled: true,
    })).toBe('j@e.com');
  });

  it('falls back to userId as last resort', () => {
    expect(formatUserDisplayName({
      userId: 'id-1',
      email: '',
      name: '',
      givenName: '',
      familyName: '',
      status: 'CONFIRMED',
      createdAt: '',
      enabled: true,
    })).toBe('id-1');
  });
});

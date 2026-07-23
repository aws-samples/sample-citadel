/**
 * useUserDisplayName Hook
 *
 * Resolves Cognito user IDs (GUIDs) to human-readable display names.
 * Uses a module-level cache so repeated lookups across components are instant.
 *
 * On first use, bulk-loads all users via listUsers() to pre-warm the cache.
 * This eliminates the "flash of GUID" — subsequent lookups resolve synchronously.
 *
 * Usage:
 *   const displayName = useUserDisplayName(userId);
 *   // Returns the resolved name immediately (after initial bulk load)
 */
import { useState, useEffect } from 'react';
import { userManagementService, User } from '../services/userManagementService';

// Module-level cache: persists across component mounts/unmounts within the SPA session.
const userCache = new Map<string, { displayName: string; status: 'resolved' | 'error' }>();
const pendingRequests = new Map<string, Promise<User>>();

// Bulk pre-warm: load all users once on first hook usage.
let bulkLoadPromise: Promise<void> | null = null;
let bulkLoadDone = false;

function ensureBulkLoad(): Promise<void> {
  if (bulkLoadDone) return Promise.resolve();
  if (!bulkLoadPromise) {
    bulkLoadPromise = userManagementService.listUsers()
      .then((users) => {
        for (const user of users) {
          const name = formatUserDisplayName(user);
          userCache.set(user.userId, { displayName: name, status: 'resolved' });
        }
        bulkLoadDone = true;
      })
      .catch(() => {
        // Bulk load failed — individual lookups will still work as fallback
        bulkLoadDone = true;
      });
  }
  return bulkLoadPromise;
}

// UUID v4 pattern (loose match for Cognito sub IDs)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Determines if a string looks like a raw user ID (UUID/GUID).
 */
export function isUserId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Formats a User object into a display name.
 * Priority: "GivenName FamilyName" > name > email > userId
 */
export function formatUserDisplayName(user: User): string {
  if (user.givenName && user.familyName) {
    return `${user.givenName} ${user.familyName}`;
  }
  if (user.name) {
    return user.name;
  }
  if (user.email) {
    return user.email;
  }
  return user.userId;
}

/**
 * Truncates a UUID for display while loading (e.g., "e9fe7448…").
 */
function truncateId(userId: string): string {
  if (userId.length > 8) {
    return `${userId.substring(0, 8)}…`;
  }
  return userId;
}

/**
 * React hook that resolves a user ID to a display name.
 *
 * @param userId - The Cognito user ID (GUID) to resolve
 * @returns The resolved display name, or a loading/fallback string
 */
export function useUserDisplayName(userId: string | undefined | null): string {
  const [displayName, setDisplayName] = useState<string>(() => {
    if (!userId) return 'unknown';
    // Check cache synchronously on first render (works after bulk load)
    const cached = userCache.get(userId);
    if (cached) return cached.displayName;
    // If it's not a UUID, return it as-is (might already be a name)
    if (!isUserId(userId)) return userId;
    // Show empty string during load to avoid GUID flash
    return '';
  });

  useEffect(() => {
    if (!userId) {
      setDisplayName('unknown');
      return;
    }

    // Not a UUID — treat it as already-resolved
    if (!isUserId(userId)) {
      setDisplayName(userId);
      return;
    }

    // Already cached (e.g. from bulk load)
    const cached = userCache.get(userId);
    if (cached) {
      setDisplayName(cached.displayName);
      return;
    }

    let cancelled = false;

    // Wait for bulk load first, then check cache or fall back to individual lookup
    ensureBulkLoad().then(() => {
      if (cancelled) return;

      const cachedAfterBulk = userCache.get(userId);
      if (cachedAfterBulk) {
        setDisplayName(cachedAfterBulk.displayName);
        return;
      }

      // User not in bulk list — fall back to individual getUser
      let request = pendingRequests.get(userId);
      if (!request) {
        request = userManagementService.getUser(userId);
        pendingRequests.set(userId, request);
      }

      request
        .then((user) => {
          const name = formatUserDisplayName(user);
          userCache.set(userId, { displayName: name, status: 'resolved' });
          if (!cancelled) {
            setDisplayName(name);
          }
        })
        .catch(() => {
          const fallback = truncateId(userId);
          userCache.set(userId, { displayName: fallback, status: 'error' });
          if (!cancelled) {
            setDisplayName(fallback);
          }
        })
        .finally(() => {
          pendingRequests.delete(userId);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  return displayName;
}

/**
 * Batch-resolve multiple user IDs at once.
 * Useful when a list view shows multiple createdBy fields.
 */
export function useUserDisplayNames(userIds: (string | undefined | null)[]): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const id of userIds) {
      if (!id) continue;
      const cached = userCache.get(id);
      if (cached) {
        map.set(id, cached.displayName);
      } else if (!isUserId(id)) {
        map.set(id, id);
      } else {
        map.set(id, truncateId(id));
      }
    }
    return map;
  });

  useEffect(() => {
    const idsToResolve = userIds.filter(
      (id): id is string => !!id && isUserId(id) && !userCache.has(id)
    );

    if (idsToResolve.length === 0) {
      // All resolved from cache
      const map = new Map<string, string>();
      for (const id of userIds) {
        if (!id) continue;
        const cached = userCache.get(id);
        map.set(id, cached ? cached.displayName : (!isUserId(id) ? id : truncateId(id)));
      }
      setNames(map);
      return;
    }

    let cancelled = false;

    // Resolve all uncached IDs in parallel
    const promises = idsToResolve.map((id) => {
      let request = pendingRequests.get(id);
      if (!request) {
        request = userManagementService.getUser(id);
        pendingRequests.set(id, request);
      }
      return request
        .then((user) => {
          const name = formatUserDisplayName(user);
          userCache.set(id, { displayName: name, status: 'resolved' });
        })
        .catch(() => {
          userCache.set(id, { displayName: truncateId(id), status: 'error' });
        })
        .finally(() => {
          pendingRequests.delete(id);
        });
    });

    Promise.all(promises).then(() => {
      if (cancelled) return;
      const map = new Map<string, string>();
      for (const id of userIds) {
        if (!id) continue;
        const cached = userCache.get(id);
        map.set(id, cached ? cached.displayName : (!isUserId(id) ? id : truncateId(id)));
      }
      setNames(map);
    });

    return () => {
      cancelled = true;
    };
  }, [JSON.stringify(userIds)]);

  return names;
}

/**
 * Clears the user display name cache.
 * Useful for testing or when user profiles are updated.
 */
export function clearUserDisplayNameCache(): void {
  userCache.clear();
  pendingRequests.clear();
  bulkLoadPromise = null;
  bulkLoadDone = false;
}

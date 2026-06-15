/**
 * AuthorityScope predicates — TypeScript port of the `covers` /
 * `specificity` methods on `AuthorityScope` in `arbiter/governance/models.py`.
 *
 * Pure functions over plain interfaces. No I/O.
 */

import type { AuthorityScope, DispatchRequest } from './models';

/**
 * Conjunctive predicate match. Mirrors `AuthorityScope.covers` in
 * `models.py:L49-L68`:
 *
 *   - decisionType `'*'` is a wildcard that matches any action_type.
 *   - domain `'*'` is a wildcard that matches any domain.
 *   - every conditions key must equal the same key on `request.context`.
 *   - every limits key, when present in context as a number, must not
 *     exceed the limit. Non-numeric and missing values are ignored.
 */
export function scopeCovers(
  scope: AuthorityScope,
  request: DispatchRequest,
): boolean {
  if (scope.decisionType !== request.actionType && scope.decisionType !== '*') {
    return false;
  }
  if (scope.domain !== request.domain && scope.domain !== '*') {
    return false;
  }

  for (const [key, expected] of Object.entries(scope.conditions)) {
    const actual = request.context[key];
    if (actual !== expected) {
      return false;
    }
  }

  for (const [key, limit] of Object.entries(scope.limits)) {
    const actual = request.context[key];
    if (actual !== undefined && actual !== null && typeof actual === 'number') {
      if (actual > limit) {
        return false;
      }
    }
  }

  return true;
}

/**
 * |conditions| + |limits|. Mirrors `AuthorityScope.specificity` in
 * `models.py`. Used for tightest-scope selection.
 */
export function scopeSpecificity(scope: AuthorityScope): number {
  return Object.keys(scope.conditions).length + Object.keys(scope.limits).length;
}

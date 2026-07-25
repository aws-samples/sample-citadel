/**
 * The move manifest — the single source of truth for "what has moved out of
 * the backend stack, to where, and why". Later move stages append to these
 * lists; THIS stage (safety gates, no resources move) keeps every list
 * empty, which is what makes rails 3/6/7 pass trivially against the
 * current, unmoved synth (see split-gates.sh run output).
 *
 * Kept as a plain TS module (not JSON) so it can export typed, empty arrays
 * that the rail functions accept directly without a parse step, and so a
 * move stage can extend it with inline comments explaining each entry.
 */
import { AllowlistEntry } from "./rails/rail1-removals-only";
import { MovedLambdaMapping } from "./rails/rail6-iam-equivalence";
import { MovedResolverMapping } from "./rails/rail7-resolver-equivalence";

/** Logical IDs the removals-only diff (rail 1) is allowed to see disappear from backend, with justification. */
export const REMOVAL_ALLOWLIST: AllowlistEntry[] = [];

/** Resolver fields moved to a satellite stack, for rail 3 parity + rail 7 equivalence. */
export const MOVED_RESOLVERS: MovedResolverMapping[] = [];

/** Lambda logical-ID name-mapping (backend baseline -> satellite) for rail 6 IAM equivalence. */
export const MOVED_LAMBDA_ROLES: MovedLambdaMapping[] = [];

/** Satellite stack names participating in the split, for rail 3's merged-set computation. Empty until a move stage creates one. */
export const SATELLITE_STACK_NAMES: string[] = [];

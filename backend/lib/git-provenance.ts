/**
 * Deployment provenance tags (CIT-215).
 *
 * Every CDK stack is tagged with the git sha (and ref) it was deployed from,
 * so "is fix X deployed to <env>?" is answerable from CloudFormation alone:
 *
 *   sha=$(aws cloudformation describe-stacks --stack-name citadel-backend-dev \
 *           --query "Stacks[0].Tags[?Key=='GitSha'].Value" --output text)
 *   git merge-base --is-ancestor <fix-sha> "$sha" && echo deployed
 *
 * Resolution order (same "resolve in app, pass down" shape as
 * alarm-delivery / frontend-origin):
 *   1. CDK context `gitSha` / `gitRef` — deploy.sh passes
 *      `--context gitSha=$(git rev-parse HEAD)` to every cdk invocation;
 *   2. env `CITADEL_GIT_SHA` / `CITADEL_GIT_REF` — for CI pipelines that
 *      export the sha instead of threading context;
 *   3. the literal `unknown`.
 *
 * This module NEVER shells out to git and NEVER throws: synth must stay
 * deterministic and must work in CI checkouts without a `.git` directory.
 * An `unknown` tag is an honest answer; a failed synth is not.
 */
import * as cdk from "aws-cdk-lib";
import type { IConstruct } from "constructs";

export const GIT_PROVENANCE_TAGS = {
  SHA: "GitSha",
  REF: "GitRef",
} as const;

export const GIT_PROVENANCE_CONTEXT = {
  SHA: "gitSha",
  REF: "gitRef",
} as const;

export const GIT_PROVENANCE_ENV = {
  SHA: "CITADEL_GIT_SHA",
  REF: "CITADEL_GIT_REF",
} as const;

export const UNKNOWN_GIT_VALUE = "unknown";

export interface GitProvenance {
  /** Full commit sha the deploy was made from, or `unknown`. */
  readonly gitSha: string;
  /** Branch/tag name the deploy was made from, or `unknown`. */
  readonly gitRef: string;
}

export interface ResolveGitProvenanceOptions {
  /** Optional CDK-context reader (e.g. `app.node.tryGetContext`). */
  readonly context?: (key: string) => unknown;
  /** Defaults to `process.env`. Injected for unit testing. */
  readonly env?: Record<string, string | undefined>;
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(
  opts: ResolveGitProvenanceOptions,
  contextKey: string,
  envKey: string,
): string {
  const fromCtx = nonBlankString(opts.context?.(contextKey));
  if (fromCtx !== undefined) return fromCtx;
  const env = opts.env ?? process.env;
  return nonBlankString(env[envKey]) ?? UNKNOWN_GIT_VALUE;
}

/** Resolve the git sha/ref for provenance tags. Never throws. */
export function resolveGitProvenance(
  opts: ResolveGitProvenanceOptions,
): GitProvenance {
  return {
    gitSha: read(opts, GIT_PROVENANCE_CONTEXT.SHA, GIT_PROVENANCE_ENV.SHA),
    gitRef: read(opts, GIT_PROVENANCE_CONTEXT.REF, GIT_PROVENANCE_ENV.REF),
  };
}

/**
 * Apply `GitSha` / `GitRef` tags to `scope` (normally the `cdk.App`, so the
 * tags reach every stack — present and future — and every taggable resource
 * inside them via the Tags aspect).
 */
export function applyGitProvenanceTags(
  scope: IConstruct,
  provenance: GitProvenance,
): void {
  cdk.Tags.of(scope).add(GIT_PROVENANCE_TAGS.SHA, provenance.gitSha);
  cdk.Tags.of(scope).add(GIT_PROVENANCE_TAGS.REF, provenance.gitRef);
}

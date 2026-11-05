/**
 * Seed Blueprints — data-only definitions, safe for CDK synth-time import.
 *
 * This file contains SEED_VERSION, blueprint/smoke data, deterministic-ID
 * helpers, and the content fingerprint used by backend-stack.ts to force a
 * custom-resource re-invocation whenever seed content changes.
 *
 * MUST NOT import any AWS SDK modules (DynamoDB, etc.) — those instantiate
 * clients at module load time and would fail during `cdk synth`.
 */

import { createHash } from "crypto";

// ── SEED_VERSION ───────────────────────────────────────────────────────
/**
 * Monotonic seed-content version stamped on every seeded row as
 * `seedVersion`. Bump it whenever the seeded blueprint content changes shape
 * so existing SYSTEM seed rows are healed on the next deploy (user rows are
 * never touched — see the ConditionExpression in the handler). Version 2
 * introduced the full canvas-shape WorkflowDefinition envelope; version 3
 * rewrites agent references from friendly names to registry recordIds (+ a
 * `legacyAgentName` on each node for traceability). Rows seeded before v3
 * are healed exactly once. Version 4 made the Conditional Router blueprint
 * runnable (demo-router-agent + demo-echo-agent instead of placeholders).
 */
export const SEED_VERSION = 4;

// ── Deterministic ID ───────────────────────────────────────────────────
/** Deterministic ID from blueprint name so re-deploys don't create duplicates. */
export function deterministicId(name: string): string {
  const hash = createHash("sha256")
    .update(`citadel-seed-blueprint:${name}`)
    .digest("hex");
  // Format as UUID-like: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

// ── Types ──────────────────────────────────────────────────────────────
export interface SeedBlueprintNode {
  id: string;
  agentId: string;
  legacyAgentName?: string;
  position: { x: number; y: number };
  configuration: Record<string, unknown>;
}

export interface SeedBlueprintEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  condition?: { field: string; operator: string; value: unknown };
}

export interface SeedBlueprintDefinition {
  nodes: SeedBlueprintNode[];
  edges: SeedBlueprintEdge[];
}

export interface SeedBlueprint {
  name: string;
  description: string;
  category: string;
  definition: SeedBlueprintDefinition;
  metadata: { category: string; isSystem: boolean; tags: string[] };
}

// ── Seed data ──────────────────────────────────────────────────────────

export const SEED_BLUEPRINTS: SeedBlueprint[] = [
  // 1. Sequential Agent Pipeline — 3 nodes in series
  {
    name: "Sequential Agent Pipeline",
    description:
      "[Template] Three agents executing in sequence — each passes output to the next. Clone and re-map agent IDs before publishing.",
    category: "pipeline",
    definition: {
      nodes: [
        {
          id: "node-1",
          agentId: "placeholder-agent-1",
          position: { x: 100, y: 200 },
          configuration: {},
        },
        {
          id: "node-2",
          agentId: "placeholder-agent-2",
          position: { x: 400, y: 200 },
          configuration: {},
        },
        {
          id: "node-3",
          agentId: "placeholder-agent-3",
          position: { x: 700, y: 200 },
          configuration: {},
        },
      ],
      edges: [
        {
          id: "edge-1-2",
          source: "node-1",
          target: "node-2",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-2-3",
          source: "node-2",
          target: "node-3",
          sourceHandle: "output",
          targetHandle: "input",
        },
      ],
    },
    metadata: {
      category: "pipeline",
      isSystem: true,
      tags: ["sequential", "basic"],
    },
  },

  // 2. Parallel Fan-Out — 1 root → 3 parallel → 1 convergence (5 nodes, 6 edges)
  {
    name: "Parallel Fan-Out",
    description:
      "[Template] One root agent fans out to three parallel agents, then converges to a single aggregator. Clone and re-map agent IDs before publishing.",
    category: "parallel",
    definition: {
      nodes: [
        {
          id: "root",
          agentId: "placeholder-root",
          position: { x: 400, y: 50 },
          configuration: {},
        },
        {
          id: "branch-a",
          agentId: "placeholder-branch-a",
          position: { x: 100, y: 250 },
          configuration: {},
        },
        {
          id: "branch-b",
          agentId: "placeholder-branch-b",
          position: { x: 400, y: 250 },
          configuration: {},
        },
        {
          id: "branch-c",
          agentId: "placeholder-branch-c",
          position: { x: 700, y: 250 },
          configuration: {},
        },
        {
          id: "aggregator",
          agentId: "placeholder-aggregator",
          position: { x: 400, y: 450 },
          configuration: {},
        },
      ],
      edges: [
        {
          id: "edge-root-a",
          source: "root",
          target: "branch-a",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-root-b",
          source: "root",
          target: "branch-b",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-root-c",
          source: "root",
          target: "branch-c",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-a-agg",
          source: "branch-a",
          target: "aggregator",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-b-agg",
          source: "branch-b",
          target: "aggregator",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-c-agg",
          source: "branch-c",
          target: "aggregator",
          sourceHandle: "output",
          targetHandle: "input",
        },
      ],
    },
    metadata: {
      category: "parallel",
      isSystem: true,
      tags: ["parallel", "fan-out", "convergence"],
    },
  },

  // 3. Conditional Router — 1 root → 2 conditional branches → 1 convergence (4 nodes, 4 edges)
  {
    name: "Conditional Router",
    description:
      'Runnable demo: a router agent selects branch-a or branch-b based on input. Run with input {"route": "branch-b"} to take the branch-b path; default is branch-a. References real seeded agents.',
    category: "conditional",
    definition: {
      nodes: [
        {
          id: "router",
          agentId: "demo-router-agent",
          position: { x: 400, y: 50 },
          configuration: {},
        },
        {
          id: "branch-true",
          agentId: "demo-echo-agent",
          position: { x: 200, y: 250 },
          configuration: {},
        },
        {
          id: "branch-false",
          agentId: "demo-echo-agent",
          position: { x: 600, y: 250 },
          configuration: {},
        },
        {
          id: "merger",
          agentId: "demo-echo-agent",
          position: { x: 400, y: 450 },
          configuration: {},
        },
      ],
      edges: [
        {
          id: "edge-router-true",
          source: "router",
          target: "branch-true",
          sourceHandle: "output",
          targetHandle: "input",
          condition: {
            field: "result.route",
            operator: "equals",
            value: "branch-a",
          },
        },
        {
          id: "edge-router-false",
          source: "router",
          target: "branch-false",
          sourceHandle: "output",
          targetHandle: "input",
          condition: {
            field: "result.route",
            operator: "equals",
            value: "branch-b",
          },
        },
        {
          id: "edge-true-merger",
          source: "branch-true",
          target: "merger",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-false-merger",
          source: "branch-false",
          target: "merger",
          sourceHandle: "output",
          targetHandle: "input",
        },
      ],
    },
    metadata: {
      category: "conditional",
      isSystem: true,
      tags: ["conditional", "routing", "branching"],
    },
  },

  // 4. Data Processing Pipeline — ingest → transform → validate → store (4 nodes, 3 edges)
  {
    name: "Data Processing Pipeline",
    description:
      "[Template] Ingest → Transform → Validate → Store pipeline for data processing workflows. Clone and re-map agent IDs before publishing.",
    category: "data-processing",
    definition: {
      nodes: [
        {
          id: "ingest",
          agentId: "placeholder-ingest",
          position: { x: 100, y: 200 },
          configuration: {},
        },
        {
          id: "transform",
          agentId: "placeholder-transform",
          position: { x: 350, y: 200 },
          configuration: {},
        },
        {
          id: "validate",
          agentId: "placeholder-validate",
          position: { x: 600, y: 200 },
          configuration: {},
        },
        {
          id: "store",
          agentId: "placeholder-store",
          position: { x: 850, y: 200 },
          configuration: {},
        },
      ],
      edges: [
        {
          id: "edge-ingest-transform",
          source: "ingest",
          target: "transform",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-transform-validate",
          source: "transform",
          target: "validate",
          sourceHandle: "output",
          targetHandle: "input",
        },
        {
          id: "edge-validate-store",
          source: "validate",
          target: "store",
          sourceHandle: "output",
          targetHandle: "input",
        },
      ],
    },
    metadata: {
      category: "data-processing",
      isSystem: true,
      tags: ["data", "etl", "pipeline"],
    },
  },

  // 5. Echo Demo — the one runnable, publishable seed workflow.
  {
    name: "Echo Demo Workflow",
    description:
      "Runnable demo: two echo steps that each return their input. References a real seeded agent, so it passes publish validation and executes end to end.",
    category: "demo",
    definition: {
      nodes: [
        {
          id: "echo-1",
          agentId: "demo-echo-agent",
          position: { x: 150, y: 200 },
          configuration: {},
        },
        {
          id: "echo-2",
          agentId: "demo-echo-agent",
          position: { x: 450, y: 200 },
          configuration: {},
        },
      ],
      edges: [
        {
          id: "edge-echo-1-2",
          source: "echo-1",
          target: "echo-2",
          sourceHandle: "output",
          targetHandle: "input",
        },
      ],
    },
    metadata: {
      category: "demo",
      isSystem: true,
      tags: ["demo", "echo", "runnable"],
    },
  },
];

/**
 * Idempotency-seam smoke workflow — DIAGNOSTIC FIXTURE, non-prod only.
 */
export const SMOKE_BLUEPRINTS: SeedBlueprint[] = [
  {
    name: "Idempotency Smoke Workflow",
    description:
      "DIAGNOSTIC FIXTURE — dispatches the smoke-idempotency-agent once to exercise the tool-call idempotency seam end to end. Non-prod only. Not a product workflow.",
    category: "smoke",
    definition: {
      nodes: [
        {
          id: "smoke-1",
          agentId: "smoke-idempotency-agent",
          position: { x: 150, y: 200 },
          configuration: {},
        },
      ],
      edges: [],
    },
    metadata: {
      category: "smoke",
      isSystem: true,
      tags: ["smoke", "diagnostic", "idempotency", "non-prod"],
    },
  },
];

/**
 * The deterministic workflowId set for ALL seeded blueprints (production +
 * smoke). Derived from the same `deterministicId(name)` used at seed time,
 * so the reconcile script can import this instead of hard-coding IDs.
 */
export const SEEDED_BLUEPRINT_IDS: ReadonlySet<string> = new Set([
  ...SEED_BLUEPRINTS.map((bp) => deterministicId(bp.name)),
  ...SMOKE_BLUEPRINTS.map((bp) => deterministicId(bp.name)),
]);

// ── Content fingerprint ────────────────────────────────────────────────
/**
 * Compute a deterministic sha256 fingerprint of the seed content (both
 * SEED_BLUEPRINTS and SMOKE_BLUEPRINTS) plus SEED_VERSION. Used as a
 * CloudFormation custom-resource property so any seed change forces a
 * re-invocation — closing the defect where a code-only change (e.g.
 * SEED_VERSION bump with content edits) left the CFN resource unchanged.
 *
 * The fingerprint is computed from a canonical JSON serialization, not the
 * source text, so whitespace/comment changes don't cause spurious re-runs.
 */
export function computeSeedBlueprintFingerprint(): string {
  const payload = JSON.stringify({
    seedVersion: SEED_VERSION,
    blueprints: SEED_BLUEPRINTS,
    smokeBlueprints: SMOKE_BLUEPRINTS,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * eval-external-evaluator-adapter.ts (CIT-107) — org-registered EXTERNAL
 * evaluator, conforming to the Evaluator interface
 * (eval-evaluator-registry.ts), invoked through the existing agent-source
 * integration machinery: a Lambda or HTTP target (LambdaClient
 * InvokeCommand / fetch), secret-backed auth (reuses
 * `AgentInvocationBlock.auth` + `authHeaderScheme`/`bytesToString` from
 * ../../adapters/agent-source/invoke-support.ts — the SAME helpers the
 * agent-source HTTP/Lambda adapters use), region-aware SigV4 support is
 * intentionally NOT reused here (an evaluator invoke is a plain JSON
 * request/response, not a signed AWS API Gateway call — SIGV4 auth mode
 * is therefore treated as NONE for evaluator targets).
 *
 * Every response byte is UNTRUSTED input. `score()` NEVER throws and
 * NEVER returns a raw/unvalidated value: the raw payload text is JSON-
 * parsed defensively, then routed through
 * validateExternalScoreVector (eval-external-evaluator.ts), which applies
 * sanitize-untrusted-json.ts followed by total field-level validation.
 * Any failure at any stage (network error, non-JSON payload, malformed
 * shape, oversized payload) degrades to an EMPTY result — the caller
 * (EvaluatorRegistry.runAll) already isolates a *throwing* evaluator, but
 * this adapter goes further and never throws at all, so a malformed
 * external response can never poison the combined score vector.
 *
 * Declared-dimensions[] allowlist enforcement (external-adapter boundary
 * ONLY — see eval-evaluator-registry.ts's Evaluator.dimensions doc): a
 * per-field-valid entry whose `dimension` is not in this evaluator's own
 * declared `dimensions[]` is dropped and logged here, after
 * validateExternalScoreVector but before the result is returned from
 * score(). A compromised/misconfigured Lambda or HTTP target can return
 * an otherwise well-formed score for ANY dimension name, not just the
 * one(s) it was registered for — without this check, that response could
 * inject operator-unapproved dimensions into the persisted run report.
 * This is deliberately NOT enforced in EvaluatorRegistry.runAll() or
 * validateExternalScoreVector(): both are shape/range-level and have no
 * notion of which evaluator instance owns which declaration, so the
 * allowlist check belongs at the one place that has both the response
 * AND the owning evaluator's declared dimensions in scope.
 *
 * ONLY LAMBDA_INVOKE and HTTP_ENDPOINT are supported — the two protocols
 * the story specifies ("Lambda or HTTP target"). Any other protocol is a
 * configuration error, rejected eagerly at construction time (fail fast,
 * not silently at score() time).
 */
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import type { AgentInvocationBlock } from "../../adapters/agent-source/base";
import {
  authHeaderScheme,
  bytesToString,
} from "../../adapters/agent-source/invoke-support";
import type { CommandSender } from "../../adapters/agent-source/invoke-support";
import type {
  Evaluator,
  EvaluatorDimensionScore,
} from "./eval-evaluator-registry";
import { validateExternalScoreVector } from "./eval-external-evaluator";

const DEFAULT_REGION = process.env.AWS_REGION || "ap-southeast-2";

export type SupportedEvaluatorProtocol = "LAMBDA_INVOKE" | "HTTP_ENDPOINT";

const SUPPORTED_PROTOCOLS = new Set<string>(["LAMBDA_INVOKE", "HTTP_ENDPOINT"]);

export interface CreateExternalEvaluatorOptions {
  /** Registry id — see Evaluator.id doc (namespaced, e.g. `org.<orgId>.<name>`). */
  id: string;
  /** Dimension name(s) this external evaluator is expected to contribute. */
  dimensions: string[];
  /** Target + auth descriptor. Reuses the exact same shape the agent-source
   * adapters use for invoking agents under test, so org-registered
   * evaluators are configured identically to imported agents. */
  invocation: AgentInvocationBlock;
  /** Injectable Lambda sender (tests inject a fake `{send}` double; the
   * production path builds a LambdaClient lazily). Only consulted for
   * protocol LAMBDA_INVOKE. */
  lambdaSender?: CommandSender;
  /** Injectable fetch (tests inject a fake). Only consulted for protocol
   * HTTP_ENDPOINT; defaults to the current global fetch. */
  fetchFn?: typeof fetch;
  /** Invoke-side secret resolver turning `auth.secretRef` into its raw
   * value (Secrets Manager GetSecretValue) — same contract as
   * HttpEndpointAdapterDeps.resolveSecret. Omitted ⇒ no auth header is
   * attached for secret-backed auth modes. */
  resolveSecret?: (secretRef: string) => Promise<string>;
}

/** The wire payload sent to an external evaluator target: the same
 * case/artifact/evalCase inputs the built-in scorer receives, so an
 * external evaluator can implement arbitrary logic over identical
 * signals without any core-code change. */
interface ExternalEvaluatorRequest {
  caseRow: unknown;
  artifact: unknown;
  evalCase: unknown;
}

function safeJsonParse(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Builds an Evaluator whose score() dispatches to an external Lambda or
 * HTTP target. See module doc for the full untrusted-response handling
 * contract.
 */
export function createExternalEvaluator(
  options: CreateExternalEvaluatorOptions,
): Evaluator {
  const { id, dimensions, invocation } = options;

  if (!SUPPORTED_PROTOCOLS.has(invocation.protocol)) {
    throw new Error(
      `createExternalEvaluator: unsupported invocation protocol '${invocation.protocol}' — only LAMBDA_INVOKE and HTTP_ENDPOINT are supported`,
    );
  }

  return {
    id,
    dimensions,
    score: async (caseRow, artifact, evalCase) => {
      const request: ExternalEvaluatorRequest = { caseRow, artifact, evalCase };

      let rawText: string;
      try {
        rawText =
          invocation.protocol === "LAMBDA_INVOKE"
            ? await invokeLambda(invocation, request, options.lambdaSender)
            : await invokeHttp(
                invocation,
                request,
                options.fetchFn,
                options.resolveSecret,
              );
      } catch (err) {
        console.error(
          "eval-external-evaluator-adapter: invocation failed — returning no contribution",
          {
            evaluatorId: id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return [];
      }

      const parsed = safeJsonParse(rawText);
      if (!parsed.ok) {
        console.error(
          "eval-external-evaluator-adapter: response is not valid JSON — rejecting",
          { evaluatorId: id },
        );
        return [];
      }

      const { accepted, rejected } = validateExternalScoreVector(parsed.value);
      if (rejected.length > 0) {
        console.error(
          "eval-external-evaluator-adapter: rejected malformed dimension score(s) from external evaluator",
          { evaluatorId: id, rejected },
        );
      }

      // Enforce the evaluator's declared dimensions[] allowlist against its
      // OWN response. validateExternalScoreVector only checks per-field
      // shape/range — it has no notion of which evaluator produced the
      // entry, so a well-formed score for a dimension this evaluator never
      // declared would otherwise pass through untouched. Enforcing the
      // allowlist here, at the external-adapter boundary (rather than in
      // the registry or the shared validator), keeps the check scoped to
      // exactly the evaluator that owns the declaration.
      const declared = new Set(dimensions);
      const withinDeclaredDimensions: EvaluatorDimensionScore[] = [];
      const droppedUndeclared: unknown[] = [];
      for (const entry of accepted as EvaluatorDimensionScore[]) {
        if (declared.has(entry.dimension)) {
          withinDeclaredDimensions.push(entry);
        } else {
          droppedUndeclared.push(entry);
        }
      }
      if (droppedUndeclared.length > 0) {
        console.error(
          "eval-external-evaluator-adapter: dropped well-formed score(s) for undeclared dimension(s) — evaluator is only permitted to contribute its declared dimensions[]",
          {
            evaluatorId: id,
            declaredDimensions: dimensions,
            dropped: droppedUndeclared,
          },
        );
      }
      return withinDeclaredDimensions;
    },
  };
}

async function invokeLambda(
  invocation: AgentInvocationBlock,
  request: ExternalEvaluatorRequest,
  sender: CommandSender | undefined,
): Promise<string> {
  const region = invocation.region || DEFAULT_REGION;
  const command = new InvokeCommand({
    FunctionName: invocation.target,
    InvocationType: "RequestResponse",
    Payload: new TextEncoder().encode(JSON.stringify(request)),
  });
  const response = sender
    ? await sender.send(command)
    : await new LambdaClient({ region }).send(command);
  return bytesToString((response as { Payload?: unknown }).Payload);
}

async function invokeHttp(
  invocation: AgentInvocationBlock,
  request: ExternalEvaluatorRequest,
  fetchFn: typeof fetch | undefined,
  resolveSecret: ((secretRef: string) => Promise<string>) | undefined,
): Promise<string> {
  const doFetch =
    fetchFn ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));
  const body = JSON.stringify(request);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  const { auth } = invocation;
  if (resolveSecret && auth.secretRef) {
    const scheme = authHeaderScheme(auth.mode, "", auth.header);
    if (scheme) {
      const secretValue = await resolveSecret(auth.secretRef);
      const resolved = authHeaderScheme(auth.mode, secretValue, auth.header);
      if (resolved) {
        headers[resolved.name.toLowerCase()] = resolved.value;
      }
    }
  }

  const response = await doFetch(invocation.target, {
    method: "POST",
    headers,
    body,
  });
  return response.text();
}

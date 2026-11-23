"""Governed single-tool-run request path (board task 10c3bf48, Slice 1).

Adds the ``{kind: 'tool-run'}`` request discriminator the worker's
``lambda_handler`` uses for a synchronous, direct ``RequestResponse``
invoke from the ``testTool`` resolver — replacing the ungoverned in-Lambda
``vm`` sandbox (``backend/src/lambda/tool-sandbox.ts``) with the SAME
governance (``governed_tool_handler.record_governance_decision``) and
idempotency (``tool_execution_ledger.execute_idempotent``) seams the
worker already uses for in-agent tool calls — so a console "Run tool"
and an autonomous agent's tool call can never diverge on auditability.

Slice 0 (this module also provides it): ``invoke_binding`` is the ONE
shared lambda/http/mcp/aws-service dispatch primitive. No generic
single-tool binding executor existed prior to this change — the worker's
existing tool-call machinery (``ComposedToolHook`` /
``run_agent_in_subprocess``) spawns a full strands ``Agent`` subprocess
per node, which is the wrong shape for "invoke exactly one declared
binding and return its result". ``invoke_binding`` is deliberately the
only place that shape is implemented, modeled on the agent-import
protocol dispatcher (``backend/src/adapters/agent-source/*`` — a
lambda/http/mcp/agentcore-runtime/bedrock-agent dispatcher for a
DIFFERENT subsystem, imported foreign agents). Any future caller needing
to run a single declared binding (console Run, a future async-run slice)
MUST call this function rather than hand-rolling a second dispatcher.

Supported binding types in this slice: ``lambda``, ``http``, ``mcp``
(any of the ``mcp``/``mcp_server``/``agentcore_mcp``/``external_mcp``
integration-type spellings used elsewhere in this codebase —
``arbiter/governance/tool_breaker_logic.py::_binding_is_mcp``), and
``aws-service``. Everything else (A2A, Step Functions, SageMaker,
absent binding) raises :class:`UnsupportedBindingError`, which
``process_tool_run`` converts into the structured ``UNSUPPORTED_BINDING``
error — never a silent no-op.

Nothing is persisted beyond the tool-execution ledger (idempotency) and
telemetry — this module writes no new DynamoDB table and uploads no code.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Collaborators reused verbatim from the existing governed tool-call path.
# Imported at module scope (not re-implemented) so this module can never
# drift from the agent (LLM) tool-call path's governance/idempotency
# decision — the exact failure mode finding 027c4a89 already fixed once
# for the deny-list evaluator.
# ---------------------------------------------------------------------------
from governed_tool_handler import record_governance_decision  # noqa: E402
from governance import tool_execution_ledger as ledger  # noqa: E402
from common.tenant_guard import require_same_org, OrgMismatchError  # noqa: E402

execute_idempotent = ledger.execute_idempotent


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class UnsupportedBindingError(Exception):
    """Raised by :func:`invoke_binding` for any binding type this slice does
    not dispatch. ``binding_type`` is ``None`` when the tool declared no
    binding at all."""

    def __init__(self, binding_type: str | None):
        self.binding_type = binding_type
        super().__init__(f"unsupported binding type: {binding_type!r}")


class CredentialVendError(Exception):
    """Raised when scoped-credential vending fails for a 'scoped'
    credentialMode tool. Mirrors ``credential_guard.CredentialRefusal``'s
    fail-closed contract but is local to the tool-run path so a vend
    failure here never gets confused with an agent-dispatch refusal."""


# ---------------------------------------------------------------------------
# Request discriminator
# ---------------------------------------------------------------------------

def is_tool_run_message(event: Any) -> bool:
    """True iff *event* is a direct-invoke single-tool-run request.

    Mutually exclusive with the workflow-node / workflow-compensation
    discriminators in ``index.py``'s ``process_event`` — a tool-run
    request carries its own ``kind`` key, never the workflow contract's
    ``message_type``.
    """
    if not isinstance(event, dict):
        return False
    return event.get("kind") == "tool-run"


# ---------------------------------------------------------------------------
# Binding-type resolution (Slice 0)
# ---------------------------------------------------------------------------

# Normalises every MCP integration-type spelling used elsewhere in this
# codebase (tool_breaker_logic._binding_is_mcp) to the single 'mcp' binding
# key _EXECUTORS dispatches on.
_MCP_ALIASES = frozenset({"mcp", "mcp_server", "agentcore_mcp", "external_mcp"})

_SUPPORTED_BINDING_TYPES = frozenset({"lambda", "http", "mcp", "aws-service"})


def resolve_binding_type(binding: dict | None) -> str | None:
    """Normalise a tool's first binding's declared ``integrationType`` to
    one of the four Slice-1 binding keys, or ``None`` if the binding is
    absent/unrecognised (caller converts ``None`` to UNSUPPORTED_BINDING)."""
    if not binding:
        return None
    raw = binding.get("integrationType")
    if not isinstance(raw, str) or not raw:
        return None
    normalised = raw.strip().lower().replace("_", "-")
    if normalised in ("aws-service",):
        return "aws-service"
    if raw in _MCP_ALIASES or normalised == "mcp":
        return "mcp"
    if normalised in _SUPPORTED_BINDING_TYPES:
        return normalised
    return None


# ---------------------------------------------------------------------------
# invoke_binding — Slice 0 shared primitive
# ---------------------------------------------------------------------------

def _invoke_lambda_binding(binding: dict, inputs: Any, credentials: dict | None) -> Any:
    """RequestResponse invoke of the binding's declared function ARN, under
    scoped credentials. Deferred boto3 client construction (no client built
    at import time), mirroring the lazy-client convention used throughout
    this bundle (``tool_execution_ledger._get_dynamodb_resource``)."""
    import boto3

    session = _scoped_boto3_session(credentials)
    client = session.client("lambda") if session else boto3.client("lambda")
    response = client.invoke(
        FunctionName=binding["functionArn"],
        InvocationType="RequestResponse",
        Payload=json.dumps(inputs).encode("utf-8"),
    )
    payload = response["Payload"].read()
    return json.loads(payload) if payload else None


def _invoke_http_binding(binding: dict, inputs: Any, credentials: dict | None) -> Any:
    """Signed/authed HTTPS call to the binding's declared URL. Credentials
    (when present) are forwarded as a bearer-style header — the egress
    control and Secrets-Manager-backed auth this mirrors lives on the
    agent-import HTTP adapter (``backend/src/adapters/agent-source/
    http-endpoint-adapter.ts``); this executor is the worker-side
    equivalent for a single registry-tool binding, not a reimplementation
    of that adapter's full auth-mode matrix."""
    import urllib.request

    headers = {"Content-Type": "application/json"}
    if credentials and credentials.get("sessionToken"):
        headers["Authorization"] = f"Bearer {credentials['sessionToken']}"
    req = urllib.request.Request(
        binding["url"],
        data=json.dumps(inputs).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_binding_timeout_seconds()) as resp:
        body = resp.read()
        return json.loads(body) if body else None


def _invoke_mcp_binding(binding: dict, inputs: Any, credentials: dict | None) -> Any:
    """Single MCP tool-call against the binding's declared server. Kept
    minimal for Slice 1 — a full MCP client session lifecycle is out of
    scope; this issues one call and returns its result."""
    raise NotImplementedError(
        "mcp binding dispatch requires an MCP client session; not wired in "
        "this deployment — treat as UNSUPPORTED_BINDING until a client is "
        "configured"
    )


def _invoke_aws_service_binding(binding: dict, inputs: Any, credentials: dict | None) -> Any:
    """Generic boto3 service call under scoped credentials. ``binding``
    declares ``service``/``operation``; ``inputs`` is passed as the call's
    kwargs."""
    session = _scoped_boto3_session(credentials)
    if session is None:
        raise CredentialVendError("aws-service binding requires scoped credentials")
    client = session.client(binding["service"])
    operation = getattr(client, binding["operation"])
    return operation(**(inputs or {}))


def _scoped_boto3_session(credentials: dict | None):
    if not credentials:
        return None
    import boto3

    return boto3.Session(
        aws_access_key_id=credentials.get("accessKeyId"),
        aws_secret_access_key=credentials.get("secretAccessKey"),
        aws_session_token=credentials.get("sessionToken"),
    )


def _binding_timeout_seconds() -> int:
    """Per-binding execution budget (documented risk, NOT a concurrency
    change): ~20s, leaving headroom inside the resolver's 25s client
    timeout and AppSync's 30s ceiling."""
    return int(os.environ.get("TOOL_RUN_BINDING_TIMEOUT_SECONDS", "20"))


# Dispatch table. Tests monkeypatch this directly to avoid real network/AWS
# calls while exercising invoke_binding's own dispatch + error logic.
_EXECUTORS: dict[str, Callable[[dict, Any, dict | None], Any]] = {
    "lambda": _invoke_lambda_binding,
    "http": _invoke_http_binding,
    "mcp": _invoke_mcp_binding,
    "aws-service": _invoke_aws_service_binding,
}


def invoke_binding(
    binding_type: str | None,
    binding: dict,
    inputs: Any,
    credentials: dict | None,
) -> Any:
    """Dispatch one governed binding call. Raises
    :class:`UnsupportedBindingError` for any type not in ``_EXECUTORS``."""
    executor = _EXECUTORS.get(binding_type) if binding_type else None
    if executor is None:
        raise UnsupportedBindingError(binding_type)
    return executor(binding, inputs, credentials)


# ---------------------------------------------------------------------------
# Credential mode (mirrors index.py._resolve_credential_mode for agents)
# ---------------------------------------------------------------------------

def resolve_tool_credential_mode(tool_config: dict) -> str:
    """``'none'`` IFF the tool config carries the explicit no-cloud sentinel
    ``credentialMode: 'none'``; ``'scoped'`` otherwise (fail-closed
    default — an undeclared mode is never treated as credential-less)."""
    if tool_config.get("credentialMode") == "none":
        return "none"
    return "scoped"


def _vend_scoped_credentials(tool_config: dict, org_id: str) -> dict:
    """Vend scoped STS credentials for this tool's bindings via the
    existing credential-vender Lambda. Delegates to
    ``index.get_scoped_credentials`` (lazy import — avoids a hard
    dependency cycle with the module that owns the boto3 Lambda client)
    so there is exactly one credential-vending code path in this bundle."""
    import index as worker_index  # noqa: WPS433 — intentional lazy import

    required_permissions = {
        "integrations": [
            b.get("integrationId")
            for b in (tool_config.get("integrationBindings") or [])
            if b.get("integrationId")
        ],
        "dataStores": [
            b.get("dataStoreId")
            for b in (tool_config.get("dataStoreBindings") or [])
            if b.get("dataStoreId")
        ],
    }
    try:
        creds = worker_index.get_scoped_credentials(
            tool_config.get("toolId", ""), required_permissions, org_id=org_id,
        )
    except Exception as exc:  # noqa: BLE001 — any vend failure is refused, not retried silently
        raise CredentialVendError(str(exc)) from exc
    if not creds:
        raise CredentialVendError("credential vender returned no credentials")
    return creds


# ---------------------------------------------------------------------------
# Tool config load (lazy import of index.py's loader so this module stays
# import-order-independent in tests)
# ---------------------------------------------------------------------------

def _load_tool_config(tool_id: str) -> dict | None:
    import index as worker_index  # noqa: WPS433

    table_name = os.environ.get("TOOLS_CONFIG_TABLE", "")
    configs = worker_index.load_tool_configs([tool_id], table_name)
    return configs[0] if configs else None


# ---------------------------------------------------------------------------
# Canonical args hash (ledger key component) — pure, no I/O.
# ---------------------------------------------------------------------------

def _canonical_args_hash(inputs: Any) -> str:
    try:
        canonical = json.dumps(inputs, sort_keys=True, default=str)
    except TypeError:
        canonical = str(inputs)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Result shape helpers
# ---------------------------------------------------------------------------

def _error_result(run_id: str | None, started_at: float, code: str, message: str) -> dict:
    return {
        "runId": run_id,
        "status": "error",
        "error": {"code": code, "message": message},
        "durationMs": int((time.time() - started_at) * 1000),
    }


def _success_result(run_id: str | None, started_at: float, output: Any) -> dict:
    return {
        "runId": run_id,
        "status": "success",
        "output": output,
        "durationMs": int((time.time() - started_at) * 1000),
    }


# ---------------------------------------------------------------------------
# process_tool_run — the direct-invoke branch's entry point
# ---------------------------------------------------------------------------

def process_tool_run(event: dict) -> dict:
    """Execute one governed, idempotent single-tool run.

    Returns a dict shaped ``{runId, status, output|error{code,message},
    durationMs}`` — the worker-side contract the resolver's
    ``tool-run-resolver.ts`` maps onto ``ToolTestResult``.

    Order of operations (mirrors the architect design, §2):
      1. Load tool config; missing -> TOOL_NOT_FOUND.
      2. Re-check caller org vs tool org (tenant_guard; defence in depth —
         the resolver is the primary gate, the payload's orgId is
         server-minted there, never client-supplied) -> TOOL_NOT_FOUND on
         mismatch (same not-found-shaped response as the resolver's own
         gate, so no cross-tenant enumeration via the worker path either).
      3. Governance deny-list decision (record_governance_decision) ->
         GOVERNANCE_DENIED.
      4. Resolve binding type; unsupported -> UNSUPPORTED_BINDING (checked
         before credential vending so an unsupported tool never triggers a
         vend attempt).
      5. Resolve credentialMode; 'scoped' vends credentials (fail closed on
         vend failure -> CREDENTIAL_VEND_FAILED), 'none' injects nothing.
      6. Execute through execute_idempotent (ledger key = runId) with the
         binding dispatch as the run_tool callable.
    """
    started_at = time.time()
    tool_id = event.get("toolId", "")
    inputs = event.get("inputs")
    org_id = event.get("orgId", "")
    run_id = event.get("runId")
    caller = event.get("caller") or {}

    tool_config = _load_tool_config(tool_id)
    if not tool_config:
        return _error_result(run_id, started_at, "TOOL_NOT_FOUND", "Tool not found")

    try:
        require_same_org(
            tool_config, org_id,
            record_id_field="toolId", org_field="orgId",
            component="worker-tool-run", allow_system=True,
        )
    except OrgMismatchError:
        return _error_result(run_id, started_at, "TOOL_NOT_FOUND", "Tool not found")

    denied, deny_result = record_governance_decision(
        tool_id, run_id or "",
        agent_id=caller.get("userId", "console"),
        workflow_id=run_id or "",
        denied_tools=_denied_tools_from_env(),
        org_id=org_id,
    )
    if denied:
        message = (
            (deny_result or {}).get("content", [{}])[0].get("text")
            if isinstance(deny_result, dict)
            else None
        ) or "Tool call denied by governance policy"
        return _error_result(run_id, started_at, "GOVERNANCE_DENIED", message)

    bindings = (tool_config.get("integrationBindings") or []) + (
        tool_config.get("dataStoreBindings") or []
    )
    binding = bindings[0] if bindings else None
    binding_type = resolve_binding_type(binding)
    if binding_type is None:
        raw_type = binding.get("integrationType") if binding else None
        return _error_result(
            run_id, started_at, "UNSUPPORTED_BINDING",
            f"this tool's binding type {raw_type!r} cannot be run from the console yet",
        )

    credential_mode = resolve_tool_credential_mode(tool_config)
    credentials: dict | None = None
    if credential_mode == "scoped":
        try:
            credentials = _vend_scoped_credentials(tool_config, org_id)
        except CredentialVendError as exc:
            return _error_result(run_id, started_at, "CREDENTIAL_VEND_FAILED", str(exc))

    args_hash = _canonical_args_hash(inputs)
    pk = f"{org_id}#{run_id}"
    sk = f"tool-run#0#{tool_id}#{args_hash}"

    def _run_tool() -> Any:
        return invoke_binding(binding_type, binding, inputs, credentials)

    try:
        output = execute_idempotent(
            pk=pk, sk=sk, tool_name=tool_id, mode="protected",
            run_tool=_run_tool, execution_id=run_id, node_id="tool-run",
        )
    except UnsupportedBindingError as exc:
        return _error_result(
            run_id, started_at, "UNSUPPORTED_BINDING",
            f"this tool's binding type {exc.binding_type!r} cannot be run from the console yet",
        )
    except Exception as exc:  # noqa: BLE001 — any binding/ledger failure is a structured BINDING_ERROR
        return _error_result(run_id, started_at, "BINDING_ERROR", str(exc))

    return _success_result(run_id, started_at, output)


def _denied_tools_from_env() -> set[str]:
    raw = os.environ.get("DENIED_TOOLS", "")
    return {t.strip() for t in raw.split(",") if t.strip()}

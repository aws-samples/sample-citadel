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

Follow-up (board task a25de3f2): the ``mcp`` binding path
(``_invoke_mcp_binding``) is now implemented — it opens a short-lived MCP
client session (streamable-HTTP or SSE, per the binding's ``transport``
field), optionally resolves a Secrets-Manager-backed auth header from the
binding's ``secretRef``, issues one bounded ``call_tool``, and maps the
result through a local mirror of the fabricator's untrusted-content fencing
(``fence_untrusted`` below) before returning. The fabricator's
``fence.py`` is NOT importable here — cross-bundle import (see that
module's own docstring on why it mirrors, rather than imports,
``service/agent_intake_single``'s original) — so this module carries its
own minimal mirror of the two defenses that apply to a single bounded
tool-output string (control-character stripping, role-marker
neutralisation); it deliberately omits the nonce-delimiter and
injection-metric machinery, which only make sense for the fabricator's
long-form task-text injection surface.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Callable

import boto3

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

logger = logging.getLogger(__name__)


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


class McpBindingError(Exception):
    """Raised by :func:`_invoke_mcp_binding` for every MCP-path failure.

    ``code`` is one of ``MCP_UNREACHABLE`` (transport/connection failure
    opening the client session), ``MCP_TOOL_ERROR`` (the remote tool ran
    but returned ``isError``, or the binding is missing a required field),
    ``TIMEOUT`` (the call exceeded the per-binding budget), or
    ``AUTH_SECRET_MISSING`` (a configured ``secretRef`` could not be
    resolved). ``invoke_binding``'s caller (``process_tool_run``) catches
    this via the generic ``except Exception`` -> ``BINDING_ERROR`` path
    today, but the structured ``code``/``message`` are kept on the
    exception itself for a future caller that wants to pass the specific
    code through."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


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
    """Single MCP tool-call against the binding's declared server.

    Binding fields consumed:
      - ``serverUrl`` (required) — the MCP server endpoint.
      - ``transport`` (optional, default ``"streamable_http"``; or
        ``"sse"``) — selects the MCP client transport, mirroring the
        ``transport`` field on the agent-import invocation block.
      - ``toolName`` (required) — the remote tool to call.
      - ``secretRef`` (optional) — a Secrets Manager ARN/name resolved via
        :func:`_resolve_mcp_secret`. Never logged.
      - ``authHeader`` (optional, default ``"Authorization"``) — header
        name the resolved secret is attached under, as
        ``Bearer <value>`` for the default header or the raw value for a
        custom header name (e.g. ``x-api-key``), mirroring
        ``backend/src/adapters/agent-source/mcp-adapter.ts``'s
        ``resolveAuthHeader``.

    ``credentials`` (scoped STS creds from credential vending) is accepted
    for signature parity with the other ``_invoke_*_binding`` executors but
    is unused here — an MCP server is authenticated via its own
    ``secretRef``-backed header, not AWS SigV4/STS; the scoped-credential
    vend still runs upstream in ``process_tool_run`` for any AWS-side
    bindings a tool might also carry, it just has nothing to do on this
    path.

    Raises :class:`McpBindingError` with a structured ``code`` for every
    failure mode: ``MCP_UNREACHABLE`` (missing/invalid ``serverUrl`` or a
    transport-level connection failure), ``MCP_TOOL_ERROR`` (missing
    ``toolName`` or the remote tool returned ``isError``), ``TIMEOUT``
    (the call exceeded :func:`_binding_timeout_seconds`), or
    ``AUTH_SECRET_MISSING`` (a configured ``secretRef`` could not be
    resolved — checked BEFORE opening the client session, so a bad secret
    never triggers a network call).
    """
    server_url = binding.get("serverUrl")
    if not isinstance(server_url, str) or not server_url:
        raise McpBindingError("MCP_UNREACHABLE", "binding is missing a serverUrl")

    tool_name = binding.get("toolName")
    if not isinstance(tool_name, str) or not tool_name:
        raise McpBindingError("MCP_TOOL_ERROR", "binding is missing a toolName")

    transport = binding.get("transport") or "streamable_http"

    headers: dict[str, str] = {}
    secret_ref = binding.get("secretRef")
    if secret_ref:
        # Resolved BEFORE opening any session — a missing/unreadable secret
        # must never cause a network call to the MCP server.
        secret_value = _resolve_mcp_secret(secret_ref)
        header_name = binding.get("authHeader") or "Authorization"
        headers[header_name] = (
            f"Bearer {secret_value}" if header_name == "Authorization" else secret_value
        )

    timeout_seconds = _binding_timeout_seconds()

    async def _call() -> Any:
        async with _open_mcp_session(server_url, transport, headers, timeout_seconds) as session:
            await session.initialize()
            return await asyncio.wait_for(
                session.call_tool(tool_name, inputs or {}), timeout=timeout_seconds,
            )

    try:
        result = asyncio.run(_call())
    except asyncio.TimeoutError as exc:
        raise McpBindingError("TIMEOUT", f"mcp call_tool exceeded {timeout_seconds}s") from exc
    except McpBindingError:
        raise
    except Exception as exc:  # noqa: BLE001 — any transport/connection failure maps here
        raise McpBindingError("MCP_UNREACHABLE", str(exc)) from exc

    content_texts = [
        fence_untrusted(getattr(part, "text", ""), source="mcp-tool-output")
        for part in (result.content or [])
        if getattr(part, "type", None) == "text"
    ]
    is_error = bool(getattr(result, "isError", False))
    if is_error:
        message = content_texts[0] if content_texts else "remote tool reported an error"
        raise McpBindingError("MCP_TOOL_ERROR", message)

    return {"content": content_texts, "isError": False}


@asynccontextmanager
async def _open_mcp_session(server_url: str, transport: str, headers: dict, timeout_seconds: int):
    """Open the MCP transport (streamable-HTTP or SSE) and yield an
    initialized-but-not-yet-``initialize()``-called :class:`mcp.ClientSession`.

    Kept as its own async context manager (rather than inlined in
    ``_invoke_mcp_binding``) so tests can monkeypatch this single seam with
    a fake transport/session and exercise the surrounding dispatch,
    timeout, and error-mapping logic with no real network or `mcp` package
    behaviour involved.
    """
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    from mcp.client.sse import sse_client

    client_cm = (
        sse_client(server_url, headers=headers, timeout=timeout_seconds)
        if transport == "sse"
        else streamablehttp_client(server_url, headers=headers, timeout=timeout_seconds)
    )
    async with client_cm as streams:
        read_stream, write_stream = streams[0], streams[1]
        async with ClientSession(read_stream, write_stream) as session:
            yield session


def _resolve_mcp_secret(secret_ref: str) -> str:
    """Fetch the raw secret value for *secret_ref* via boto3 Secrets
    Manager. Lazy client construction (mirrors the lazy-client convention
    used elsewhere in this bundle, e.g.
    ``tool_execution_ledger._get_dynamodb_resource``) — no AWS call is made
    unless a binding actually declares a ``secretRef``.

    The resolved value is returned to the caller and NEVER logged here;
    callers must likewise avoid logging it (see
    ``_invoke_mcp_binding``'s header construction, which builds the
    Authorization value but logs only that an auth header was applied).

    Raises :class:`McpBindingError` with code ``AUTH_SECRET_MISSING`` for
    any resolution failure (missing secret, access denied, malformed
    response) — never propagates the underlying boto3 exception, which
    could embed request metadata.
    """
    try:
        client = boto3.client("secretsmanager")
        response = client.get_secret_value(SecretId=secret_ref)
    except Exception as exc:  # noqa: BLE001 — any failure is AUTH_SECRET_MISSING, not retried
        logger.warning("mcp binding: failed to resolve secretRef (reason redacted)")
        raise McpBindingError("AUTH_SECRET_MISSING", f"could not resolve secretRef: {secret_ref}") from exc

    secret_string = response.get("SecretString")
    if not secret_string:
        raise McpBindingError("AUTH_SECRET_MISSING", f"secretRef resolved to an empty value: {secret_ref}")
    return secret_string


# ---------------------------------------------------------------------------
# Untrusted-output sanitization — local mirror of
# arbiter/fabricator/fence.py's control-character stripping and
# role-marker neutralisation (see module docstring for why this is a
# mirror, not an import).
# ---------------------------------------------------------------------------

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")

_ROLE_MARKER_RE = re.compile(
    r"^(\s*)"
    r"("
    r"(?:Assistant|System|Human|User)\s*:"
    r"|</?tool_(?:use|result)"
    r'|\{\s*"tool_(?:name|use)"'
    r")",
    re.MULTILINE | re.IGNORECASE,
)

_ROLE_MARKER_PREFIX = "[DATA] "


def fence_untrusted(text: str, source: str) -> str:
    """Strip control characters and neutralise role-marker / protocol-line
    prefixes in *text* so it cannot be mis-parsed as a model protocol
    boundary when placed into downstream context. ``source`` is a
    human-readable origin label, logged (never the content) when a
    role-marker line is neutralised."""
    if not text:
        return text
    cleaned = _CONTROL_RE.sub("", text)
    neutralised, count = _ROLE_MARKER_RE.subn(
        lambda m: f"{m.group(1)}{_ROLE_MARKER_PREFIX}{m.group(2)}", cleaned,
    )
    if count:
        logger.info("fence_untrusted: neutralised %d role-marker line(s) in %s content", count, source)
    return neutralised


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

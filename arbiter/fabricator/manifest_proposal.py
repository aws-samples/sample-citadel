"""Tier-3 agent-import — LLM-proposed agent capability descriptor (ARBITER-A).

``propose_agent_manifest(signals)`` asks the EXISTING Bedrock/Strands model to
PROPOSE an agent capability descriptor from non-secret import signals. It:

  1. Redacts secret-looking values from ``signals`` BEFORE they reach the
     prompt (defence-in-depth — a secret can never be echoed into the prompt,
     the emitted event, or the logs).
  2. Calls the model (injected/patchable for tests via ``invoke`` or the
     module-level ``_invoke_model``) with NO tools — this path proposes a
     descriptor and MUST NEVER generate or execute code.
  3. Extracts a strict JSON object from the model output (stripping markdown
     ```json fences / leading prose), with a single repair attempt for common
     LLM JSON defects (trailing commas). Unparseable output -> the typed
     ``ManifestProposalError`` (the caller turns this into the FAILED event,
     never a malformed PROPOSED event).
  4. Validates the result is a dict carrying the required descriptor keys.
  5. FORCES every ``fieldConfidence`` value to ``'low'`` (Tier-3 is low-trust)
     regardless of what the model returned, and guarantees a top-level
     all-low ``fieldConfidence`` map exists.

This module deliberately does NOT import EventBridge / boto3 — event emission
is the caller's (index.py) responsibility. The only AWS/model touch point is
``_invoke_model``, which is patched out in every test.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Minimal required keys for a usable capability descriptor. Kept intentionally
# small (identity only) so a slightly sparse-but-valid proposal is accepted;
# the human review step (B2) is the gate that promotes it to a trusted manifest.
REQUIRED_KEYS = ("name", "description")


class ManifestProposalError(Exception):
    """Raised when the model output cannot be parsed into / validated as a
    capability descriptor. The Fabricator branch converts this into an
    ``agent.import.manifest.failed`` event — it never emits a malformed
    ``proposed`` event."""


# ---------------------------------------------------------------------------
# Secret redaction (applied to signals BEFORE the prompt, and to error text).
# ---------------------------------------------------------------------------
# Key-name substrings that mark a value as secret regardless of its content.
_SECRET_KEY_SUBSTRINGS = (
    "secret",
    "password",
    "passwd",
    "token",
    "apikey",
    "api_key",
    "credential",
    "private",
    "accesskey",
    "access_key",
    "clientsecret",
    "authorization",
    "sessiontoken",
)

# Value patterns that look like a credential even when the key is innocuous.
_SECRET_VALUE_PATTERNS = (
    re.compile(r"AKIA[0-9A-Z]{16}"),                       # AWS access key id
    re.compile(r"ASIA[0-9A-Z]{16}"),                       # AWS STS access key id
    re.compile(r"ghp_[A-Za-z0-9]{30,}"),                   # GitHub PAT
    re.compile(r"gh[opsu]_[A-Za-z0-9]{30,}"),              # other GitHub tokens
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),           # Slack token
    re.compile(r"-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----"),  # PEM private key
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),  # JWT
)

_REDACTED = "[REDACTED]"


def sanitize_text(text: Any) -> str:
    """Redact secret-looking substrings from free text (used for log lines and
    the short error message that ships in the FAILED event)."""
    if not isinstance(text, str):
        text = str(text)
    for pattern in _SECRET_VALUE_PATTERNS:
        text = pattern.sub(_REDACTED, text)
    return text


def _is_secret_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    lowered = key.lower()
    return any(sub in lowered for sub in _SECRET_KEY_SUBSTRINGS)


def redact_signals(value: Any) -> Any:
    """Recursively redact secret values from ``signals``.

    - A dict entry whose KEY looks secret has its value replaced wholesale.
    - A string VALUE matching a credential pattern is replaced (even when the
      key is innocuous), with any embedded match scrubbed.
    - Other containers are walked; scalars pass through unchanged.
    """
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        for k, v in value.items():
            if _is_secret_key(k):
                out[k] = _REDACTED
            else:
                out[k] = redact_signals(v)
        return out
    if isinstance(value, list):
        return [redact_signals(item) for item in value]
    if isinstance(value, str):
        return sanitize_text(value)
    return value


# ---------------------------------------------------------------------------
# fieldConfidence forcing (Tier-3: everything is low-trust).
# ---------------------------------------------------------------------------
def _coerce_all_low(value: Any) -> Any:
    """Replace every leaf under a ``fieldConfidence`` node with ``'low'`` while
    preserving the surrounding dict keys / list shape."""
    if isinstance(value, dict):
        return {k: _coerce_all_low(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_coerce_all_low(item) for item in value]
    return "low"


def force_field_confidence_low(obj: Any) -> Any:
    """Return a copy of ``obj`` where every value living under any
    ``fieldConfidence`` key (at any depth) is coerced to ``'low'``."""
    if isinstance(obj, dict):
        result: dict[Any, Any] = {}
        for k, v in obj.items():
            if k == "fieldConfidence":
                result[k] = _coerce_all_low(v)
            else:
                result[k] = force_field_confidence_low(v)
        return result
    if isinstance(obj, list):
        return [force_field_confidence_low(item) for item in obj]
    return obj


def _ensure_low_field_confidence(descriptor: dict) -> dict:
    """Guarantee the descriptor carries a top-level all-``'low'``
    ``fieldConfidence`` map covering each top-level field (Tier-3 low-trust),
    even when the model omitted it."""
    keys = [k for k in descriptor.keys() if k != "fieldConfidence"]
    low_map = {k: "low" for k in keys}
    existing = descriptor.get("fieldConfidence")
    if isinstance(existing, dict):
        for k in existing.keys():
            low_map[k] = "low"
    descriptor["fieldConfidence"] = low_map
    return descriptor


# ---------------------------------------------------------------------------
# JSON extraction + one repair attempt.
# ---------------------------------------------------------------------------
def _extract_json_block(raw: str) -> str:
    """Best-effort extraction of a JSON object from model output: strip
    markdown fences / surrounding prose by slicing from the first '{' to the
    last '}'. Returns the stripped raw string when no braces are present (so
    ``json.loads`` fails cleanly and the repair path runs)."""
    text = raw.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


def _repair_json(candidate: str) -> str:
    """Single repair pass for the most common LLM JSON defect: trailing commas
    before a closing brace / bracket."""
    return re.sub(r",(\s*[}\]])", r"\1", candidate)


def _parse_llm_json(raw: str) -> Any:
    """Parse model output into a Python object, with one repair attempt.

    Raises:
        ManifestProposalError: if the output is not parseable as JSON even
            after the repair attempt.
    """
    candidate = _extract_json_block(raw)
    try:
        return json.loads(candidate)
    except (json.JSONDecodeError, ValueError, TypeError):
        repaired = _repair_json(candidate)
        try:
            return json.loads(repaired)
        except (json.JSONDecodeError, ValueError, TypeError) as exc:
            # Do NOT echo the raw model output (could contain anything) — keep
            # the error generic.
            raise ManifestProposalError(
                "model output was not parseable as a JSON object"
            ) from exc


# ---------------------------------------------------------------------------
# Model invocation (patched out in tests).
# ---------------------------------------------------------------------------
_MANIFEST_PROPOSER_SYSTEM_PROMPT = """
You are an agent-capability descriptor proposer. Given non-secret signals about
an external agent or tool, you PROPOSE a capability descriptor.

You DO NOT write, generate, or execute any code. You DO NOT call any tools.

Return ONLY a single JSON object (no prose, no markdown fences) with this shape:
{
  "name": "<short_snake_or_kebab_case_identifier>",
  "description": "<one-sentence human-readable description>",
  "operations": [{"name": "<operation>", "description": "<what it does>"}],
  "inputSchema": {"type": "object", "properties": {}},
  "fieldConfidence": {"name": "low", "description": "low"}
}

Rules:
- Your entire output MUST be valid JSON and nothing else.
- NEVER include secrets, credentials, tokens, passwords, or keys in any field.
- Base the proposal ONLY on the provided signals; if unsure, keep fields generic.
""".strip()


def _build_prompt(redacted_signals: Any) -> str:
    return (
        "Propose an agent capability descriptor from the following non-secret "
        "import signals (any secrets have already been redacted).\n\n"
        "Signals:\n"
        f"{json.dumps(redacted_signals, indent=2, default=str, sort_keys=True)}\n\n"
        "Return ONLY the JSON object described in your instructions."
    )


def _invoke_model(prompt: str) -> str:
    """Call the EXISTING Bedrock/Strands model and return its raw text output.

    Reuses the Fabricator's model id + retry config (lazy import keeps this
    module free of an import-time dependency on ``index`` and avoids a circular
    import). The agent is created with NO tools so this path can never generate
    or execute code. Patched out in every test — no live model is ever called
    in the suite.
    """
    from strands import Agent, models  # lazy: keep import cost off module load
    from index import FABRICATOR_MODEL_ID, BEDROCK_RETRY_CONFIG  # reuse existing model

    bedrock_model = models.BedrockModel(
        model_id=FABRICATOR_MODEL_ID,
        max_tokens=8192,
        region_name="us-west-2",
        boto_client_config=BEDROCK_RETRY_CONFIG,
        # Headless (no per-token consumer): streaming=False makes transient
        # model faults surface pre-response, inside BEDROCK_RETRY_CONFIG's
        # adaptive retry scope — mid-stream stream faults are retried by no
        # layer. Mirrors the fabricator model construction in index.py.
        streaming=False,
    )
    agent = Agent(bedrock_model, system_prompt=_MANIFEST_PROPOSER_SYSTEM_PROMPT)
    result = agent(prompt)
    return str(result)


# ---------------------------------------------------------------------------
# Public entry point.
# ---------------------------------------------------------------------------
def propose_agent_manifest(
    signals: dict,
    *,
    invoke: Callable[[str], str] | None = None,
) -> dict:
    """Propose an agent capability descriptor from non-secret ``signals``.

    Args:
        signals: Import signals (non-secret). Secret-looking values are
            redacted before the prompt is built.
        invoke: Optional model-call override ``(prompt) -> raw_text`` for
            tests. Defaults to the module-level ``_invoke_model``.

    Returns:
        A descriptor dict with every ``fieldConfidence`` value forced to
        ``'low'`` and the required identity keys present.

    Raises:
        ManifestProposalError: model output unparseable as JSON, not a JSON
            object, or missing the required descriptor keys.
    """
    if not isinstance(signals, dict):
        signals = {}

    redacted = redact_signals(signals)
    logger.info(
        "manifest-proposal: proposing descriptor from %d signal(s)", len(signals)
    )

    invoker = invoke or _invoke_model
    raw = invoker(_build_prompt(redacted))
    if not isinstance(raw, str):
        raw = str(raw)

    parsed = _parse_llm_json(raw)  # raises ManifestProposalError on bad JSON
    if not isinstance(parsed, dict):
        raise ManifestProposalError("proposed descriptor is not a JSON object")

    missing = [k for k in REQUIRED_KEYS if k not in parsed]
    if missing:
        raise ManifestProposalError(
            f"proposed descriptor missing required key(s): {sorted(missing)}"
        )

    forced = force_field_confidence_low(parsed)
    forced = _ensure_low_field_confidence(forced)
    return forced

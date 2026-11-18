"""Fail-closed agent credentialing — ambient-AWS-env scrub + structured
refusal (owner decision 5750aeec: FAIL CLOSED, no grandfathering).

Bundle-sibling module (entry: arbiter/workerWrapper) — top-level importable,
no ``arbiter.`` prefix, so it ships correctly in the deployed Lambda bundle
(see ``__tests__/test_deployed_bundle_importability.py``).

Supersedes the ambient-inherit fallback documented in
``docs/AGENT_PERMISSIONS.md`` §5 and implemented as the deliberate
``else: pass`` branch in ``run_agent_in_subprocess`` (finding 9ef192d1): an
agent subprocess must NEVER be able to read the worker Lambda's broad
execution-role credentials. Every dispatch now either vends a scoped role
or refuses before a subprocess is ever spawned. The sole exception is the
explicit ``credentialMode: "none"`` sentinel (§1e of the design) for
genuinely credential-less (pure-compute) agents, which still scrubs the
ambient env and injects nothing.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# Refusal reasons + exception
# ---------------------------------------------------------------------------

NO_REQUIRED_PERMISSIONS = "NO_REQUIRED_PERMISSIONS"
VEND_FAILED = "VEND_FAILED"
VEND_REFUSED = "VEND_REFUSED"
NO_ORG = "NO_ORG"


class CredentialRefusal(Exception):
    """Non-retryable: dispatch refused to run an agent without a vetted
    credential source.

    ``error_class`` mirrors the convention used elsewhere in this bundle
    (e.g. ``AgentExecutionError.error_class``) so the workflow-node except
    handler's existing ``getattr(exc, 'error_class', None) or
    type(exc).__name__`` line feeds this exact string into
    ``stepRunner/retry.py``'s ``should_retry`` classification. This class is
    deliberately NOT a member of any ``retryableErrors`` list shipped by the
    repo's node definitions — a credential refusal never self-heals on
    retry.
    """

    error_class = "CredentialRefusal"

    def __init__(self, reason: str, agent_id: str | None = None):
        self.reason = reason
        self.agent_id = agent_id
        self.message = (
            f"agent '{agent_id}' refused: {reason}" if agent_id else reason
        )
        super().__init__(self.message)


# ---------------------------------------------------------------------------
# Ambient AWS credential scrub
# ---------------------------------------------------------------------------

# Every environment variable through which boto3's default credential
# provider chain (botocore.credentials.create_credential_resolver) can
# obtain ambient AWS credentials. Deliberately NOT included: AWS_REGION /
# AWS_DEFAULT_REGION — those configure the SDK, they do not authenticate it.
AMBIENT_AWS_KEYS = frozenset({
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
})


def scrub_ambient_aws_env(env: dict) -> dict:
    """Return a COPY of *env* with every :data:`AMBIENT_AWS_KEYS` entry
    removed. ``AWS_REGION`` / ``AWS_DEFAULT_REGION`` are preserved — they
    are not credential material."""
    return {k: v for k, v in env.items() if k not in AMBIENT_AWS_KEYS}


def build_agent_credential_env(
    base_env: dict,
    scoped_credentials: dict | None,
    *,
    credential_mode: str,
    agent_id: str | None = None,
) -> dict:
    """Build the agent subprocess environment: scrub ambient AWS credentials
    from *base_env*, then inject per *credential_mode*.

    ``credential_mode='scoped'`` requires a non-empty *scoped_credentials*
    dict (with ``accessKeyId`` / ``secretAccessKey`` / ``sessionToken``) and
    injects exactly those three keys. ``credential_mode='none'`` injects
    nothing — the explicit no-cloud sentinel for pure-compute agents; the
    result carries NO AWS credential material at all. Any other value, or
    ``mode='scoped'`` with empty/missing credentials, raises
    :class:`CredentialRefusal` — this function never silently falls back to
    leaving an ambient key in place.
    """
    env = scrub_ambient_aws_env(base_env)

    if credential_mode == "none":
        return env

    if credential_mode == "scoped":
        if not scoped_credentials:
            raise CredentialRefusal(VEND_FAILED, agent_id)
        env["AWS_ACCESS_KEY_ID"] = scoped_credentials["accessKeyId"]
        env["AWS_SECRET_ACCESS_KEY"] = scoped_credentials["secretAccessKey"]
        env["AWS_SESSION_TOKEN"] = scoped_credentials["sessionToken"]
        return env

    raise CredentialRefusal(f"UNKNOWN_CREDENTIAL_MODE:{credential_mode!r}", agent_id)

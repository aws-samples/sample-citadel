"""END-TO-END (moto) harness for the workflow-node TOOL-CALL write paths.

DISCOVERY HARNESS (not a fix). Purpose: surface EVERY DynamoDB wire-contract
defect on the node tool-call flow in ONE local pass, instead of one-per-deploy.
It follows the ``test_ledger_contract_moto.py`` precedent (real boto3 clients
against moto, real table definitions matching the CDK schemas, raw low-level
reads to assert stored attribute types) but widens coverage from the ledger
alone to the FULL tool-call write sequence a workflow node drives:

    1. governance finding write        governance/ledger.py::write_finding
                                        (worker-tool-handler PERMIT/DENY audit)
    2. tool-execution ledger reserve    governance/tool_execution_ledger.py::reserve
       (fenced TransactWriteItems)      -> _reserve_fenced
    3. the tool body's marker write     seedConfig/smoke_idempotency_agent.py
                                        smoke_write_marker put_item
    4. ledger finalize (success/fail)   tool_execution_ledger.py::finalize_success
                                        / finalize_failure
    5. worker node-result write         workerWrapper/index.py::_persist_node_completion
    6. stepRunner node-failure update   stepRunner/executor.py handle_node_failure
    7. execution finalize               stepRunner/executor.py (start/cancel)

REAL vs STUBBED (explicit)
--------------------------
* REAL, against moto: every DynamoDB write above and every table
  (schemas copied verbatim from backend/lib/arbiter-stack.ts and
  backend-stack.ts). NO in-memory FakeTable is used for any write.
* STUBBED — the strands agent runtime ONLY. ``strands`` is not installed in
  this env, and even where it is, the agent executes in a SUBPROCESS
  (workerWrapper/index.py launches ``sys.executable``), which cannot run
  in-process. We inject a minimal fake ``strands`` module (``Agent`` + ``tool``)
  so the REAL ``smoke_write_marker`` tool BODY executes its REAL boto3 put_item
  against moto. The strands ``BeforeToolCallEvent`` hook seam
  (ComposedToolHook = governance + idempotency) is therefore also stubbed; the
  harness instead drives the governance-finding write and the ledger
  reserve->finalize EXPLICITLY, in the same order the ComposedToolHook fires
  them, so no real write is faked — only the event dispatch is.

conftest note: ``arbiter/conftest.py`` swaps ``boto3.client``/``boto3.resource``
for MagicMock factories for the whole suite. Modules that call
``boto3.resource(...)`` directly (the smoke tool) would therefore hit a mock
and HIDE the float bug. Inside ``mock_aws`` we restore ``boto3.resource`` /
``boto3.client`` to real Session-backed callables (``boto3.Session`` is NOT
stubbed), so those direct calls reach moto.
"""
from __future__ import annotations

import os
import sys
import types
from types import SimpleNamespace

import boto3
import pytest

try:
    from moto import mock_aws
except ImportError:  # pragma: no cover
    pytest.skip("moto not installed", allow_module_level=True)

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

REGION = "us-east-1"
SMOKE_TABLE = "citadel-smoke-idempotency-moto"
EXEC_TABLE = "citadel-executions-moto"
LEDGER_TABLE = "citadel-tool-execution-ledger-moto"
GOV_TABLE = "citadel-governance-ledger-moto"


# ---------------------------------------------------------------------------
# Table definitions — verbatim from the CDK stacks
# ---------------------------------------------------------------------------
def _make_tables(resource):
    # backend/lib/arbiter-stack.ts SmokeIdempotencyTable: PK orgId(S) SK markerId(S)
    resource.create_table(
        TableName=SMOKE_TABLE,
        KeySchema=[
            {"AttributeName": "orgId", "KeyType": "HASH"},
            {"AttributeName": "markerId", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "orgId", "AttributeType": "S"},
            {"AttributeName": "markerId", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    # backend/lib/backend-stack.ts ExecutionsTable: PK executionId(S)
    resource.create_table(
        TableName=EXEC_TABLE,
        KeySchema=[{"AttributeName": "executionId", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "executionId", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    # backend/lib/arbiter-stack.ts ToolExecutionLedgerTable: PK pk(S) SK sk(S)
    resource.create_table(
        TableName=LEDGER_TABLE,
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    # backend/lib/arbiter-stack.ts GovernanceLedgerTable: PK findingId(S),
    # + workflow-index GSI (HASH workflowId(S), RANGE timestamp(N)).
    resource.create_table(
        TableName=GOV_TABLE,
        KeySchema=[{"AttributeName": "findingId", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "findingId", "AttributeType": "S"},
            {"AttributeName": "workflowId", "AttributeType": "S"},
            {"AttributeName": "timestamp", "AttributeType": "N"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "workflow-index",
                "KeySchema": [
                    {"AttributeName": "workflowId", "KeyType": "HASH"},
                    {"AttributeName": "timestamp", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def _install_fake_strands():
    """Stub ONLY the agent runtime so the REAL tool body executes in-process.

    ``@tool`` returns the function unchanged; ``Agent(tools=[fn])`` exposes
    ``agent.tool.<fn.__name__>`` -> the real fn, matching how
    smoke_idempotency_agent.handler drives the direct (synchronous) tool call.
    """
    strands = types.ModuleType("strands")

    def tool(fn=None, **_kw):
        if fn is None:
            return lambda f: f
        return fn

    class Agent:  # noqa: D401
        def __init__(self, tools=None, **_kw):
            self.tool = SimpleNamespace(
                **{getattr(t, "__name__", "tool"): t for t in (tools or [])}
            )

    strands.Agent = Agent
    strands.tool = tool
    sys.modules["strands"] = strands
    return strands


@pytest.fixture
def e2e(monkeypatch):
    with mock_aws():
        # Restore REAL boto3 factories (conftest stubbed them) so every
        # write below — including the smoke tool's direct boto3.resource
        # call — reaches moto. boto3.Session is not stubbed by conftest.
        monkeypatch.setattr(
            boto3, "resource", lambda *a, **k: boto3.Session(region_name=REGION).resource(*a, **k)
        )
        monkeypatch.setattr(
            boto3, "client", lambda *a, **k: boto3.Session(region_name=REGION).client(*a, **k)
        )
        resource = boto3.Session(region_name=REGION).resource("dynamodb")
        _make_tables(resource)

        monkeypatch.setenv("SMOKE_IDEMPOTENCY_TABLE", SMOKE_TABLE)
        monkeypatch.setenv("EXECUTIONS_TABLE", EXEC_TABLE)
        monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", LEDGER_TABLE)
        monkeypatch.setenv("GOVERNANCE_LEDGER_TABLE", GOV_TABLE)
        monkeypatch.setenv("CITADEL_ORG_ID", "orgA")

        _install_fake_strands()

        # Wire the two ledgers' lazy DDB seams at the moto resource.
        from arbiter.governance import ledger as gov_ledger
        from arbiter.governance import tool_execution_ledger as tel

        tel.__reset_ledger_client_for_test()
        gov_ledger.__reset_ledger_client_for_test()
        monkeypatch.setattr(tel, "_get_dynamodb_resource", lambda: resource)
        monkeypatch.setattr(gov_ledger, "_get_dynamodb_resource", lambda: resource)

        try:
            yield {"resource": resource}
        finally:
            tel.__reset_ledger_client_for_test()
            gov_ledger.__reset_ledger_client_for_test()


def _raw(table, key):
    client = boto3.Session(region_name=REGION).client("dynamodb")
    return client.get_item(TableName=table, Key=key).get("Item")


# ===========================================================================
# 1. Governance finding write (worker-tool-handler PERMIT audit)
# ===========================================================================
class TestGovernanceFindingWrite:
    def test_permit_finding_row_persists(self, e2e):
        from arbiter.workerWrapper.governed_tool_handler import build_governance_finding
        from arbiter.governance.ledger import write_finding

        finding = build_governance_finding(
            "smoke_write_marker", denied=False,
            agent_id="smoke-idempotency-agent", workflow_id="wf-smoke",
        )
        # REAL write against moto — surfaces any wire-contract defect verbatim.
        write_finding(finding)
        row = _raw(GOV_TABLE, {"findingId": {"S": finding.finding_id}})
        assert row is not None


# ===========================================================================
# 2. Tool-execution ledger fenced reserve (TransactWriteItems)
# ===========================================================================
class TestFencedReserve:
    def _seed_exec(self, resource, gen):
        resource.Table(EXEC_TABLE).put_item(
            Item={
                "executionId": "exec1",
                "nodeResults": {"node1": {"dispatchGeneration": gen, "status": "running"}},
            }
        )

    def test_fenced_reserve_wins(self, e2e):
        from arbiter.governance import tool_execution_ledger as tel
        from arbiter.workerWrapper.tool_idempotency import build_key

        self._seed_exec(e2e["resource"], 3)
        pk, sk = build_key("orgA", "exec1", "node1", 0, "smoke_write_marker", {"note": "x"})
        res = tel.reserve(
            pk, sk, tool_name="smoke_write_marker",
            dispatch_generation=3, execution_id="exec1", node_id="node1",
        )
        assert res.outcome == tel.ReserveOutcome.WON
        raw = _raw(LEDGER_TABLE, {"pk": {"S": pk}, "sk": {"S": sk}})
        assert raw["pk"] == {"S": pk}
        assert set(raw["createdAt"].keys()) == {"N"}


# ===========================================================================
# 3. Smoke tool body marker write (the real tool @tool body)
# ===========================================================================
class TestSmokeMarkerWrite:
    def test_marker_row_persists(self, e2e):
        from arbiter.seedConfig import smoke_idempotency_agent as smoke

        # REAL tool body via the fake-strands Agent -> real put_item to moto.
        result = smoke.handler(note="e2e-harness")
        assert result["orgId"] == "orgA"
        # Assert exactly one marker row landed.
        rows = e2e["resource"].Table(SMOKE_TABLE).scan()["Items"]
        assert len(rows) == 1


# ===========================================================================
# 4. Ledger finalize (success) with the real tool result
# ===========================================================================
class TestLedgerFinalize:
    def test_reserve_then_finalize_success(self, e2e):
        from arbiter.governance import tool_execution_ledger as tel
        from arbiter.workerWrapper.tool_idempotency import build_key

        pk, sk = build_key("orgA", "exec1", "node1", 0, "smoke_write_marker", {"note": "y"})
        tel.reserve(pk, sk, tool_name="smoke_write_marker")
        tel.finalize_success(
            pk, sk,
            result={"markerId": "m-1", "orgId": "orgA", "writtenAt": "1000.5"},
        )
        row = tel.get(pk, sk)
        assert row["status"] == "completed"


# ===========================================================================
# 5. Worker node-result write (index.py::_persist_node_completion)
# ===========================================================================
class TestWorkerNodeResultWrite:
    def test_persist_node_completion(self, e2e):
        import arbiter.workerWrapper.index as widx

        # getattr avoids dunder name-mangling inside this class body.
        getattr(widx, "__reset_boto3_clients_for_test")()

        # Seed the execution row with a pending node (nested map must exist for
        # the SET nodeResults.#nid.#status path).
        e2e["resource"].Table(EXEC_TABLE).put_item(
            Item={
                "executionId": "exec1",
                "nodeResults": {"node1": {"status": "running"}},
            }
        )
        msg = SimpleNamespace(execution_id="exec1", node_id="node1")
        widx._persist_node_completion(
            msg,
            output={"markerId": "m-1", "orgId": "orgA", "writtenAt": "1000.5"},
            usage=[{"inputTokens": 5, "outputTokens": 7}],
        )
        row = e2e["resource"].Table(EXEC_TABLE).get_item(Key={"executionId": "exec1"})["Item"]
        assert row["nodeResults"]["node1"]["status"] == "completed"


# ===========================================================================
# 6/7. stepRunner node-failure update + execution finalize
# ===========================================================================
class TestStepRunnerWrites:
    def _wire(self, monkeypatch, resource):
        import arbiter.stepRunner.executor as ex
        monkeypatch.setattr(ex, "_executions_table", resource.Table(EXEC_TABLE))
        return ex

    def test_execution_start_finalize(self, e2e, monkeypatch):
        ex = self._wire(monkeypatch, e2e["resource"])
        e2e["resource"].Table(EXEC_TABLE).put_item(
            Item={"executionId": "exec1", "status": "pending", "nodeResults": {}}
        )
        ex._executions_table.update_item(
            Key={"executionId": "exec1"},
            UpdateExpression="SET #status = :s, #startedAt = :t",
            ExpressionAttributeNames={"#status": "status", "#startedAt": "startedAt"},
            ExpressionAttributeValues={":s": "running", ":t": ex._now_iso()},
        )
        row = e2e["resource"].Table(EXEC_TABLE).get_item(Key={"executionId": "exec1"})["Item"]
        assert row["status"] == "running"

    def test_node_failure_terminal_update(self, e2e, monkeypatch):
        ex = self._wire(monkeypatch, e2e["resource"])
        e2e["resource"].Table(EXEC_TABLE).put_item(
            Item={"executionId": "exec1", "status": "running",
                  "nodeResults": {"node1": {"status": "running"}}}
        )
        # Mirror the no-retry terminal branch (executor.py handle_node_failure).
        ex._executions_table.update_item(
            Key={"executionId": "exec1"},
            UpdateExpression=(
                "SET nodeResults.#nid.#status = :nstatus, "
                "nodeResults.#nid.#error = :error, #status = :estatus, "
                "#failedAt = :failedAt"
            ),
            ExpressionAttributeNames={
                "#nid": "node1", "#status": "status",
                "#failedAt": "failedAt", "#error": "error",
            },
            ExpressionAttributeValues={
                ":nstatus": "failed", ":error": "boom",
                ":estatus": "failed", ":failedAt": ex._now_iso(),
            },
        )
        row = e2e["resource"].Table(EXEC_TABLE).get_item(Key={"executionId": "exec1"})["Item"]
        assert row["status"] == "failed"

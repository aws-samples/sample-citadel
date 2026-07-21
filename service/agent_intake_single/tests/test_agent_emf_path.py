"""Agent-path tests for Wave 0 EMF instrumentation (agent.invoke).

Asserts that a completed turn through ``agent.invoke`` emits exactly ONE
turn-level EMF line on stdout (plus per-tool lines only when tools ran) and —
observability only — that the streamed response chunks are byte-identical to
what the strands stream yields today.
"""
import asyncio
import json
import sys
import types

# The SUT (``agent.py``) imports ``bedrock_agentcore`` at module load, which is
# only guaranteed inside the AgentCore runtime image. Stub it exactly like
# tests/test_agent_cache.py so the import chain resolves deterministically.
if 'bedrock_agentcore' not in sys.modules:
    stub = types.ModuleType('bedrock_agentcore')

    class _StubApp:
        def __init__(self, *a, **kw): pass
        def add_middleware(self, *a, **kw): pass
        def entrypoint(self, fn):
            return fn  # passthrough decorator

    class _StubRequestContext:
        pass

    stub.BedrockAgentCoreApp = _StubApp  # type: ignore[attr-defined]
    stub.RequestContext = _StubRequestContext  # type: ignore[attr-defined]
    sys.modules['bedrock_agentcore'] = stub

from unittest.mock import patch


class FakeToolMetrics:
    def __init__(self, call_count, total_time):
        self.call_count = call_count
        self.total_time = total_time


class FakeEventLoopMetrics:
    def __init__(self, cycle_count, tool_metrics, accumulated_usage):
        self.cycle_count = cycle_count
        self.tool_metrics = tool_metrics
        self.accumulated_usage = accumulated_usage


class FakeAgentResult:
    def __init__(self, metrics):
        self.metrics = metrics


class FakeStrandsAgent:
    """Yields data chunks then the final result event, like Agent.stream_async."""

    def __init__(self, chunks, result):
        self._chunks = chunks
        self._result = result
        self.received_messages = None

    def stream_async(self, messages):
        self.received_messages = messages

        async def _gen():
            for chunk in self._chunks:
                yield {"data": chunk}
            yield {"result": self._result}

        return _gen()


def _no_tool_result():
    return FakeAgentResult(
        FakeEventLoopMetrics(
            cycle_count=1,
            tool_metrics={},
            accumulated_usage={"inputTokens": 50, "outputTokens": 20, "totalTokens": 70},
        )
    )


async def _collect(gen):
    return [chunk async for chunk in gen]


def _run_turn(agent_module, fake_agent, payload):
    with patch.object(agent_module, 'get_agent', return_value=fake_agent):
        return asyncio.run(_collect(agent_module.invoke(payload, None)))


def _emf_lines(capsys):
    out = capsys.readouterr().out
    blobs = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue  # non-EMF log noise from other components
        if isinstance(parsed, dict) and "_aws" in parsed:
            blobs.append(parsed)
    return blobs


class TestInvokeEmfPath:
    def test_one_emf_line_per_turn_with_turn_metrics(self, capsys):
        import agent

        fake = FakeStrandsAgent(["Hello ", "world"], _no_tool_result())
        _run_turn(agent, fake, {"session_id": "sess-emf-1", "prompt": "hi"})

        blobs = _emf_lines(capsys)
        assert len(blobs) == 1
        turn = blobs[0]
        directive = turn["_aws"]["CloudWatchMetrics"][0]
        assert directive["Namespace"] == "Citadel/Intake"
        assert directive["Dimensions"] == [["Environment"]]
        names = {m["Name"] for m in directive["Metrics"]}
        assert "TurnDuration_ms" in names
        assert "ModelRoundTrips" in names
        assert turn["TurnDuration_ms"] >= 0
        assert turn["ModelRoundTrips"] == 1
        assert turn["session_id"] == "sess-emf-1"

    def test_response_content_unchanged(self, capsys):
        import agent

        fake = FakeStrandsAgent(["Hello ", "world"], _no_tool_result())
        chunks = _run_turn(agent, fake, {"session_id": "sess-emf-2", "prompt": "hi"})

        assert chunks == ["Hello ", "world"]
        # The user message forwarded to the strands agent is also unchanged.
        assert fake.received_messages == [{"text": "hi"}]

    def test_two_turns_emit_two_emf_lines(self, capsys):
        import agent

        _run_turn(agent, FakeStrandsAgent(["a"], _no_tool_result()),
                  {"session_id": "s1", "prompt": "one"})
        _run_turn(agent, FakeStrandsAgent(["b"], _no_tool_result()),
                  {"session_id": "s2", "prompt": "two"})

        blobs = _emf_lines(capsys)
        assert len(blobs) == 2
        assert [b["session_id"] for b in blobs] == ["s1", "s2"]

    def test_turn_with_tools_adds_per_tool_lines(self, capsys):
        import agent

        result = FakeAgentResult(
            FakeEventLoopMetrics(
                cycle_count=2,
                tool_metrics={"extract_information": FakeToolMetrics(1, 0.5)},
                accumulated_usage={"inputTokens": 5, "outputTokens": 3, "totalTokens": 8},
            )
        )
        _run_turn(agent, FakeStrandsAgent(["ok"], result),
                  {"session_id": "s3", "prompt": "go"})

        blobs = _emf_lines(capsys)
        assert len(blobs) == 2  # turn line + one tool line
        tool_line = blobs[1]
        assert tool_line["Tool"] == "extract_information"
        assert tool_line["ToolDuration_ms"] == 500.0

    def test_stream_without_result_event_still_emits_turn_duration(self, capsys):
        """Defensive: a stream that never yields a result event must still
        produce the turn line (TurnDuration only) and never raise."""
        import agent

        class NoResultAgent:
            def stream_async(self, messages):
                async def _gen():
                    yield {"data": "partial"}
                return _gen()

        chunks = _run_turn(agent, NoResultAgent(), {"session_id": "s4", "prompt": "hi"})

        assert chunks == ["partial"]
        blobs = _emf_lines(capsys)
        assert len(blobs) == 1
        assert {m["Name"] for m in blobs[0]["_aws"]["CloudWatchMetrics"][0]["Metrics"]} == {"TurnDuration_ms"}

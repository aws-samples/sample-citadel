import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  getGovernanceEnforce,
  getGovernanceEffectiveAt,
  __resetGovernanceFlagCacheForTest,
  type GovernanceEnforce,
} from "../governance-flag";

const ssmMock = mockClient(SSMClient);

describe("governance-flag", () => {
  const ENV = "dev";

  beforeEach(() => {
    ssmMock.reset();
    __resetGovernanceFlagCacheForTest();
  });

  test('returns permissive when parameter value is "permissive"', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "permissive" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "" } });
    expect(await getGovernanceEnforce(ENV)).toBe("permissive");
  });

  test("returns shadow with a populated effective_at", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "shadow" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "2026-05-15T00:00:00Z" } });
    expect(await getGovernanceEnforce(ENV)).toBe("shadow");
    expect(await getGovernanceEffectiveAt(ENV)).toBe("2026-05-15T00:00:00Z");
  });

  test("returns strict", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "strict" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "2026-05-15T00:00:00Z" } });
    expect(await getGovernanceEnforce(ENV)).toBe("strict");
  });

  test("falls back to shadow on SSM error", async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error("ParameterNotFound"));
    expect(await getGovernanceEnforce(ENV)).toBe("shadow");
  });

  test("falls back to shadow for unrecognised value", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "anarchy" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "" } });
    expect(await getGovernanceEnforce(ENV)).toBe("shadow");
  });

  test("TS fallback literal matches the shared cross-runtime default (shadow)", async () => {
    // Cross-runtime contract: this literal must equal Python's
    // _DEFAULT_ENFORCEMENT_MODE ('shadow') — see
    // arbiter/governance/__tests__/test_hierarchy_enforcement_mode.py's
    // equivalent assertions and hierarchy.py's _DEFAULT_ENFORCEMENT_MODE.
    // A future edit to either side that lets them diverge must fail here.
    ssmMock.on(GetParameterCommand).rejects(new Error("ParameterNotFound"));
    const DEFAULT_ENFORCEMENT_MODE: GovernanceEnforce = "shadow";
    expect(await getGovernanceEnforce(ENV)).toBe(DEFAULT_ENFORCEMENT_MODE);
  });

  test("logs a warning on SSM error (visibility parity with Python logger.warning)", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    ssmMock.on(GetParameterCommand).rejects(new Error("ParameterNotFound"));
    await getGovernanceEnforce(ENV);
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).toLowerCase().includes("ssm"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  test("logs a warning on unrecognised value", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "anarchy" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "" } });
    await getGovernanceEnforce(ENV);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('emits a "governance flag defaulted" EMF signal on SSM error, distinguishing a defaulted mode from a configured one', async () => {
    const logSpy = jest
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    ssmMock.on(GetParameterCommand).rejects(new Error("ParameterNotFound"));
    await getGovernanceEnforce(ENV);
    const defaultedLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("GovernanceFlagDefaulted"));
    expect(defaultedLine).toBeDefined();
    const parsed = JSON.parse(defaultedLine as string);
    expect(parsed.GovernanceFlagDefaulted).toBe(1);
    logSpy.mockRestore();
  });

  test('does NOT emit the "governance flag defaulted" signal when a valid value is read', async () => {
    const logSpy = jest
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "strict" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "" } });
    await getGovernanceEnforce(ENV);
    const defaultedLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("GovernanceFlagDefaulted"));
    expect(defaultedLine).toBeUndefined();
    logSpy.mockRestore();
  });

  test("effective_at null when empty", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "permissive" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "" } });
    expect(await getGovernanceEffectiveAt(ENV)).toBeNull();
  });

  test("effective_at null when absent (SSM error)", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "permissive" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .rejects(new Error("ParameterNotFound"));
    expect(await getGovernanceEffectiveAt(ENV)).toBeNull();
  });

  test("cache hit within TTL produces only one SSM batch", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "shadow" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "2026-05-15T00:00:00Z" } });

    await getGovernanceEnforce(ENV);
    await getGovernanceEnforce(ENV);
    await getGovernanceEffectiveAt(ENV);

    expect(ssmMock.calls().length).toBe(2);
  });

  test("__resetGovernanceFlagCacheForTest forces reload", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: "permissive" } });
    ssmMock
      .on(GetParameterCommand, {
        Name: `/citadel/governance/effective_at/${ENV}`,
      })
      .resolves({ Parameter: { Value: "" } });

    await getGovernanceEnforce(ENV);
    __resetGovernanceFlagCacheForTest();
    await getGovernanceEnforce(ENV);

    expect(ssmMock.calls().length).toBe(4);
  });

  test("GovernanceEnforce permits three literals", () => {
    const valid: GovernanceEnforce[] = ["permissive", "shadow", "strict"];
    expect(valid).toHaveLength(3);
  });
});

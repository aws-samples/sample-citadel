/**
 * Cross-package contract test (backend half).
 *
 * Pairs the backend `getDecisionTrace` resolver decomposition
 * (`backend/src/lambda/governance-ui-resolver.ts`) with the frontend
 * `tracerDecompose.ts` decomposition. Both implementations consume the
 * SAME shared fixture file at `backend/test/fixtures/decision-trace-contract.json`
 * and MUST produce identical traces. The frontend half lives at
 * `frontend/src/pages/__tests__/decision-trace-contract.test.ts`.
 *
 * The contract intentionally compares only the visible decomposition
 * surface — `findingId`, `terminalStepNumber`, `terminalDecision`,
 * `reasonTokens`, `constitutionalOverride`, `arbitrationPattern`,
 * `scopeReduction`, and the `(stepNumber, status)` tuples. The
 * `inputs` / `outputs` / `detail` strings on each step are NOT part of
 * the contract because they may legitimately differ in formatting
 * between the two implementations without diverging in behaviour.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildSteps,
  detectArbitrationPattern,
  detectScopeReduction,
  parseReasonTokens,
} from '../governance-ui-resolver';

interface ExpectedStepStatus {
  stepNumber: number;
  status: string;
}

interface ContractFixture {
  name: string;
  finding: {
    findingId: string;
    workflowId: string;
    decision: string;
    reason: string;
    requestingAgent: string;
    targetAgent: string;
    scopeEvaluated: string | null;
    contractEvaluated: string | null;
    escalationTarget: string | null;
    residualAuthorityDenial: boolean | null;
    timestamp: number;
  };
  expected: {
    findingId: string;
    terminalStepNumber: number;
    terminalDecision: string;
    reasonTokens: string[];
    constitutionalOverride: boolean;
    arbitrationPattern: string | null;
    scopeReduction: string | null;
    steps: ExpectedStepStatus[];
  };
}

describe('decision-trace decomposition contract (backend)', () => {
  const fixturesPath = join(
    __dirname,
    '..',
    '..',
    '..',
    'test',
    'fixtures',
    'decision-trace-contract.json',
  );
  const fixtures = JSON.parse(
    readFileSync(fixturesPath, 'utf8'),
  ) as ContractFixture[];

  it('loads the 5 contract fixtures', () => {
    expect(fixtures).toHaveLength(5);
  });

  fixtures.forEach((fx) => {
    it(`decomposes ${fx.name}`, () => {
      const tokens = parseReasonTokens(fx.finding.reason);
      const arbitrationPattern = detectArbitrationPattern(tokens);
      const scopeReduction = detectScopeReduction(tokens);
      const { steps, terminalStepNumber, constitutionalOverride } = buildSteps(
        fx.finding,
        tokens,
        arbitrationPattern,
        scopeReduction,
      );
      expect({
        findingId: fx.finding.findingId,
        terminalStepNumber,
        terminalDecision: fx.finding.decision,
        reasonTokens: tokens,
        constitutionalOverride,
        arbitrationPattern,
        scopeReduction,
        steps: steps.map((s) => ({
          stepNumber: s.stepNumber,
          status: s.status,
        })),
      }).toEqual(fx.expected);
    });
  });
});

/**
 * Cross-package contract test (frontend half).
 *
 * Pairs the frontend `decomposeFinding` helper
 * (`frontend/src/pages/governance/tracerDecompose.ts`) with the backend
 * `getDecisionTrace` resolver decomposition. Both implementations
 * consume the SAME shared fixture file at
 * `backend/test/fixtures/decision-trace-contract.json` and MUST produce
 * identical traces. The backend half lives at
 * `backend/src/lambda/__tests__/decision-trace-contract.test.ts`.
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
import { decomposeFinding } from '../governance/tracerDecompose';
import type { GovernanceFinding } from '../../services/governanceService';

interface ExpectedStepStatus {
  stepNumber: number;
  status: string;
}

interface ContractFixture {
  name: string;
  finding: GovernanceFinding;
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

describe('decision-trace decomposition contract (frontend)', () => {
  const fixturesPath = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'backend',
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
      const trace = decomposeFinding(fx.finding);
      expect({
        findingId: trace.findingId,
        terminalStepNumber: trace.terminalStepNumber,
        terminalDecision: trace.terminalDecision,
        reasonTokens: trace.reasonTokens,
        constitutionalOverride: trace.constitutionalOverride,
        arbitrationPattern: trace.arbitrationPattern,
        scopeReduction: trace.scopeReduction,
        steps: trace.steps.map((s) => ({
          stepNumber: s.stepNumber,
          status: s.status,
        })),
      }).toEqual(fx.expected);
    });
  });
});

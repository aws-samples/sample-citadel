import * as fc from 'fast-check';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { STSClient } from '@aws-sdk/client-sts';
import { PolicyManager } from '../../../utils/policy-manager';
import { PolicyStatement } from '../../../adapters/base';

// ---- Generators ----

const dataStoreIdArb = fc.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);

const accountIdArb = fc.stringMatching(/^\d{12}$/);

const iamActionArb = fc.tuple(
  fc.constantFrom('s3', 'dynamodb', 'rds', 'iam', 'sts', 'sagemaker', 'bedrock'),
  fc.constantFrom('GetObject', 'PutItem', 'CreateTable', 'DescribeInstances', 'AssumeRole')
).map(([svc, action]) => `${svc}:${action}`);

const arnArb = fc.tuple(
  fc.constantFrom('s3', 'dynamodb', 'rds', 'iam'),
  fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
  accountIdArb,
  fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/)
).map(([svc, region, acct, name]) => `arn:aws:${svc}:${region}:${acct}:${name}`);

const policyStatementArb: fc.Arbitrary<PolicyStatement> = fc.record({
  actions: fc.array(iamActionArb, { minLength: 1, maxLength: 5 }),
  resources: fc.array(arnArb, { minLength: 1, maxLength: 3 }),
});

const policyStatementsArb = fc.array(policyStatementArb, { minLength: 1, maxLength: 5 });

const crossAccountRoleArnArb = accountIdArb.map(
  (acct) => `arn:aws:iam::${acct}:role/CrossAccountRole`
);

// ---- Mocks ----

/** Captured IAM command inputs, keyed by command constructor name. */
type CapturedCalls = Record<string, Array<Record<string, string>>>;

function makeMockIamClient(capturedCalls: CapturedCalls = {}) {
  return {
    send: jest.fn().mockImplementation((cmd: { input: Record<string, string> }) => {
      const name = cmd.constructor.name;
      if (!capturedCalls[name]) capturedCalls[name] = [];
      capturedCalls[name].push(cmd.input);
      return Promise.resolve({});
    }),
  } as unknown as IAMClient;
}

function makeMockStsClient(
  accountId: string,
  callerArn: string,
  region = 'us-east-1'
) {
  return {
    send: jest.fn().mockImplementation((cmd: object) => {
      if (cmd.constructor.name === 'GetCallerIdentityCommand') {
        return Promise.resolve({ Account: accountId, Arn: callerArn });
      }
      if (cmd.constructor.name === 'AssumeRoleCommand') {
        return Promise.resolve({
          Credentials: {
            AccessKeyId: 'AKID',
            SecretAccessKey: 'SECRET',
            SessionToken: 'TOKEN',
          },
        });
      }
      return Promise.resolve({});
    }),
    config: { region: () => Promise.resolve(region) },
  } as unknown as STSClient;
}

// Feature: datastore-adapter-pattern, Property 2: PolicyManager policy document generation
// Validates: Requirements 3.1, 3.2
describe('Property 2: PolicyManager policy document generation', () => {
  it('ensureRole creates role named citadel-ds-{dataStoreId} with inline policy matching PolicyStatements', () => {
    fc.assert(
      fc.asyncProperty(
        dataStoreIdArb,
        policyStatementsArb,
        accountIdArb,
        async (dataStoreId, policies, accountId) => {
          const capturedCalls: CapturedCalls = {};
          const iamClient = makeMockIamClient(capturedCalls);
          const callerArn = `arn:aws:sts::${accountId}:assumed-role/LambdaRole/session`;
          const stsClient = makeMockStsClient(accountId, callerArn);

          const pm = new PolicyManager(iamClient, stsClient);
          await pm.ensureRole(dataStoreId, policies, accountId);

          // Verify role name
          const createRoleCalls = capturedCalls['CreateRoleCommand'];
          expect(createRoleCalls).toBeDefined();
          expect(createRoleCalls.length).toBe(1);
          expect(createRoleCalls[0].RoleName).toBe(`citadel-ds-${dataStoreId}`);

          // Verify inline policy
          const putPolicyCalls = capturedCalls['PutRolePolicyCommand'];
          expect(putPolicyCalls).toBeDefined();
          expect(putPolicyCalls.length).toBe(1);
          expect(putPolicyCalls[0].RoleName).toBe(`citadel-ds-${dataStoreId}`);
          expect(putPolicyCalls[0].PolicyName).toBe('DataStoreAccess');

          const policyDoc = JSON.parse(putPolicyCalls[0].PolicyDocument);
          expect(policyDoc.Version).toBe('2012-10-17');
          expect(policyDoc.Statement).toHaveLength(policies.length);

          for (let i = 0; i < policies.length; i++) {
            expect(policyDoc.Statement[i].Effect).toBe('Allow');
            expect(policyDoc.Statement[i].Action).toEqual(policies[i].actions);
            expect(policyDoc.Statement[i].Resource).toEqual(policies[i].resources);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 3: PolicyManager cross-account trust policy
// Validates: Requirements 3.3
describe('Property 3: PolicyManager cross-account trust policy', () => {
  it('trust policy includes cross-account role ARN alongside Lambda role when provided', () => {
    fc.assert(
      fc.asyncProperty(
        dataStoreIdArb,
        policyStatementsArb,
        accountIdArb,
        crossAccountRoleArnArb,
        async (dataStoreId, policies, accountId, crossAccountRoleArn) => {
          const capturedCalls: CapturedCalls = {};
          const iamClient = makeMockIamClient(capturedCalls);
          const callerArn = `arn:aws:sts::${accountId}:assumed-role/LambdaRole/session`;
          const stsClient = makeMockStsClient(accountId, callerArn);

          const pm = new PolicyManager(iamClient, stsClient);
          await pm.ensureRole(dataStoreId, policies, accountId, crossAccountRoleArn);

          const createRoleCalls = capturedCalls['CreateRoleCommand'];
          const trustPolicy = JSON.parse(createRoleCalls[0].AssumeRolePolicyDocument);

          const principals = trustPolicy.Statement[0].Principal.AWS;
          // Should be an array with both the Lambda role and cross-account role
          expect(Array.isArray(principals)).toBe(true);
          expect(principals).toContain(`arn:aws:iam::${accountId}:role/LambdaRole`);
          expect(principals).toContain(crossAccountRoleArn);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('trust policy has single principal (no array) when no cross-account role is provided', () => {
    fc.assert(
      fc.asyncProperty(
        dataStoreIdArb,
        policyStatementsArb,
        accountIdArb,
        async (dataStoreId, policies, accountId) => {
          const capturedCalls: CapturedCalls = {};
          const iamClient = makeMockIamClient(capturedCalls);
          const callerArn = `arn:aws:sts::${accountId}:assumed-role/LambdaRole/session`;
          const stsClient = makeMockStsClient(accountId, callerArn);

          const pm = new PolicyManager(iamClient, stsClient);
          await pm.ensureRole(dataStoreId, policies, accountId);

          const createRoleCalls = capturedCalls['CreateRoleCommand'];
          const trustPolicy = JSON.parse(createRoleCalls[0].AssumeRolePolicyDocument);

          const principals = trustPolicy.Statement[0].Principal.AWS;
          // Should be a single string, not an array
          expect(typeof principals).toBe('string');
          expect(principals).toBe(`arn:aws:iam::${accountId}:role/LambdaRole`);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 4: Retry mechanism correctness
// Validates: Requirements 3.5, 16.1, 16.2, 16.3
describe('Property 4: Retry mechanism correctness', () => {
  it('returns success when operation fails N <= maxRetries times then succeeds', () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),  // maxRetries
        fc.integer({ min: 10, max: 50 }), // baseDelayMs (small for test speed)
        fc.nat({ max: 5 }),               // failCount (will be clamped to <= maxRetries)
        async (maxRetries, baseDelayMs, rawFailCount) => {
          const failCount = Math.min(rawFailCount, maxRetries);
          let attempts = 0;
          const fn = async () => {
            attempts++;
            if (attempts <= failCount) {
              throw new Error(`Attempt ${attempts} failed`);
            }
            return 'success';
          };

          const pm = new PolicyManager({} as unknown as IAMClient, {} as unknown as STSClient);
          const result = await pm.retryWithBackoff(fn, maxRetries, baseDelayMs);
          expect(result).toBe('success');
          expect(attempts).toBe(failCount + 1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('throws last error when operation fails more than maxRetries times', () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),  // maxRetries
        fc.integer({ min: 10, max: 50 }), // baseDelayMs
        async (maxRetries, baseDelayMs) => {
          let attempts = 0;
          const fn = async () => {
            attempts++;
            throw new Error(`Attempt ${attempts} failed`);
          };

          const pm = new PolicyManager({} as unknown as IAMClient, {} as unknown as STSClient);
          try {
            await pm.retryWithBackoff(fn, maxRetries, baseDelayMs);
            fail('Expected error to be thrown');
          } catch (error) {
            // Should have attempted maxRetries + 1 times (initial + retries)
            expect(attempts).toBe(maxRetries + 1);
            expect((error as Error).message).toBe(`Attempt ${maxRetries + 1} failed`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('delay between attempt i and i+1 is baseDelayMs * 2^i', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),   // maxRetries
        fc.integer({ min: 50, max: 100 }), // baseDelayMs
        async (maxRetries, baseDelayMs) => {
          // Capture the delay values the implementation schedules via setTimeout
          // and resolve them immediately. This asserts the COMPUTED exponential
          // backoff sequence rather than measured wall-clock elapsed time, which
          // is flaky under CI event-loop contention (a backoff callback firing
          // late pushed measured elapsed time past the fixed absolute upper bound).
          const scheduledDelays: number[] = [];
          const setTimeoutSpy = jest
            .spyOn(global, 'setTimeout')
            .mockImplementation(((cb: (...args: unknown[]) => void, ms?: number) => {
              scheduledDelays.push(Number(ms) || 0);
              queueMicrotask(() => cb());
              return 0 as unknown as NodeJS.Timeout;
            }) as unknown as typeof setTimeout);

          try {
            let attempts = 0;
            const fn = async () => {
              attempts++;
              if (attempts <= maxRetries) {
                throw new Error(`Attempt ${attempts} failed`);
              }
              return 'success';
            };

            const pm = new PolicyManager({} as unknown as IAMClient, {} as unknown as STSClient);
            const result = await pm.retryWithBackoff(fn, maxRetries, baseDelayMs);

            expect(result).toBe('success');
            // Exactly one backoff sleep is scheduled before each retry.
            expect(scheduledDelays).toHaveLength(maxRetries);
            // Exponential doubling: delay i equals baseDelayMs * 2^i (exact integers).
            scheduledDelays.forEach((delay, i) => {
              expect(delay).toBe(baseDelayMs * Math.pow(2, i));
            });
          } finally {
            setTimeoutSpy.mockRestore();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

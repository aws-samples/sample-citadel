import * as fc from 'fast-check';
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

function makeMockIamClient(capturedCalls: Record<string, any[]> = {}) {
  return {
    send: jest.fn().mockImplementation((cmd: any) => {
      const name = cmd.constructor.name;
      if (!capturedCalls[name]) capturedCalls[name] = [];
      capturedCalls[name].push(cmd.input);
      return Promise.resolve({});
    }),
  } as any;
}

function makeMockStsClient(
  accountId: string,
  callerArn: string,
  region = 'us-east-1'
) {
  return {
    send: jest.fn().mockImplementation((cmd: any) => {
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
  } as any;
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
          const capturedCalls: Record<string, any[]> = {};
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
          const capturedCalls: Record<string, any[]> = {};
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
          const capturedCalls: Record<string, any[]> = {};
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

          const pm = new PolicyManager({} as any, {} as any);
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

          const pm = new PolicyManager({} as any, {} as any);
          try {
            await pm.retryWithBackoff(fn, maxRetries, baseDelayMs);
            fail('Expected error to be thrown');
          } catch (error: any) {
            // Should have attempted maxRetries + 1 times (initial + retries)
            expect(attempts).toBe(maxRetries + 1);
            expect(error.message).toBe(`Attempt ${maxRetries + 1} failed`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('delay between attempt i and i+1 is baseDelayMs * 2^i', () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),   // maxRetries
        fc.integer({ min: 50, max: 100 }), // baseDelayMs
        async (maxRetries, baseDelayMs) => {
          const timestamps: number[] = [];
          let attempts = 0;

          const fn = async () => {
            timestamps.push(Date.now());
            attempts++;
            if (attempts <= maxRetries) {
              throw new Error(`Attempt ${attempts} failed`);
            }
            return 'success';
          };

          const pm = new PolicyManager({} as any, {} as any);
          await pm.retryWithBackoff(fn, maxRetries, baseDelayMs);

          // Verify delays are approximately correct (with tolerance for timing)
          for (let i = 0; i < timestamps.length - 1; i++) {
            const actualDelay = timestamps[i + 1] - timestamps[i];
            const expectedDelay = baseDelayMs * Math.pow(2, i);
            // Allow 50ms tolerance for timer imprecision
            expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay - 50);
            expect(actualDelay).toBeLessThan(expectedDelay + 200);
          }
        }
      ),
      { numRuns: 20 } // Fewer runs since this involves real delays
    );
  });
});

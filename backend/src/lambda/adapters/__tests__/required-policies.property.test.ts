import * as fc from 'fast-check';
import { S3Adapter } from '../s3-adapter';
import { DynamoDBAdapter } from '../dynamodb-adapter';
import { RdsAdapter } from '../rds-adapter';

// Feature: datastore-adapter-pattern, Property 5: AWS adapter requiredPolicies returns valid PolicyStatements
// Validates: Requirements 4.1, 5.1, 6.2

const arnPattern = /^arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]*:.+$/;
const iamActionPattern = /^[a-z0-9]+:[A-Za-z0-9]+$/;

const accountIdArb = fc.stringMatching(/^[0-9]{12}$/);
const regionArb = fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1');
const resourceNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,30}$/);

describe('Property 5: AWS adapter requiredPolicies returns valid PolicyStatements', () => {
  it('S3Adapter returns well-formed ARNs and valid IAM actions', () => {
    const adapter = new S3Adapter();
    fc.assert(
      fc.property(
        resourceNameArb,
        accountIdArb,
        regionArb,
        (bucketName, accountId, region) => {
          const policies = adapter.requiredPolicies({ bucketName }, accountId, region);

          // Provision policies use wildcard resources (resource doesn't exist yet)
          for (const stmt of policies.provision) {
            for (const action of stmt.actions) {
              expect(action).toMatch(iamActionPattern);
            }
            expect(stmt.resources).toEqual(['*']);
          }

          // Connect policies use scoped S3 ARNs
          for (const stmt of policies.connect) {
            for (const action of stmt.actions) {
              expect(action).toMatch(iamActionPattern);
            }
            for (const resource of stmt.resources) {
              // S3 ARNs use arn:aws:s3:::bucket format (no region/account)
              expect(resource).toMatch(/^arn:aws:s3:::/);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('DynamoDBAdapter returns well-formed ARNs and valid IAM actions', () => {
    const adapter = new DynamoDBAdapter();
    fc.assert(
      fc.property(
        resourceNameArb,
        accountIdArb,
        regionArb,
        (tableName, accountId, region) => {
          const policies = adapter.requiredPolicies({ tableName }, accountId, region);

          // Provision policies use wildcard resources (resource doesn't exist yet)
          for (const stmt of policies.provision) {
            for (const action of stmt.actions) {
              expect(action).toMatch(iamActionPattern);
            }
            expect(stmt.resources).toEqual(['*']);
          }

          // Connect policies use scoped ARNs
          for (const stmt of policies.connect) {
            for (const action of stmt.actions) {
              expect(action).toMatch(iamActionPattern);
            }
            for (const resource of stmt.resources) {
              expect(resource).toMatch(arnPattern);
              expect(resource).toContain(region);
              expect(resource).toContain(accountId);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('RdsAdapter (postgres) returns well-formed ARNs and valid IAM actions', () => {
    const adapter = new RdsAdapter('postgres');
    fc.assert(
      fc.property(
        resourceNameArb,
        accountIdArb,
        regionArb,
        (dbInstanceIdentifier, accountId, region) => {
          const policies = adapter.requiredPolicies({ dbInstanceIdentifier }, accountId, region);

          // Provision policies use wildcard resources (resource doesn't exist yet)
          for (const stmt of policies.provision) {
            for (const action of stmt.actions) {
              expect(action).toMatch(iamActionPattern);
            }
            expect(stmt.resources).toEqual(['*']);
          }

          // Connect policies use scoped ARNs
          for (const stmt of policies.connect) {
            for (const action of stmt.actions) {
              expect(action).toMatch(iamActionPattern);
            }
            for (const resource of stmt.resources) {
              expect(resource).toMatch(arnPattern);
              expect(resource).toContain(region);
              expect(resource).toContain(accountId);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('RdsAdapter (mysql) returns well-formed ARNs and valid IAM actions', () => {
    const adapter = new RdsAdapter('mysql');
    fc.assert(
      fc.property(
        resourceNameArb,
        accountIdArb,
        regionArb,
        (dbInstanceIdentifier, accountId, region) => {
          const policies = adapter.requiredPolicies({ dbInstanceIdentifier }, accountId, region);

          // Provision policies use wildcard resources (resource doesn't exist yet)
          for (const stmt of policies.provision) {
            for (const action of stmt.actions) {
              expect(action).toMatch(iamActionPattern);
            }
            expect(stmt.resources).toEqual(['*']);
          }

          // Connect policies use scoped ARNs
          for (const stmt of policies.connect) {
            for (const action of stmt.actions) {
              expect(action).toMatch(iamActionPattern);
            }
            for (const resource of stmt.resources) {
              expect(resource).toMatch(arnPattern);
              expect(resource).toContain(region);
              expect(resource).toContain(accountId);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

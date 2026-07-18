import * as fc from 'fast-check';
import { ExternalDatabaseAdapter } from '../external-adapter';
import { AwsGenericAdapter } from '../aws-generic-adapter';
import { ProvisioningError, ConnectionError } from '../errors';

// Mock net.Socket for TCP checks
const mockConnect = jest.fn();
const mockDestroy = jest.fn();
const mockOn = jest.fn();
const mockSetTimeout = jest.fn();

jest.mock('net', () => ({
  Socket: jest.fn().mockImplementation(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const instance = {
      setTimeout: mockSetTimeout,
      once: (event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
        mockOn(event, cb);
      },
      connect: (...args: unknown[]) => {
        mockConnect(...args);
        // By default trigger 'connect' event on next tick
        if (handlers['connect']) {
          process.nextTick(() => handlers['connect']());
        }
      },
      destroy: mockDestroy,
    };
    return instance;
  }),
}));

const externalKinds = ['postgresql', 'mysql', 'mongodb', 'elasticsearch', 'redis', 'api'] as const;
const tcpKinds = ['postgresql', 'mysql', 'elasticsearch', 'redis'] as const;

const genericServiceNames = [
  'knowledge-base', 'aurora-postgresql', 'aurora-mysql', 'redshift',
  'lake-formation', 'opensearch', 'neptune', 'timestream',
  'documentdb', 'elasticache-redis', 'keyspaces', 'qldb',
  'sagemaker-feature-store',
];

beforeEach(() => {
  mockConnect.mockReset();
  mockDestroy.mockReset();
  mockOn.mockReset();
  mockSetTimeout.mockReset();
});

// Feature: datastore-adapter-pattern, Property 6: No-IAM adapters return empty policies
// Validates: Requirements 7.2, 8.2
describe('Property 6: No-IAM adapters return empty policies', () => {
  const externalKindArb = fc.constantFrom(...externalKinds);
  const genericNameArb = fc.constantFrom(...genericServiceNames);
  const configArb = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.string({ minLength: 0, maxLength: 50 }),
    { minKeys: 0, maxKeys: 5 }
  );
  const accountIdArb = fc.stringMatching(/^[0-9]{12}$/);
  const regionArb = fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1');

  it('ExternalDatabaseAdapter returns empty provision and connect policies for all kinds', () => {
    fc.assert(
      fc.property(externalKindArb, configArb, accountIdArb, regionArb, (kind, config, accountId, region) => {
        const adapter = new ExternalDatabaseAdapter(kind);
        const policies = adapter.requiredPolicies(config, accountId, region);
        expect(policies.provision).toEqual([]);
        expect(policies.connect).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it('AwsGenericAdapter returns empty provision and connect policies for all service names', () => {
    fc.assert(
      fc.property(genericNameArb, configArb, accountIdArb, regionArb, (name, config, accountId, region) => {
        const adapter = new AwsGenericAdapter(name);
        const policies = adapter.requiredPolicies(config, accountId, region);
        expect(policies.provision).toEqual([]);
        expect(policies.connect).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 7: External adapter provision throws ProvisioningError
// Validates: Requirements 7.3
describe('Property 7: External adapter provision throws ProvisioningError', () => {
  const externalKindArb = fc.constantFrom(...externalKinds);
  const configArb = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.string({ minLength: 0, maxLength: 50 }),
    { minKeys: 0, maxKeys: 5 }
  );

  it('provision throws ProvisioningError for any external kind and config', async () => {
    await fc.assert(
      fc.asyncProperty(externalKindArb, configArb, async (kind, config) => {
        const adapter = new ExternalDatabaseAdapter(kind);
        await expect(adapter.provision(config)).rejects.toThrow(ProvisioningError);
      }),
      { numRuns: 100 }
    );
  });

  it('provision error message contains the kind', async () => {
    await fc.assert(
      fc.asyncProperty(externalKindArb, async (kind) => {
        const adapter = new ExternalDatabaseAdapter(kind);
        try {
          await adapter.provision({});
          fail('Expected ProvisioningError');
        } catch (err) {
          expect((err as Error).message).toContain(kind);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 8: External adapter connection validation
// Validates: Requirements 7.4, 7.5
describe('Property 8: External adapter connection validation', () => {
  it('mongodb: extracts hostname and port from valid URI, defaulting port to 27017', async () => {
    const hostArb = fc.domain();
    const portArb = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined });

    await fc.assert(
      fc.asyncProperty(hostArb, portArb, async (host, port) => {
        const adapter = new ExternalDatabaseAdapter('mongodb');
        const uri = port
          ? `mongodb://${host}:${port}/testdb`
          : `mongodb://${host}/testdb`;
        // TCP mock always succeeds
        const result = await adapter.testConnection({ connectionString: uri });
        expect(result.success).toBe(true);
        if (result.details) {
          expect(result.details.host).toBe(host);
          expect(result.details.port).toBe(port ?? 27017);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('mongodb: returns failure for unparseable connection strings', async () => {
    const invalidUriArb = fc.constantFrom('not-a-uri', '://missing', '', 'no-scheme');

    await fc.assert(
      fc.asyncProperty(invalidUriArb, async (uri) => {
        const adapter = new ExternalDatabaseAdapter('mongodb');
        const result = await adapter.testConnection({ connectionString: uri });
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('api: accepts well-formed URLs', async () => {
    const urlArb = fc.webUrl();

    await fc.assert(
      fc.asyncProperty(urlArb, async (url) => {
        const adapter = new ExternalDatabaseAdapter('api');
        const result = await adapter.testConnection({ baseUrl: url });
        expect(result.success).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('api: rejects malformed URLs', async () => {
    const badUrlArb = fc.constantFrom('not-a-url', 'missing-scheme.com', '://no-host', '');

    await fc.assert(
      fc.asyncProperty(badUrlArb, async (url) => {
        const adapter = new ExternalDatabaseAdapter('api');
        const result = await adapter.testConnection({ baseUrl: url });
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 9: External adapter connect delegates and throws on failure
// Validates: Requirements 7.7
describe('Property 9: External adapter connect delegates and throws on failure', () => {
  it('connect throws ConnectionError when testConnection returns success: false', async () => {
    // Use TCP kinds with missing host/port to force failure without network
    const tcpKindArb = fc.constantFrom(...tcpKinds);

    await fc.assert(
      fc.asyncProperty(tcpKindArb, async (kind) => {
        const adapter = new ExternalDatabaseAdapter(kind);
        // Missing host/port will cause testConnection to return success: false
        await expect(adapter.connect({})).rejects.toThrow(ConnectionError);
      }),
      { numRuns: 100 }
    );
  });

  it('api connect throws ConnectionError for malformed URLs', async () => {
    const badUrlArb = fc.constantFrom('not-a-url', 'missing-scheme.com', '://no-host', '');

    await fc.assert(
      fc.asyncProperty(badUrlArb, async (url) => {
        const adapter = new ExternalDatabaseAdapter('api');
        await expect(adapter.connect({ baseUrl: url })).rejects.toThrow(ConnectionError);
      }),
      { numRuns: 100 }
    );
  });

  it('connect succeeds when testConnection returns success: true (TCP kinds)', async () => {
    const tcpKindArb = fc.constantFrom(...tcpKinds);
    const portArb = fc.integer({ min: 1, max: 65535 });

    await fc.assert(
      fc.asyncProperty(tcpKindArb, portArb, async (kind, port) => {
        const adapter = new ExternalDatabaseAdapter(kind);
        // TCP mock triggers connect event by default, so this should succeed
        await expect(
          adapter.connect({ host: 'localhost', port })
        ).resolves.toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });
});

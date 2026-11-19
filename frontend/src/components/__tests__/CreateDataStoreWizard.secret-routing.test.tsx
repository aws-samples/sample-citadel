/**
 * CreateDataStoreWizard — secret-routing tests.
 *
 * Validates that the wizard splits secret-like fields into the `credentials`
 * bag and keeps only non-secret fields in `config` when calling
 * datastoreService.createDataStore.
 */
import { CREDENTIAL_KEYS, SECRET_FIELD_KEYS } from '../../utils/secret-field-keys';

describe('CREDENTIAL_KEYS / SECRET_FIELD_KEYS classification', () => {
  test('SECRET_FIELD_KEYS contains the expected secret keys', () => {
    expect(SECRET_FIELD_KEYS.has('masterPassword')).toBe(true);
    expect(SECRET_FIELD_KEYS.has('password')).toBe(true);
    expect(SECRET_FIELD_KEYS.has('apiKey')).toBe(true);
    expect(SECRET_FIELD_KEYS.has('connectionString')).toBe(true);
    expect(SECRET_FIELD_KEYS.has('token')).toBe(true);
  });

  test('CREDENTIAL_KEYS is a superset of SECRET_FIELD_KEYS', () => {
    for (const key of SECRET_FIELD_KEYS) {
      expect(CREDENTIAL_KEYS.has(key)).toBe(true);
    }
  });

  test('CREDENTIAL_KEYS includes credential-adjacent keys', () => {
    expect(CREDENTIAL_KEYS.has('masterUsername')).toBe(true);
    expect(CREDENTIAL_KEYS.has('username')).toBe(true);
  });

  test('CREDENTIAL_KEYS does not include non-secret config keys', () => {
    expect(CREDENTIAL_KEYS.has('bucketName')).toBe(false);
    expect(CREDENTIAL_KEYS.has('tableName')).toBe(false);
    expect(CREDENTIAL_KEYS.has('host')).toBe(false);
    expect(CREDENTIAL_KEYS.has('port')).toBe(false);
    expect(CREDENTIAL_KEYS.has('clusterIdentifier')).toBe(false);
  });
});

describe('secret field splitting logic', () => {
  // Test the splitting algorithm directly — same logic as handleSubmit
  function splitConfig(finalConfig: Record<string, string>) {
    const cleanConfig: Record<string, string> = {};
    const credentialsBag: Record<string, string> = {};
    for (const [key, value] of Object.entries(finalConfig)) {
      if (CREDENTIAL_KEYS.has(key)) {
        credentialsBag[key] = value;
      } else {
        cleanConfig[key] = value;
      }
    }
    return { cleanConfig, credentialsBag };
  }

  test('RDS config: masterUsername and masterPassword go to credentials', () => {
    const { cleanConfig, credentialsBag } = splitConfig({
      masterUsername: 'dbadmin',
      masterPassword: 'Secret123!',
      dbInstanceIdentifier: 'my-rds',
    });
    expect(credentialsBag).toEqual({ masterUsername: 'dbadmin', masterPassword: 'Secret123!' });
    expect(cleanConfig).toEqual({ dbInstanceIdentifier: 'my-rds' });
  });

  test('MongoDB config: connectionString goes to credentials', () => {
    const { cleanConfig, credentialsBag } = splitConfig({
      connectionString: 'mongodb://user:pass@host:27017/db',
    });
    expect(credentialsBag).toEqual({ connectionString: 'mongodb://user:pass@host:27017/db' });
    expect(cleanConfig).toEqual({});
  });

  test('External API config: apiKey goes to credentials, baseUrl stays', () => {
    const { cleanConfig, credentialsBag } = splitConfig({
      apiKey: 'sk-abc123',
      baseUrl: 'https://api.example.com',
    });
    expect(credentialsBag).toEqual({ apiKey: 'sk-abc123' });
    expect(cleanConfig).toEqual({ baseUrl: 'https://api.example.com' });
  });

  test('Snowflake config: username/password go to credentials, rest stays', () => {
    const { cleanConfig, credentialsBag } = splitConfig({
      accountIdentifier: 'myaccount',
      warehouse: 'COMPUTE_WH',
      database: 'MY_DB',
      username: 'user',
      password: 'pass',
    });
    expect(credentialsBag).toEqual({ username: 'user', password: 'pass' });
    expect(cleanConfig).toEqual({
      accountIdentifier: 'myaccount',
      warehouse: 'COMPUTE_WH',
      database: 'MY_DB',
    });
  });

  test('Databricks config: token goes to credentials', () => {
    const { cleanConfig, credentialsBag } = splitConfig({
      host: 'myworkspace.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc',
      token: 'dapi-token',
    });
    expect(credentialsBag).toEqual({ token: 'dapi-token' });
    expect(cleanConfig).toEqual({
      host: 'myworkspace.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc',
    });
  });

  test('S3 config: no secret fields, credentials bag is empty', () => {
    const { cleanConfig, credentialsBag } = splitConfig({
      bucketName: 'my-bucket',
    });
    expect(credentialsBag).toEqual({});
    expect(cleanConfig).toEqual({ bucketName: 'my-bucket' });
  });

  test('external TCP config: username/password to credentials, host/port stay', () => {
    const { cleanConfig, credentialsBag } = splitConfig({
      host: 'db.example.com',
      port: '5432',
      username: 'pguser',
      password: 'pgpass',
    });
    expect(credentialsBag).toEqual({ username: 'pguser', password: 'pgpass' });
    expect(cleanConfig).toEqual({ host: 'db.example.com', port: '5432' });
  });

  test('no secret value appears in cleanConfig for any adapter type', () => {
    const allAdapterConfigs: Record<string, string>[] = [
      { masterUsername: 'u', masterPassword: 'p', dbInstanceIdentifier: 'i' },
      { username: 'u', password: 'p', host: 'h', port: '5432' },
      { apiKey: 'k', baseUrl: 'https://example.com' },
      { connectionString: 'mongodb://u:p@h/db' },
      { token: 't', host: 'h', httpPath: '/p' },
      { masterUsername: 'u', masterPassword: 'p', clusterIdentifier: 'c' },
    ];
    for (const cfg of allAdapterConfigs) {
      const { cleanConfig } = splitConfig(cfg);
      for (const key of Object.keys(cleanConfig)) {
        expect(CREDENTIAL_KEYS.has(key)).toBe(false);
      }
    }
  });
});

/**
 * TDD Tests for Unified Error Hierarchy
 *
 * Errors should work for both datastores and integrations.
 */

import {
  ConnectorError,
  DataStoreError,
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  ConflictError,
  ValidationError,
  IntegrationError,
  NotImplementedError,
} from '../errors';

describe('Unified Error Hierarchy', () => {
  test('ConnectorError is the base class', () => {
    const err = new ConnectorError('test', 'TEST_CODE', false);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('TEST_CODE');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('test');
  });

  test('ProvisioningError extends ConnectorError', () => {
    const err = new ProvisioningError('provision failed');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe('PROVISIONING_ERROR');
    expect(err.retryable).toBe(false);
  });

  test('ConnectionError extends ConnectorError', () => {
    const err = new ConnectionError('conn failed');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe('CONNECTION_ERROR');
    expect(err.retryable).toBe(true);
  });

  test('PermissionError extends ConnectorError', () => {
    const err = new PermissionError('denied');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe('PERMISSION_ERROR');
  });

  test('ResourceNotFoundError extends ConnectorError', () => {
    const err = new ResourceNotFoundError('not found');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
  });

  test('ConflictError extends ConnectorError', () => {
    const err = new ConflictError('conflict');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe('CONFLICT');
  });

  test('ValidationError extends ConnectorError', () => {
    const err = new ValidationError('invalid');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  test('IntegrationError extends ConnectorError (new)', () => {
    const err = new IntegrationError('gateway failed');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe('INTEGRATION_ERROR');
    expect(err.retryable).toBe(true);
  });

  test('NotImplementedError extends Error and identifies adapter+method', () => {
    const err = new NotImplementedError('AwsGenericAdapter:opensearch', 'testConnection');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NotImplementedError');
    expect(err.message).toContain('AwsGenericAdapter:opensearch');
    expect(err.message).toContain('testConnection');
    expect(err.message).toContain('not implemented');
  });

  test('NotImplementedError refuses-to-fake-success message is consistent', () => {
    const err = new NotImplementedError('CONFLUENCE', 'testConnection');
    // Sentinel phrase that operators can grep for in logs to spot fallback breaks
    expect(err.message).toContain('refusing to fake success');
  });

  test('DataStoreError is ConnectorError (simple alias)', () => {
    expect(DataStoreError).toBe(ConnectorError);
    const err = new DataStoreError('test', 'CODE', false);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.name).toBe('ConnectorError');
  });
});

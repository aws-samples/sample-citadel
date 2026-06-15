import {
  DataStoreError,
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  ConflictError,
  ValidationError,
} from '../errors';

describe('DataStoreError hierarchy', () => {
  const errorClasses = [
    {
      Class: ProvisioningError,
      name: 'ProvisioningError',
      code: 'PROVISIONING_ERROR',
      retryable: false,
      make: (msg: string, cause?: Error) => new ProvisioningError(msg, cause),
    },
    {
      Class: ConnectionError,
      name: 'ConnectionError',
      code: 'CONNECTION_ERROR',
      retryable: true,
      make: (msg: string, cause?: Error) => new ConnectionError(msg, undefined, cause),
    },
    {
      Class: PermissionError,
      name: 'PermissionError',
      code: 'PERMISSION_ERROR',
      retryable: false,
      make: (msg: string, cause?: Error) => new PermissionError(msg, cause),
    },
    {
      Class: ResourceNotFoundError,
      name: 'ResourceNotFoundError',
      code: 'RESOURCE_NOT_FOUND',
      retryable: false,
      make: (msg: string, cause?: Error) => new ResourceNotFoundError(msg, cause),
    },
    {
      Class: ConflictError,
      name: 'ConflictError',
      code: 'CONFLICT',
      retryable: true,
      make: (msg: string, cause?: Error) => new ConflictError(msg, cause),
    },
    {
      Class: ValidationError,
      name: 'ValidationError',
      code: 'VALIDATION_ERROR',
      retryable: false,
      make: (msg: string) => new ValidationError(msg),
    },
  ];

  describe.each(errorClasses)('$name', ({ Class, name, code, retryable, make }) => {
    it('is instanceof DataStoreError', () => {
      expect(make('test')).toBeInstanceOf(DataStoreError);
    });

    it('is instanceof Error', () => {
      expect(make('test')).toBeInstanceOf(Error);
    });

    it(`has code "${code}"`, () => {
      expect(make('test').code).toBe(code);
    });

    it(`has retryable=${retryable}`, () => {
      expect(make('test').retryable).toBe(retryable);
    });

    it(`has name "${name}"`, () => {
      expect(make('test').name).toBe(name);
    });

    it('preserves the message', () => {
      expect(make('something went wrong').message).toBe('something went wrong');
    });
  });

  describe('cause property', () => {
    const original = new Error('root cause');

    it('ProvisioningError preserves cause', () => {
      expect(new ProvisioningError('fail', original).cause).toBe(original);
    });

    it('ConnectionError preserves cause', () => {
      expect(new ConnectionError('fail', true, original).cause).toBe(original);
    });

    it('PermissionError preserves cause', () => {
      expect(new PermissionError('fail', original).cause).toBe(original);
    });

    it('ResourceNotFoundError preserves cause', () => {
      expect(new ResourceNotFoundError('fail', original).cause).toBe(original);
    });

    it('ConflictError preserves cause', () => {
      expect(new ConflictError('fail', original).cause).toBe(original);
    });

    it('ValidationError has no cause', () => {
      expect(new ValidationError('fail').cause).toBeUndefined();
    });
  });

  describe('ConnectionError retryable override', () => {
    it('defaults to retryable=true', () => {
      expect(new ConnectionError('fail').retryable).toBe(true);
    });

    it('can be set to retryable=false', () => {
      expect(new ConnectionError('fail', false).retryable).toBe(false);
    });
  });

  describe('DataStoreError base class', () => {
    it('is an alias for ConnectorError', () => {
      const err = new DataStoreError('msg', 'CUSTOM', true);
      expect(err.name).toBe('ConnectorError');
    });

    it('is instanceof Error', () => {
      expect(new DataStoreError('msg', 'CUSTOM', false)).toBeInstanceOf(Error);
    });
  });
});

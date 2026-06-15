import * as fc from 'fast-check';
import {
  DataStoreType,
  DataStoreProvisionMode,
  DATA_STORE_TYPE_META,
} from '../datastoreService';

// Feature: datastore-adapter-pattern, Property 17: DATA_STORE_TYPE_META covers all DataStoreType values
// **Validates: Requirements 13.2**
describe('Property 17: DATA_STORE_TYPE_META covers all DataStoreType values', () => {
  const allTypes = Object.values(DataStoreType);

  it('every DataStoreType has a corresponding entry in DATA_STORE_TYPE_META with required fields', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allTypes),
        (type: DataStoreType) => {
          const meta = DATA_STORE_TYPE_META[type];
          expect(meta).toBeDefined();
          expect(typeof meta.displayName).toBe('string');
          expect(meta.displayName.length).toBeGreaterThan(0);
          expect(typeof meta.icon).toBe('string');
          expect(meta.icon.length).toBeGreaterThan(0);
          expect(typeof meta.category).toBe('string');
          expect(meta.category.length).toBeGreaterThan(0);
          expect(typeof meta.provider).toBe('string');
          expect(meta.provider.length).toBeGreaterThan(0);
          expect(typeof meta.isAws).toBe('boolean');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: datastore-adapter-pattern, Property 18: Provision mode availability matches isAws flag
// **Validates: Requirements 14.2, 14.3**
describe('Property 18: Provision mode availability matches isAws flag', () => {
  const allTypes = Object.values(DataStoreType);

  it('AWS types support both CREATE_NEW and CONNECT_EXISTING; external types only support CONNECT_EXISTING', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allTypes),
        (type: DataStoreType) => {
          const meta = DATA_STORE_TYPE_META[type];
          if (meta.isAws) {
            // AWS types should support both provision modes
            const availableModes = [DataStoreProvisionMode.CREATE_NEW, DataStoreProvisionMode.CONNECT_EXISTING];
            expect(availableModes).toContain(DataStoreProvisionMode.CREATE_NEW);
            expect(availableModes).toContain(DataStoreProvisionMode.CONNECT_EXISTING);
          } else {
            // External types should only support CONNECT_EXISTING
            const availableModes = [DataStoreProvisionMode.CONNECT_EXISTING];
            expect(availableModes).toContain(DataStoreProvisionMode.CONNECT_EXISTING);
            expect(availableModes).not.toContain(DataStoreProvisionMode.CREATE_NEW);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all EXTERNAL_ prefixed types have isAws=false', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allTypes.filter(t => t.startsWith('EXTERNAL_'))),
        (type: DataStoreType) => {
          expect(DATA_STORE_TYPE_META[type].isAws).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all non-EXTERNAL_ types have isAws=true', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allTypes.filter(t => !t.startsWith('EXTERNAL_'))),
        (type: DataStoreType) => {
          expect(DATA_STORE_TYPE_META[type].isAws).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Verifies jest.config.cjs moduleNameMapper contains only the permanent alias.
 * Task 7.2: transitional versioned-import mappers must be removed.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('jest.config.cjs moduleNameMapper', () => {
  const configPath = path.resolve(__dirname, '../../jest.config.cjs');
  const configContent = fs.readFileSync(configPath, 'utf-8');

  it('does NOT contain transitional versioned-import mapper patterns', () => {
    // These patterns map versioned imports like `@radix-ui/react-dialog@1.2.3` → `@radix-ui/react-dialog`
    // They are no longer needed since Task 2 stripped all versioned imports from source.
    // Match lines containing `@[\\d.]+$` which is the versioned-import regex in moduleNameMapper
    const versionedPattern = /@\[\\\\d\.\]\+\$/;
    const lines = configContent.split('\n');
    const offendingLines = lines.filter(line => versionedPattern.test(line));
    expect(offendingLines).toEqual([]);
  });

  it('retains the permanent @/ path alias', () => {
    expect(configContent).toContain("'^@/(.*)$': '<rootDir>/src/$1'");
  });
});

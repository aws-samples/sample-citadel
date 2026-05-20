/**
 * Unit test: AppHeader placeholder styling
 *
 * Verifies that AppHeader.tsx does NOT contain a <style> tag and
 * uses the SearchInput component (which provides Tailwind `placeholder:` styling).
 *
 * Validates: Requirement 3.7, 7.6
 */
import * as fs from 'fs';
import * as path from 'path';

const APP_HEADER_PATH = path.resolve(__dirname, '..', 'AppHeader.tsx');
const source = fs.readFileSync(APP_HEADER_PATH, 'utf-8');

const SEARCH_INPUT_PATH = path.resolve(__dirname, '..', 'SearchInput.tsx');
const searchInputSource = fs.readFileSync(SEARCH_INPUT_PATH, 'utf-8');

describe('AppHeader placeholder styling (Requirement 3.7)', () => {
  it('does NOT contain a <style> tag', () => {
    // Match both <style> and <style ...> variants
    const styleTagPattern = /<style[\s>]/;
    expect(styleTagPattern.test(source)).toBe(false);
  });

  it('uses SearchInput component for search field', () => {
    expect(source).toContain('SearchInput');
  });

  it('SearchInput applies placeholder:text-muted class', () => {
    // The placeholder styling is now in the shared SearchInput component
    expect(searchInputSource).toContain('placeholder:text-muted');
  });
});

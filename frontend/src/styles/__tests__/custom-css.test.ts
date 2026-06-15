// Feature: ui-ux-remediation, Property 1: CSS variables use oklch format exclusively
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Property 1: CSS variables use oklch format exclusively
 *
 * For all CSS custom property values defined in both `:root` and `.dark` scopes
 * of `custom.css` that represent colors, the value SHALL match the `oklch(...)`
 * format pattern.
 *
 * Validates: Requirements 1.2
 */

// --- Helpers ---

/** Non-color CSS variable names that should be excluded from oklch validation */
const NON_COLOR_VARIABLES = new Set([
  '--font-size',
  '--font-weight-medium',
  '--font-weight-normal',
  '--radius',
]);

/** Values that are valid CSS color keywords but not oklch (excluded from check) */
const NON_OKLCH_COLOR_VALUES = new Set(['transparent']);

/** Regex to match oklch color format: oklch(L C H) with optional / alpha */
const OKLCH_PATTERN = /^oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+(?:\s*\/\s*[\d.]+%?)?\s*\)$/;

/** Read and return the custom.css file content */
function readCustomCss(): string {
  const cssPath = path.resolve(__dirname, '..', 'custom.css');
  return fs.readFileSync(cssPath, 'utf-8');
}

/**
 * Extract CSS custom property declarations from a scope block.
 * Returns array of { name, value } objects.
 */
function extractCssVariables(blockContent: string): Array<{ name: string; value: string }> {
  const declarations: Array<{ name: string; value: string }> = [];
  const regex = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(blockContent)) !== null) {
    declarations.push({
      name: match[1].trim(),
      value: match[2].trim(),
    });
  }
  return declarations;
}

/**
 * Extract the content of a CSS scope block (:root or .dark).
 * Returns the content between the opening { and closing }.
 */
function extractScopeBlock(css: string, scopeSelector: string): string {
  const escapedSelector = scopeSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`, 's');
  const match = regex.exec(css);
  return match ? match[1] : '';
}

/**
 * Filter to only color variables (exclude non-color variables and non-oklch color keywords).
 */
function filterColorVariables(
  vars: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  return vars.filter(
    (v) => !NON_COLOR_VARIABLES.has(v.name) && !NON_OKLCH_COLOR_VALUES.has(v.value),
  );
}

// --- Parse CSS once ---

const cssContent = readCustomCss();
const rootBlock = extractScopeBlock(cssContent, ':root');
const darkBlock = extractScopeBlock(cssContent, '.dark');

const rootColorVars = filterColorVariables(extractCssVariables(rootBlock));
const darkColorVars = filterColorVariables(extractCssVariables(darkBlock));

// Combine all color variables from both scopes with scope label
const allColorVars = [
  ...rootColorVars.map((v) => ({ ...v, scope: ':root' as const })),
  ...darkColorVars.map((v) => ({ ...v, scope: '.dark' as const })),
];

// --- Shared token definitions ---

/** Legacy tokens that have been removed in favour of shadcn equivalents */
const REMOVED_LEGACY_TOKENS = [
  '--surface-0',
  '--surface-1',
  '--surface-2',
  '--border-subtle',
  '--border-default',
  '--border-strong',
  '--text-heading',
  '--text-body',
  '--text-subtle',
] as const;

const REMOVED_THEME_INLINE_MAPPINGS = [
  '--color-surface-0',
  '--color-surface-1',
  '--color-surface-2',
  '--color-border-subtle',
  '--color-border-default',
  '--color-border-strong',
  '--color-text-heading',
  '--color-text-body',
  '--color-text-subtle',
] as const;

/** shadcn core tokens that must remain */
const SHADCN_CORE_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--primary',
  '--muted',
  '--accent',
  '--border',
  '--input',
] as const;

// --- Tests ---

describe('Property 1: CSS variables use oklch format exclusively', () => {
  it('should find color variables in both :root and .dark scopes', () => {
    expect(rootColorVars.length).toBeGreaterThan(0);
    expect(darkColorVars.length).toBeGreaterThan(0);
  });

  it('all color CSS variables use oklch format exclusively', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allColorVars),
        ({ name, value, scope }) => {
          const matches = OKLCH_PATTERN.test(value);
          if (!matches) {
            throw new Error(
              `${scope} variable ${name} has non-oklch value: "${value}"`,
            );
          }
          return true;
        },
      ),
      { numRuns: Math.max(100, allColorVars.length * 3) },
    );
  });
});


describe('Unit: Design token system (post-migration)', () => {
  describe('Legacy tokens are absent from :root', () => {
    it.each(REMOVED_LEGACY_TOKENS)('%s is NOT defined in :root scope', (token) => {
      const regex = new RegExp(`${token}\\s*:`);
      expect(rootBlock).not.toMatch(regex);
    });
  });

  describe('Legacy tokens are absent from .dark scope', () => {
    it.each(REMOVED_LEGACY_TOKENS)('%s is NOT defined in .dark scope', (token) => {
      const regex = new RegExp(`${token}\\s*:`);
      expect(darkBlock).not.toMatch(regex);
    });
  });

  describe('Legacy @theme inline mappings are absent', () => {
    const themeBlock = (() => {
      const match = /@theme\s+inline\s*\{([\s\S]*?)\n\}/s.exec(cssContent);
      return match ? match[1] : '';
    })();

    it('should find the @theme inline block', () => {
      expect(themeBlock.length).toBeGreaterThan(0);
    });

    it.each(REMOVED_THEME_INLINE_MAPPINGS)('%s is NOT in @theme inline', (mapping) => {
      const regex = new RegExp(`${mapping.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
      expect(themeBlock).not.toMatch(regex);
    });
  });

  describe('shadcn core tokens remain in :root', () => {
    it.each(SHADCN_CORE_TOKENS)('%s is defined in :root scope', (token) => {
      const regex = new RegExp(`${token}\\s*:`);
      expect(rootBlock).toMatch(regex);
    });
  });

  describe('Documentation comment block', () => {
    it('contains "shadcn-compliant" in documentation header', () => {
      expect(cssContent).toContain('shadcn-compliant');
    });
  });
});

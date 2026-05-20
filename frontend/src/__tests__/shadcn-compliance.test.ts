import * as fs from 'fs';
import * as path from 'path';

/**
 * Frontend shadcn-compliance guards.
 *
 * These guards codify the rules enforced by the app's dark-only shadcn theme:
 *
 *  1. No `bg-white` paired with `text-foreground` — --foreground is near-white
 *     (oklch(0.985 0 0)) so the text would be invisible on a white chip.
 *  2. No `bg-white` paired with `text-black` — non-shadcn pairing; use the
 *     canonical `bg-primary` / `text-primary-foreground` instead.
 *  3. No solid `bg-white` as a fill in non-ui/ code (it's always wrong in the
 *     dark theme). `bg-white/N` opacity overlays are allowed for now.
 *  4. No hex colour literals in `style={{ ... }}` props — use CSS variables
 *     referencing shadcn tokens instead.
 *  5. No duplicate `className` attributes on a single JSX element (the second
 *     silently overrides the first, dropping styling).
 */

const SRC_DIR = path.resolve(__dirname, '..');
const EXCLUDE_DIRS = new Set(['ui', '__tests__', 'node_modules']);
const EXTS = ['.ts', '.tsx'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (EXTS.some((ext) => entry.name.endsWith(ext))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const sourceFiles = walk(SRC_DIR);

function findViolations(matcher: (src: string) => boolean): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles) {
    const src = fs.readFileSync(file, 'utf-8');
    if (matcher(src)) hits.push(path.relative(SRC_DIR, file));
  }
  return hits;
}

describe('shadcn-compliance: contrast + tokens', () => {
  test('no bg-white + text-foreground pairing on same element', () => {
    const re = /className=(?:"[^"]*|\{`[^`]*|\{[^}]*["'`][^"'`]*)(?:bg-white(?!\/)[^"'`}]*text-foreground|text-foreground[^"'`]*bg-white(?!\/))/;
    expect(findViolations((s) => re.test(s))).toEqual([]);
  });

  test('no bg-white + text-black pairing (use bg-primary + text-primary-foreground)', () => {
    const re = /bg-white(?!\/)[^"'`}]*text-black|text-black[^"'`}]*bg-white(?!\/)/;
    expect(findViolations((s) => re.test(s))).toEqual([]);
  });

  test('no solid bg-white (fill) in non-ui code — use bg-card/bg-background/bg-primary', () => {
    // Matches `bg-white` NOT followed by `/` (which would be an opacity overlay).
    const re = /\bbg-white(?!\/)\b/;
    expect(findViolations((s) => re.test(s))).toEqual([]);
  });

  test('no hex colour literals in JSX style props (brand gradients exempted)', () => {
    // Matches `style={{...}}` OR `[A-Za-z]*Style={{...}}` (e.g. Recharts `contentStyle`).
    // Object literal content cannot contain `{` or `}` before closing `}}`.
    const re = /\b[A-Za-z]*[sS]tyle=\{\{[^{}]*#[0-9a-fA-F]{3,8}\b[^{}]*\}\}/;
    // Allow hex inside linear-gradient(...) — brand-gradient documented exception.
    const hits = findViolations((s) => {
      const m = s.match(re);
      if (!m) return false;
      // If every match is inside a linear-gradient(), treat as exempt.
      const all = s.match(new RegExp(re.source, 'g')) ?? [];
      return all.some((seg) => !/linear-gradient\s*\(/.test(seg));
    });
    expect(hits).toEqual([]);
  });

  test('no duplicate className attribute on a single JSX element', () => {
    // Multi-line JSX: use dotall `s` flag so `.` matches newlines, constrain
    // to a single element by excluding `<` (next tag) and `>` (end of tag).
    const re = /<[A-Za-z][A-Za-z0-9]*\b(?:[^<>]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*?\bclassName=(?:"[^"]*"|\{[^{}]*\})(?:[^<>]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*?\bclassName=/s;
    expect(findViolations((s) => re.test(s))).toEqual([]);
  });
});

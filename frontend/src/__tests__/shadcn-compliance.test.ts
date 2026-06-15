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

/**
 * Walk through `<` tokens; for each opening JSX tag, count `className=`
 * occurrences. Linear scan — replaces a regex with nested quantifiers that
 * suffered from catastrophic backtracking.
 */
function findDuplicateClassNameElements(source: string): string[] {
  const offenders: string[] = [];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    // Skip closing tags, comments, fragments
    const next = source[lt + 1];
    if (next === '/' || next === '!' || next === '>' || next === undefined) {
      i = lt + 1;
      continue;
    }
    // Only treat as a JSX tag if next char looks like an identifier start.
    if (!/[A-Za-z]/.test(next)) {
      i = lt + 1;
      continue;
    }
    const tagEnd = findTagEnd(source, lt);
    if (tagEnd < 0) break;
    const tagBody = source.slice(lt, tagEnd + 1);
    let count = 0;
    let j = 0;
    while ((j = tagBody.indexOf('className=', j)) !== -1) {
      count++;
      j += 'className='.length;
    }
    if (count > 1) {
      offenders.push(tagBody.slice(0, 80));
    }
    i = tagEnd + 1;
  }
  return offenders;
}

/**
 * Find the index of the `>` that closes the opening JSX tag starting at
 * `start`. Skips `>` characters inside string literals, template literals,
 * and `{...}` expression containers.
 */
function findTagEnd(source: string, start: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    const prev = source[i - 1];
    if (inSingle) {
      if (c === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (c === '`' && prev !== '\\') inTemplate = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
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
    // Linear string scan replaces a regex with nested quantifiers
    // (`(?:...*)*?`) that caused catastrophic backtracking on long files.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const src = fs.readFileSync(file, 'utf-8');
      if (findDuplicateClassNameElements(src).length > 0) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('shadcn-compliance: codemod guards', () => {
  test('no raw <button> elements in application code', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.match(/<button[\s>]/g);
      if (matches) {
        violations.push(`${path.relative(SRC_DIR, file)}: ${matches.length} raw <button> found`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('no raw <input>/<select>/<textarea> in application code (excl. file/hidden/range)', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        // Skip obvious comment lines (JSDoc/block/line) — best-effort, mirrors
        // the spirit of the alert() guard below. Avoids false positives from
        // JSDoc examples like `<input type="datetime-local">`.
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          return;
        }
        // Allow type="file"/"hidden"/"range" inputs (no shadcn equivalent)
        if (
          /<input[\s>]/.test(line) &&
          !/type=["'](?:file|hidden|range)["']/.test(line)
        ) {
          violations.push(`${path.relative(SRC_DIR, file)}:${idx + 1}: raw <input>`);
        }
        if (/<select[\s>]/.test(line)) {
          violations.push(`${path.relative(SRC_DIR, file)}:${idx + 1}: raw <select>`);
        }
        if (/<textarea[\s>]/.test(line)) {
          violations.push(`${path.relative(SRC_DIR, file)}:${idx + 1}: raw <textarea>`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  test('no alert() calls in application code', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      // Best-effort: regex match — does not parse JSDoc/strings, but app code
      // should never have a literal `alert(` for any reason. Use sonner toasts.
      const matches = content.match(/\balert\(/g);
      if (matches) {
        violations.push(`${path.relative(SRC_DIR, file)}: ${matches.length} alert() call(s)`);
      }
    }
    expect(violations).toEqual([]);
  });
});

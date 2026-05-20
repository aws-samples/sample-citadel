// Feature: ui-ux-remediation, Property 3: Design token round-trip — token resolves to original color
import * as fc from 'fast-check';

/**
 * Property 3: Design token round-trip — token resolves to original color
 *
 * For all design token mappings (e.g. `--surface-0` replacing `#0a0a0a`),
 * resolving the CSS variable through the `@theme` directive to its computed
 * oklch value and converting to hex SHALL produce a color perceptually
 * equivalent to the original hardcoded hex value.
 *
 * Validates: Requirements 2.5
 */

// --- Token-to-hex mapping from design.md ---

interface TokenMapping {
  token: string;
  oklchValue: string;
  oklchL: number;
  originalHexValues: string[];
}

const TOKEN_MAPPINGS: TokenMapping[] = [
  { token: '--surface-0', oklchValue: 'oklch(0.145 0 0)', oklchL: 0.145, originalHexValues: ['#000000', '#0a0a0a'] },
  { token: '--surface-1', oklchValue: 'oklch(0.178 0 0)', oklchL: 0.178, originalHexValues: ['#0f0f0f', '#0f1419', '#111111'] },
  { token: '--surface-2', oklchValue: 'oklch(0.215 0 0)', oklchL: 0.215, originalHexValues: ['#1a1a1a'] },
  { token: '--border-subtle', oklchValue: 'oklch(0.22 0 0)', oklchL: 0.22, originalHexValues: ['#1f1f1f'] },
  { token: '--border-default', oklchValue: 'oklch(0.27 0 0)', oklchL: 0.27, originalHexValues: ['#2a2a2a'] },
  { token: '--border-strong', oklchValue: 'oklch(0.35 0 0)', oklchL: 0.35, originalHexValues: ['#3a3a3a'] },
  { token: '--text-primary', oklchValue: 'oklch(0.985 0 0)', oklchL: 0.985, originalHexValues: ['#ffffff'] },
  { token: '--text-secondary', oklchValue: 'oklch(0.708 0 0)', oklchL: 0.708, originalHexValues: ['#9ca3af', '#8b8b8b'] },
  { token: '--text-muted', oklchValue: 'oklch(0.556 0 0)', oklchL: 0.556, originalHexValues: ['#6b7280', '#687078'] },
];

// --- Color conversion helpers ---

/**
 * Convert OKLab L (lightness) to linear sRGB for achromatic colors (a=0, b=0).
 * For achromatic oklch (chroma=0), OKLab a=0, b=0, so l=m=s in LMS space.
 *
 * The OKLab → LMS cube root mapping for achromatic: l = m = s = L
 * Then LMS → linear sRGB: since l=m=s, the matrix multiplication simplifies.
 */
function oklchLToLinearSrgb(L: number): number {
  // For achromatic colors in OKLab: l_ = m_ = s_ = L (the lightness)
  // Cube to get LMS: l = L^3, m = L^3, s = L^3
  const lms = L * L * L;

  // LMS to linear sRGB matrix (first row, since R=G=B for achromatic):
  // R_lin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  // For achromatic: R_lin = (4.0767416621 - 3.3077115913 + 0.2309699292) * lms = 1.0 * lms
  return lms;
}

/**
 * Apply sRGB gamma correction (linear → sRGB transfer function).
 */
function linearToSrgb(c: number): number {
  if (c <= 0.0031308) {
    return 12.92 * c;
  }
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Convert an achromatic oklch value (chroma=0) to a hex color string.
 */
function oklchToHex(L: number): string {
  const linear = oklchLToLinearSrgb(L);
  const srgb = linearToSrgb(Math.max(0, Math.min(1, linear)));
  const byte = Math.round(srgb * 255);
  const clamped = Math.max(0, Math.min(255, byte));
  const hex = clamped.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

/**
 * Parse a hex color string to RGB values.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

/**
 * Compute Euclidean distance in RGB space between two hex colors.
 * This is a simple perceptual distance metric — not as accurate as CIEDE2000,
 * but sufficient for verifying that token replacements are in the same
 * perceptual neighborhood as the originals.
 */
function rgbDistance(hex1: string, hex2: string): number {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  return Math.sqrt(
    (c1.r - c2.r) ** 2 +
    (c1.g - c2.g) ** 2 +
    (c1.b - c2.b) ** 2,
  );
}

// --- Tests ---

describe('Property 3: Design token round-trip — token resolves to original color', () => {
  // Sanity: we have mappings to test
  it('should have token mappings defined', () => {
    expect(TOKEN_MAPPINGS.length).toBeGreaterThan(0);
  });

  it('oklch token value converts to hex perceptually equivalent to each original hex value', () => {
    // Max Euclidean RGB distance for perceptual equivalence.
    // Some original hex values have slight chromatic tints (e.g. #9ca3af has a blue tint)
    // that the design intentionally neutralized to achromatic oklch tokens.
    // Some tokens are compromise values replacing multiple hex values (e.g. oklch(0.708 0 0)
    // replaces both #9ca3af and #8b8b8b), so the distance to any single original can be larger.
    // A threshold of 40 (~9% of max RGB distance 441) accommodates these deliberate shifts.
    const MAX_RGB_DISTANCE = 40;

    fc.assert(
      fc.property(
        fc.constantFrom(...TOKEN_MAPPINGS),
        (mapping: TokenMapping) => {
          const computedHex = oklchToHex(mapping.oklchL);

          for (const originalHex of mapping.originalHexValues) {
            const distance = rgbDistance(computedHex, originalHex);
            if (distance > MAX_RGB_DISTANCE) {
              const computed = hexToRgb(computedHex);
              const original = hexToRgb(originalHex);
              throw new Error(
                `Token ${mapping.token} (${mapping.oklchValue}) → ${computedHex} ` +
                `(rgb ${computed.r},${computed.g},${computed.b}) is NOT perceptually close to ` +
                `original ${originalHex} (rgb ${original.r},${original.g},${original.b}). ` +
                `RGB distance: ${distance.toFixed(2)} (max: ${MAX_RGB_DISTANCE})`,
              );
            }
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

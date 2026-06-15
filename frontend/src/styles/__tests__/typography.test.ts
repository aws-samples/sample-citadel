// Unit tests for typography setup
// Validates: Requirements 5.1, 5.2, 5.4
import * as fs from 'fs';
import * as path from 'path';

/** Read index.html content */
function readIndexHtml(): string {
  const htmlPath = path.resolve(__dirname, '..', '..', '..', 'index.html');
  return fs.readFileSync(htmlPath, 'utf-8');
}

/** Read custom.css content */
function readCustomCss(): string {
  const cssPath = path.resolve(__dirname, '..', 'custom.css');
  return fs.readFileSync(cssPath, 'utf-8');
}

const indexHtml = readIndexHtml();
const customCss = readCustomCss();

describe('Unit: Typography setup', () => {
  describe('Requirement 5.1 — Google Fonts link in index.html', () => {
    it('contains a <link> tag with fonts.googleapis.com and Plus+Jakarta+Sans', () => {
      expect(indexHtml).toMatch(/<link[^>]+fonts\.googleapis\.com[^>]+Plus\+Jakarta\+Sans/);
    });

    it('contains font weights 400, 500, 600, 700 in the Google Fonts URL', () => {
      const fontsLinkMatch = indexHtml.match(/<link[^>]+fonts\.googleapis\.com\/css2[^>]+>/);
      expect(fontsLinkMatch).not.toBeNull();
      const fontsLink = fontsLinkMatch![0];
      expect(fontsLink).toContain('400');
      expect(fontsLink).toContain('500');
      expect(fontsLink).toContain('600');
      expect(fontsLink).toContain('700');
    });
  });

  describe('Requirement 5.4 — font-display: swap', () => {
    it('contains display=swap in the Google Fonts URL', () => {
      expect(indexHtml).toMatch(/fonts\.googleapis\.com[^"]*display=swap/);
    });
  });

  describe('Requirement 5.1 — preconnect links', () => {
    it('contains preconnect link for fonts.googleapis.com', () => {
      expect(indexHtml).toMatch(/<link[^>]+rel="preconnect"[^>]+fonts\.googleapis\.com/);
    });

    it('contains preconnect link for fonts.gstatic.com', () => {
      expect(indexHtml).toMatch(/<link[^>]+rel="preconnect"[^>]+fonts\.gstatic\.com/);
    });
  });

  describe('Requirement 5.2 — Tailwind fontFamily configuration', () => {
    it('contains --font-sans with Plus Jakarta Sans in custom.css', () => {
      expect(customCss).toMatch(/--font-sans\s*:.*Plus Jakarta Sans/);
    });

    it('contains system font fallbacks (ui-sans-serif, system-ui)', () => {
      const fontSansMatch = customCss.match(/--font-sans\s*:[^;]+;/);
      expect(fontSansMatch).not.toBeNull();
      const fontSansValue = fontSansMatch![0];
      expect(fontSansValue).toContain('ui-sans-serif');
      expect(fontSansValue).toContain('system-ui');
    });
  });
});

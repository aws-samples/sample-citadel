// Feature: ui-ux-remediation, Property 5: All pages wrapped in PageContainer
// Feature: ui-ux-remediation, Property 6: PageContainer idempotence
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PageContainer } from '../PageContainer';

/**
 * Property 5: All pages wrapped in PageContainer
 *
 * For all page components (Dashboard, IntakeRequests, AgentApps, AgentCatalog,
 * Integrations, DataStores, Team, AgentTools, AppDetailView), rendering the page
 * SHALL produce a DOM tree containing a PageContainer wrapper element with
 * consistent padding classes.
 *
 * Validates: Requirements 6.4
 *
 * Implementation: Source-level verification — each page file must import
 * PageContainer and use <PageContainer in its JSX.
 */

// --- Helpers for Property 5 ---

const PAGE_FILES = [
  { name: 'Dashboard', file: 'Dashboard.tsx' },
  { name: 'IntakeRequests', file: 'IntakeRequests.tsx' },
  { name: 'AgentApps', file: 'AgentApps.tsx' },
  { name: 'AgentCatalog', file: 'AgentCatalog.tsx' },
  { name: 'Integrations', file: 'Integrations.tsx' },
  { name: 'DataStores', file: 'DataStores.tsx' },
  { name: 'Team', file: 'Team.tsx' },
  { name: 'AgentTools', file: 'AgentTools.tsx' },
  { name: 'AppDetailView', file: 'AppDetailView.tsx' },
] as const;

const PAGES_DIR = path.resolve(__dirname, '..', '..', 'pages');

function readPageSource(fileName: string): string {
  return fs.readFileSync(path.join(PAGES_DIR, fileName), 'utf-8');
}

/** Check that a page source file imports PageContainer */
function importsPageContainer(source: string): boolean {
  return /import\s+\{[^}]*PageContainer[^}]*\}\s+from/.test(source);
}

/** Check that a page source file uses <PageContainer in JSX */
function usesPageContainerJsx(source: string): boolean {
  return /<PageContainer[\s>]/.test(source);
}

// Pre-read all page sources once
const pageSources = PAGE_FILES.map((p) => ({
  ...p,
  source: readPageSource(p.file),
}));

// --- Property 5 Tests ---

describe('Property 5: All pages wrapped in PageContainer', () => {
  it('should have page source files to test', () => {
    expect(pageSources.length).toBe(9);
  });

  it('all page components import and use PageContainer', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...pageSources),
        ({ name, file, source }) => {
          if (!importsPageContainer(source)) {
            throw new Error(
              `${name} (${file}) does not import PageContainer`,
            );
          }
          if (!usesPageContainerJsx(source)) {
            throw new Error(
              `${name} (${file}) does not use <PageContainer in JSX`,
            );
          }
          return true;
        },
      ),
      { numRuns: Math.max(100, pageSources.length * 12) },
    );
  });
});


/**
 * Property 6: PageContainer idempotence
 *
 * For any React children content, wrapping it in PageContainer once and wrapping
 * it in PageContainer twice SHALL produce the same rendered padding value on the
 * outermost container.
 *
 * Validates: Requirements 6.6
 */

describe('Property 6: PageContainer idempotence', () => {
  it('wrapping once and wrapping twice produce the same outermost padding classes', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (childText) => {
          // Single wrap
          const single = render(
            <PageContainer>
              <span>{childText}</span>
            </PageContainer>,
          );
          const singleContainer = single.container.firstElementChild as HTMLElement;
          const singleClasses = singleContainer.className;

          single.unmount();

          // Double wrap
          const double = render(
            <PageContainer>
              <PageContainer>
                <span>{childText}</span>
              </PageContainer>
            </PageContainer>,
          );
          const doubleContainer = double.container.firstElementChild as HTMLElement;
          const doubleClasses = doubleContainer.className;

          double.unmount();

          // The outermost container should have the same padding classes
          // PageContainer applies 'p-4 overflow-y-auto h-full' — these must match
          const paddingPattern = /\bp-4\b/;
          const singleHasPadding = paddingPattern.test(singleClasses);
          const doubleHasPadding = paddingPattern.test(doubleClasses);

          if (!singleHasPadding) {
            throw new Error(
              `Single-wrapped PageContainer missing p-4 class. Classes: "${singleClasses}"`,
            );
          }
          if (!doubleHasPadding) {
            throw new Error(
              `Double-wrapped outermost PageContainer missing p-4 class. Classes: "${doubleClasses}"`,
            );
          }

          // The outermost container classes should be identical
          if (singleClasses !== doubleClasses) {
            throw new Error(
              `Outermost container classes differ.\n  Single: "${singleClasses}"\n  Double: "${doubleClasses}"`,
            );
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * monacoSetup self-hosting contract: the module exposes the locally bundled
 * monaco-editor namespace and routes web workers to the app's own bundle.
 * It must not go through @monaco-editor/loader, whose default config
 * hardcodes a jsdelivr CDN path.
 *
 * monaco-editor's package.json resolves `require()` to its AMD bundle
 * (min/vs/index.js), which errors outside an AMD loader. Vite (the real
 * build) resolves the ESM entry instead, so this mismatch is a Jest/CJS
 * environment artifact, not a production concern. monaco-editor is
 * mocked here to a stable sentinel object so the test can assert
 * reference identity without depending on CJS/ESM resolution behavior.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const monacoSentinel = { editor: {}, languages: {} };
const mockWorkerCreated = jest.fn();

class MockEditorWorker {
  constructor() {
    mockWorkerCreated();
  }
}

jest.mock('monaco-editor/editor/editor.api', () => monacoSentinel);

jest.mock(
  'monaco-editor/editor/editor.worker.js?worker',
  () => ({ __esModule: true, default: MockEditorWorker }),
  { virtual: true }
);

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const fullPath = join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      return name === '__tests__' ? [] : collectSourceFiles(fullPath);
    }
    return /\.(ts|tsx)$/.test(name) ? [fullPath] : [];
  });

describe('monacoSetup', () => {
  it('exports the locally imported monaco-editor namespace', async () => {
    const setup = await import('../monacoSetup');

    expect(setup.monaco.editor).toBe(monacoSentinel.editor);
    expect(setup.monaco.languages).toBe(monacoSentinel.languages);
  });

  it('routes every worker request to the bundled editor worker', async () => {
    await import('../monacoSetup');
    const environment = (self as unknown as {
      MonacoEnvironment: { getWorker: (workerId: string, label: string) => unknown };
    }).MonacoEnvironment;

    expect(environment.getWorker('1', 'python')).toBeInstanceOf(MockEditorWorker);
    expect(mockWorkerCreated).toHaveBeenCalledTimes(1);
  });

  it('no application source imports an @monaco-editor package', () => {
    const srcRoot = join(__dirname, '..', '..');
    const offenders = collectSourceFiles(srcRoot).filter((filePath) =>
      /from\s+['"]@monaco-editor\//.test(readFileSync(filePath, 'utf8'))
    );

    expect(offenders).toEqual([]);
  });
});

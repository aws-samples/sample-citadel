/**
 * monacoSetup self-hosting contract: loader.config must be called with
 * the locally bundled monaco-editor module, so @monaco-editor/react never
 * falls back to fetching monaco from the jsdelivr CDN.
 *
 * monaco-editor's package.json resolves `require()` to its AMD bundle
 * (min/vs/index.js), which errors outside an AMD loader. Vite (the real
 * build) resolves the ESM entry instead, so this mismatch is a Jest/CJS
 * environment artifact, not a production concern. monaco-editor is
 * mocked here to a stable sentinel object so the test can assert
 * reference identity without depending on CJS/ESM resolution behavior.
 */
const configMock = jest.fn();
const monacoSentinel = { editor: {}, languages: {} };

jest.mock('@monaco-editor/react', () => ({
  loader: { config: configMock },
}));

jest.mock('monaco-editor/editor/editor.api', () => monacoSentinel);

jest.mock('monaco-editor/editor/editor.worker.js?worker', () => {
  return { default: jest.fn() };
}, { virtual: true });

describe('monacoSetup', () => {
  it('configures the monaco loader with the locally imported monaco-editor module', async () => {
    await import('../monacoSetup');

    expect(configMock).toHaveBeenCalledTimes(1);
    const callArg = configMock.mock.calls[0][0];
    expect(callArg.monaco.editor).toBe(monacoSentinel.editor);
    expect(callArg.monaco.languages).toBe(monacoSentinel.languages);
  });
});

import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

// Self-hosted Monaco setup. MonacoEditor.tsx creates editors straight from
// the locally bundled monaco-editor package (no @monaco-editor/loader, whose
// default config hardcodes a jsdelivr CDN path), and this module wires
// MonacoEnvironment so the editor's web workers are served from this app's
// own bundle instead of being fetched remotely.
//
// Imports `editor.api` (core editor + languages namespace) rather than
// the `monaco-editor` package barrel, which eagerly registers all 60+
// built-in languages. AgentCode.tsx only edits Python and supplies its
// own Monarch tokenizer/language configuration via
// monaco.languages.setLanguageConfiguration /
// setMonarchTokensProvider — it needs the `languages` namespace to
// register that, not monaco-editor's built-in Python contribution.
//
// Python (like YAML) has no dedicated language worker in monaco-editor;
// both are tokenized on the main thread via the generic editor worker,
// so only editor.worker is bundled here. Add the matching
// `?worker`-suffixed import (and a getWorker branch below) if a
// language with its own worker (typescript, json, css, html) is ever
// used by this editor.
self.MonacoEnvironment = {
  getWorker(_workerId: string, _label: string) {
    return new EditorWorker();
  },
};

export { monaco };

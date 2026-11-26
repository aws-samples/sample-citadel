import React, { useEffect, useRef } from 'react';
import type { editor } from 'monaco-editor';
import { monaco } from './monacoSetup';

// Thin wrapper over the locally bundled monaco-editor package. It replaces
// @monaco-editor/react, whose loader embeds a jsdelivr default path and
// resolves monaco at runtime. Here the editor is created straight from the
// imported namespace, so nothing is fetched from a third-party host.
//
// This module (and therefore monaco) is meant to be loaded with
// React.lazy so the editor lands in its own chunk.

export type MonacoNamespace = typeof monaco;

interface MonacoEditorProps {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  options?: editor.IStandaloneEditorConstructionOptions;
  height?: string;
  theme?: string;
  onMount?: (editorInstance: editor.IStandaloneCodeEditor, monacoApi: MonacoNamespace) => void;
}

export const MonacoEditor: React.FC<MonacoEditorProps> = ({
  value,
  language,
  onChange,
  options,
  height = '100%',
  theme,
  onMount,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const applyingExternalValueRef = useRef(false);

  // Latest props for the create-once effect and its listener.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onMountRef = useRef(onMount);
  valueRef.current = value;
  onChangeRef.current = onChange;
  onMountRef.current = onMount;

  const initialRef = useRef({ language, theme, options });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }
    const initial = initialRef.current;
    const editorInstance = monaco.editor.create(host, {
      ...initial.options,
      value: valueRef.current,
      language: initial.language,
      theme: initial.theme,
    });
    editorRef.current = editorInstance;

    const contentListener = editorInstance.onDidChangeModelContent(() => {
      if (applyingExternalValueRef.current) {
        return;
      }
      onChangeRef.current?.(editorInstance.getValue());
    });

    onMountRef.current?.(editorInstance, monaco);

    return () => {
      contentListener.dispose();
      editorInstance.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance || editorInstance.getValue() === value) {
      return;
    }
    applyingExternalValueRef.current = true;
    try {
      editorInstance.setValue(value);
    } finally {
      applyingExternalValueRef.current = false;
    }
  }, [value]);

  const isFirstLanguageRef = useRef(true);
  useEffect(() => {
    if (isFirstLanguageRef.current) {
      isFirstLanguageRef.current = false;
      return;
    }
    const model = editorRef.current?.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [language]);

  const isFirstThemeRef = useRef(true);
  useEffect(() => {
    if (isFirstThemeRef.current) {
      isFirstThemeRef.current = false;
      return;
    }
    if (theme) {
      monaco.editor.setTheme(theme);
    }
  }, [theme]);

  const isFirstOptionsRef = useRef(true);
  useEffect(() => {
    if (isFirstOptionsRef.current) {
      isFirstOptionsRef.current = false;
      return;
    }
    if (options) {
      editorRef.current?.updateOptions(options);
    }
  }, [options]);

  return <div ref={hostRef} style={{ height, width: '100%' }} />;
};

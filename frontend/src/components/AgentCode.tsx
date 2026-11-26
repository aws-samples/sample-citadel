import React, { useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { Button } from './ui/button';

interface AgentCodeProps {
  isCreating: boolean;
  isEditing: boolean;
  agentCode: string;
  onCodeChange: (code: string) => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}

export const AgentCodeTab: React.FC<AgentCodeProps> = ({
  isCreating,
  isEditing,
  agentCode,
  onCodeChange,
  onStartEdit,
  onSave,
  onCancel,
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    // Update editor when code changes externally
    if (editorRef.current && editorRef.current.getValue() !== agentCode) {
      editorRef.current.setValue(agentCode);
    }
  }, [agentCode]);

  const handleEditorMount = (editor: editor.IStandaloneCodeEditor, monaco: any) => {
    editorRef.current = editor;
    
    // Configure Python language for better f-string support
    monaco.languages.setLanguageConfiguration('python', {
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')']
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
      ],
    });

    // Enhanced tokenizer for Python with f-string support
    monaco.languages.setMonarchTokensProvider('python', {
      defaultToken: '',
      tokenPostfix: '.python',
      
      keywords: [
        'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
        'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for',
        'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None',
        'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try',
        'while', 'with', 'yield'
      ],

      brackets: [
        { open: '{', close: '}', token: 'delimiter.curly' },
        { open: '[', close: ']', token: 'delimiter.bracket' },
        { open: '(', close: ')', token: 'delimiter.parenthesis' }
      ],

      tokenizer: {
        root: [
          { include: '@whitespace' },
          { include: '@numbers' },
          { include: '@strings' },
          
          [/[,:;]/, 'delimiter'],
          [/[{}\[\]()]/, '@brackets'],
          
          [/@[a-zA-Z_]\w*/, 'tag'],
          [/[a-zA-Z_]\w*/, {
            cases: {
              '@keywords': 'keyword',
              '@default': 'identifier'
            }
          }],
        ],

        whitespace: [
          [/\s+/, 'white'],
          [/(^#.*$)/, 'comment'],
        ],

        numbers: [
          [/0[xX][0-9a-fA-F]+/, 'number.hex'],
          [/0[oO][0-7]+/, 'number.octal'],
          [/0[bB][01]+/, 'number.binary'],
          [/\d+\.\d+([eE][\-+]?\d+)?/, 'number.float'],
          [/\d+/, 'number'],
        ],

        strings: [
          [/f"/, { token: 'string.quote', bracket: '@open', next: '@fstring_double' }],
          [/f'/, { token: 'string.quote', bracket: '@open', next: '@fstring_single' }],
          [/f"""/, { token: 'string.quote', bracket: '@open', next: '@string_triple_double' }],
          [/"""/, { token: 'string.quote', bracket: '@open', next: '@string_triple_double' }],
          [/'''/, { token: 'string.quote', bracket: '@open', next: '@string_triple_single' }],
          [/"/, { token: 'string.quote', bracket: '@open', next: '@string_double' }],
          [/'/, { token: 'string.quote', bracket: '@open', next: '@string_single' }],
        ],

        fstring_double: [
          [/[^\\"{]+/, 'string'],
          [/\{\{/, 'string'],
          [/\}\}/, 'string'],
          [/\{/, { token: 'delimiter.bracket', next: '@fstring_expression' }],
          [/\\./, 'string.escape'],
          [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
        ],

        fstring_single: [
          [/[^\\'{}]+/, 'string'],
          [/\{\{/, 'string'],
          [/\}\}/, 'string'],
          [/\{/, { token: 'delimiter.bracket', next: '@fstring_expression' }],
          [/\\./, 'string.escape'],
          [/'/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
        ],

        fstring_expression: [
          [/[^}]+/, 'identifier'],
          [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
        ],

        string_double: [
          [/[^\\"]+/, 'string'],
          [/\\./, 'string.escape'],
          [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
        ],

        string_single: [
          [/[^\\']+/, 'string'],
          [/\\./, 'string.escape'],
          [/'/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
        ],

        string_triple_double: [
          [/[^\\"]+/, 'string'],
          [/\\./, 'string.escape'],
          [/"""/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
        ],

        string_triple_single: [
          [/[^\\']+/, 'string'],
          [/\\./, 'string.escape'],
          [/'''/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
        ],
      },
    });
    
    // Set the value when editor mounts
    if (agentCode) {
      editor.setValue(agentCode);
    }
  };

  return (
    <div className="agent-code-editor">
      <div className="code-editor-header">
        <h3 className="config-section-title">Agent Code</h3>
        <div className="config-section-actions">
          {!isCreating && !isEditing && (
            <Button
              variant="outline"
              onClick={onStartEdit}
              className="border-border text-foreground hover:bg-accent"
              size="sm"
            >
              Edit
            </Button>
          )}
          {(isEditing || isCreating) && (
            <>
              <Button
                onClick={onSave}
                className="bg-chart-2 text-foreground hover:bg-chart-2"
                size="sm"
              >
                Save
              </Button>
              <Button
                variant="outline"
                onClick={onCancel}
                className="border-border text-foreground hover:bg-accent"
                size="sm"
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="monaco-editor-wrapper">
        <Editor
          height="650px"
          defaultLanguage="python"
          defaultValue={agentCode}
          onMount={handleEditorMount}
          onChange={(value) => onCodeChange(value || '')}
          theme="vs-dark"
          options={{
            readOnly: !isEditing && !isCreating,
            minimap: { enabled: true },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            wordWrap: 'on',
            formatOnPaste: true,
            formatOnType: true,
          }}
          loading={<div className="editor-loading">Loading editor...</div>}
        />
      </div>
    </div>
  );
};

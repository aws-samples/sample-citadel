/**
 * MonacoEditor wrapper contract: the editor is created from the locally
 * bundled monaco-editor namespace (exported by ../monacoSetup), never from
 * @monaco-editor/loader, so no CDN default path exists in the bundle.
 *
 * monaco-editor cannot be loaded under Jest/CJS (see monacoSetup.test.ts),
 * so ../monacoSetup is replaced with a fake monaco namespace whose
 * editor.create returns a recording fake editor.
 */
import { render } from '@testing-library/react';

const mockContentListeners: Array<() => void> = [];
const mockListenerDispose = jest.fn();
const mockEditorDispose = jest.fn();
let mockEditorValue = '';

const mockFakeModel = { id: 'fake-model' };
const mockFakeEditor = {
  getValue: jest.fn(() => mockEditorValue),
  setValue: jest.fn((next: string) => {
    mockEditorValue = next;
    mockContentListeners.forEach((listener) => listener());
  }),
  getModel: jest.fn(() => mockFakeModel),
  updateOptions: jest.fn(),
  onDidChangeModelContent: jest.fn((listener: () => void) => {
    mockContentListeners.push(listener);
    return { dispose: mockListenerDispose };
  }),
  dispose: mockEditorDispose,
};

const mockCreate = jest.fn((_container: HTMLElement, options: { value?: string }) => {
  mockEditorValue = options.value ?? '';
  return mockFakeEditor;
});
const mockSetModelLanguage = jest.fn();
const mockSetTheme = jest.fn();
const mockMonaco = {
  editor: {
    create: mockCreate,
    setModelLanguage: mockSetModelLanguage,
    setTheme: mockSetTheme,
  },
};

jest.mock('../monacoSetup', () => ({ monaco: mockMonaco }));

import { MonacoEditor } from '../MonacoEditor';

describe('MonacoEditor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentListeners.length = 0;
    mockEditorValue = '';
  });

  it('creates one editor in the container with value, language, theme and options', () => {
    const options = { fontSize: 14, readOnly: true };
    const { container } = render(
      <MonacoEditor value="print(1)" language="python" theme="vs-dark" options={options} />
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [host, createOptions] = mockCreate.mock.calls[0] as unknown as [
      HTMLElement,
      Record<string, unknown>,
    ];
    expect(host).toBe(container.firstChild);
    expect(createOptions).toMatchObject({
      value: 'print(1)',
      language: 'python',
      theme: 'vs-dark',
      fontSize: 14,
      readOnly: true,
    });
  });

  it('applies the height to the host element', () => {
    const { container } = render(<MonacoEditor value="" language="python" height="650px" />);

    expect((container.firstChild as HTMLElement).style.height).toBe('650px');
  });

  it('calls onMount with the editor and the monaco namespace', () => {
    const onMount = jest.fn();
    render(<MonacoEditor value="" language="python" onMount={onMount} />);

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onMount).toHaveBeenCalledWith(mockFakeEditor, mockMonaco);
  });

  it('reports the editor value through onChange when the user edits', () => {
    const onChange = jest.fn();
    render(<MonacoEditor value="a" language="python" onChange={onChange} />);

    mockEditorValue = 'ab';
    mockContentListeners.forEach((listener) => listener());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('ab');
  });

  it('syncs a changed value prop into the editor without echoing onChange', () => {
    const onChange = jest.fn();
    const { rerender } = render(<MonacoEditor value="a" language="python" onChange={onChange} />);

    rerender(<MonacoEditor value="b" language="python" onChange={onChange} />);

    expect(mockFakeEditor.setValue).toHaveBeenCalledWith('b');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not call setValue when the editor already holds the value', () => {
    const { rerender } = render(<MonacoEditor value="a" language="python" />);

    rerender(<MonacoEditor value="a" language="python" />);

    expect(mockFakeEditor.setValue).not.toHaveBeenCalled();
  });

  it('switches the model language when the language prop changes', () => {
    const { rerender } = render(<MonacoEditor value="" language="python" />);
    expect(mockSetModelLanguage).not.toHaveBeenCalled();

    rerender(<MonacoEditor value="" language="yaml" />);

    expect(mockSetModelLanguage).toHaveBeenCalledWith(mockFakeModel, 'yaml');
  });

  it('switches the theme when the theme prop changes', () => {
    const { rerender } = render(<MonacoEditor value="" language="python" theme="vs-dark" />);
    expect(mockSetTheme).not.toHaveBeenCalled();

    rerender(<MonacoEditor value="" language="python" theme="vs" />);

    expect(mockSetTheme).toHaveBeenCalledWith('vs');
  });

  it('pushes changed options (readOnly) into the live editor', () => {
    const { rerender } = render(
      <MonacoEditor value="" language="python" options={{ readOnly: true }} />
    );
    mockFakeEditor.updateOptions.mockClear();

    rerender(<MonacoEditor value="" language="python" options={{ readOnly: false }} />);

    expect(mockFakeEditor.updateOptions).toHaveBeenCalledWith({ readOnly: false });
  });

  it('does not recreate the editor on re-render', () => {
    const { rerender } = render(<MonacoEditor value="a" language="python" />);

    rerender(<MonacoEditor value="a" language="python" height="100px" />);

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('disposes the editor and its content listener on unmount', () => {
    const { unmount } = render(<MonacoEditor value="" language="python" />);

    unmount();

    expect(mockListenerDispose).toHaveBeenCalledTimes(1);
    expect(mockEditorDispose).toHaveBeenCalledTimes(1);
  });
});

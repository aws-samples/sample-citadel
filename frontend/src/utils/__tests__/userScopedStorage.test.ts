/**
 * userScopedStorage — key-building and sign-out clearing conventions.
 */
import {
  RUN_INPUT_PREFIX,
  WORKFLOW_AUTOSAVE_PREFIX,
  runInputStorageKey,
  workflowAutosaveStorageKey,
  clearSignedOutUserStorage,
} from '../userScopedStorage';

describe('userScopedStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('builds a run-input key scoped by both user and workflow', () => {
    expect(runInputStorageKey('user-a', 'wf-1')).toBe('citadel:run-input:user-a:wf-1');
  });

  it('builds distinct run-input keys for two different users on the same workflow', () => {
    const keyA = runInputStorageKey('user-a', 'wf-1');
    const keyB = runInputStorageKey('user-b', 'wf-1');
    expect(keyA).not.toBe(keyB);
  });

  it('builds a workflow-autosave key scoped by user', () => {
    expect(workflowAutosaveStorageKey('user-a')).toBe('workflow-autosave:user-a');
  });

  it('builds distinct autosave keys for two different users', () => {
    expect(workflowAutosaveStorageKey('user-a')).not.toBe(workflowAutosaveStorageKey('user-b'));
  });

  it('clearSignedOutUserStorage removes every citadel:run-input:* and workflow-autosave:* key', () => {
    localStorage.setItem(runInputStorageKey('user-a', 'wf-1'), '{"a":1}');
    localStorage.setItem(runInputStorageKey('user-b', 'wf-2'), '{"b":2}');
    localStorage.setItem(workflowAutosaveStorageKey('user-a'), '{"nodes":[]}');
    localStorage.setItem('unrelated-key', 'keep-me');

    clearSignedOutUserStorage();

    expect(localStorage.getItem(runInputStorageKey('user-a', 'wf-1'))).toBeNull();
    expect(localStorage.getItem(runInputStorageKey('user-b', 'wf-2'))).toBeNull();
    expect(localStorage.getItem(workflowAutosaveStorageKey('user-a'))).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('keep-me');
  });

  it('is a no-op when there is nothing under either prefix', () => {
    localStorage.setItem('unrelated-key', 'keep-me');
    expect(() => clearSignedOutUserStorage()).not.toThrow();
    expect(localStorage.getItem('unrelated-key')).toBe('keep-me');
  });

  it('prefix constants match the key builders', () => {
    expect(runInputStorageKey('u', 'w').startsWith(RUN_INPUT_PREFIX)).toBe(true);
    expect(workflowAutosaveStorageKey('u').startsWith(WORKFLOW_AUTOSAVE_PREFIX)).toBe(true);
  });
});

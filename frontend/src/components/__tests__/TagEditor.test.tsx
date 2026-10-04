/**
 * TagEditor unit tests — add/remove rows, required-key seeding, inline errors,
 * and format limit enforcement.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock Radix Select — it renders portals that jsdom can't handle well.
// Provide a minimal <select> that calls onValueChange.
jest.mock('../ui/select', () => {
  const React = require('react');
  return {
    Select: ({ value, onValueChange, children }: any) => {
      // Render a native <select> for test simplicity.
      return React.createElement(
        'select',
        {
          value,
          onChange: (e: any) => onValueChange(e.target.value),
          'data-testid': 'mock-select',
        },
        children,
      );
    },
    SelectTrigger: ({ children, ...props }: any) =>
      React.createElement('option', { disabled: true, ...props }, children),
    SelectContent: ({ children }: any) => children,
    SelectItem: ({ value, children }: any) =>
      React.createElement('option', { value }, children),
    SelectValue: ({ placeholder }: any) => placeholder ?? null,
  };
});

import { TagEditor, TagEditorProps } from '../TagEditor';
import type { TagPolicy } from '../../services/tagPolicyService';
import type { TagViolation } from '../../lib/tag-policy-errors';

function renderEditor(props: Partial<TagEditorProps> = {}) {
  const defaultProps: TagEditorProps = {
    value: {},
    onChange: jest.fn(),
    ...props,
  };
  return { ...render(<TagEditor {...defaultProps} />), onChange: defaultProps.onChange as jest.Mock };
}

describe('TagEditor', () => {
  describe('basic add / remove', () => {
    it('renders an empty state with an Add button', () => {
      renderEditor();
      expect(screen.getByTestId('tag-add')).toBeInTheDocument();
    });

    it('calls onChange with a new key when Add tag is clicked', () => {
      const { onChange } = renderEditor({ value: {} });
      fireEvent.click(screen.getByTestId('tag-add'));
      expect(onChange).toHaveBeenCalledWith({ key1: '' });
    });

    it('generates unique placeholder keys', () => {
      const { onChange } = renderEditor({ value: { key1: 'a' } });
      fireEvent.click(screen.getByTestId('tag-add'));
      expect(onChange).toHaveBeenCalledWith({ key1: 'a', key2: '' });
    });

    it('renders existing tags as rows', () => {
      renderEditor({ value: { env: 'prod', team: 'platform' } });
      expect(screen.getByTestId('tag-key-env')).toHaveValue('env');
      expect(screen.getByTestId('tag-value-env')).toHaveValue('prod');
      expect(screen.getByTestId('tag-key-team')).toHaveValue('team');
      expect(screen.getByTestId('tag-value-team')).toHaveValue('platform');
    });

    it('removes a tag when the remove button is clicked', () => {
      const { onChange } = renderEditor({ value: { env: 'prod', team: 'a' } });
      fireEvent.click(screen.getByTestId('tag-remove-env'));
      expect(onChange).toHaveBeenCalledWith({ team: 'a' });
    });

    it('updates a tag value', () => {
      const { onChange } = renderEditor({ value: { env: 'dev' } });
      fireEvent.change(screen.getByTestId('tag-value-env'), {
        target: { value: 'prod' },
      });
      expect(onChange).toHaveBeenCalledWith({ env: 'prod' });
    });
  });

  describe('policy — required key seeding', () => {
    const policy: TagPolicy = {
      requiredKeys: [
        { key: 'env', allowedValues: ['dev', 'staging', 'prod'] },
        { key: 'team', allowedValues: null },
      ],
      version: 1,
      updatedBy: 'admin',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    it('pre-seeds required keys even when value is empty', () => {
      renderEditor({ value: {}, policy });
      // Required keys rendered — key inputs are disabled
      const envKey = screen.getByTestId('tag-key-env');
      expect(envKey).toHaveValue('env');
      expect(envKey).toBeDisabled();

      const teamKey = screen.getByTestId('tag-key-team');
      expect(teamKey).toHaveValue('team');
      expect(teamKey).toBeDisabled();
    });

    it('renders a Select when allowedValues exist', () => {
      renderEditor({ value: { env: 'dev' }, policy });
      // The mocked Select renders a native <select>
      const selects = screen.getAllByTestId('mock-select');
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });

    it('renders a text Input when no allowedValues', () => {
      renderEditor({ value: { team: 'platform' }, policy });
      expect(screen.getByTestId('tag-value-team')).toBeInTheDocument();
    });

    it('does not show a remove button for required keys', () => {
      renderEditor({ value: { env: 'prod' }, policy });
      expect(screen.queryByTestId('tag-remove-env')).not.toBeInTheDocument();
    });

    it('shows missing-required warning when required keys are absent', () => {
      renderEditor({ value: {}, policy });
      expect(screen.getByTestId('missing-required')).toHaveTextContent(
        'Missing required tags: env, team',
      );
    });

    it('does not show missing-required warning when all required keys are present', () => {
      renderEditor({ value: { env: 'prod', team: 'infra' }, policy });
      expect(screen.queryByTestId('missing-required')).not.toBeInTheDocument();
    });
  });

  describe('inline errors from backend violations', () => {
    const violations: TagViolation[] = [
      { type: 'MISSING_KEY', key: 'env' },
      {
        type: 'INVALID_VALUE',
        key: 'team',
        suppliedValue: 'unknown-team',
        allowedValues: ['platform', 'data'],
      },
    ];

    it('renders inline error messages per key', () => {
      renderEditor({
        value: { env: '', team: 'unknown-team' },
        errors: violations,
      });

      expect(screen.getByTestId('tag-error-env')).toHaveTextContent(
        'Required key "env" is missing',
      );
      expect(screen.getByTestId('tag-error-team')).toHaveTextContent(
        'Invalid value "unknown-team" for key "team"',
      );
    });
  });

  describe('format limits', () => {
    it('disables Add button at 10 tags and shows limit message', () => {
      const tags: Record<string, string> = {};
      for (let i = 0; i < 10; i++) tags[`k${i}`] = `v${i}`;

      renderEditor({ value: tags });
      expect(screen.getByTestId('tag-add')).toBeDisabled();
      expect(screen.getByTestId('tag-limit-reached')).toHaveTextContent(
        'Maximum of 10 tags reached',
      );
    });

    it('does not disable Add button below 10 tags', () => {
      renderEditor({ value: { a: '1', b: '2' } });
      expect(screen.getByTestId('tag-add')).not.toBeDisabled();
    });
  });
});

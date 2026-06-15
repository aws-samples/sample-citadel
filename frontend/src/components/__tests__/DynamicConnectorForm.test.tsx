/**
 * DynamicConnectorForm — MCP_SERVER OAuth2 conditional rendering and validation.
 *
 * The form is built from `connectorRegistry` and supports:
 *   - API_KEY auth (apiKey field only).
 *   - OAUTH2 with grant types CLIENT_CREDENTIALS / AUTHORIZATION_CODE / TOKEN_EXCHANGE.
 *   - Optional `discoveryUrl` that hides `tokenUrl` and `authorizationUrl`.
 *   - Required `scopes` (>=1) on OAuth2.
 *   - Advanced (collapsible) `clientAuthenticationMethod` field.
 *
 * shadcn primitives that wrap Radix portals are flattened to native HTML so the
 * form is queryable without a real DOM portal.
 */

import React from 'react';
import {
  render,
  screen,
  act,
  fireEvent,
  cleanup,
} from '@testing-library/react';
import '@testing-library/jest-dom';

// Flatten shadcn Select to a native <select>.
jest.mock('../ui/select', () => {
  const ReactLib = require('react');
  return {
    Select: ({ value, onValueChange, children, disabled }: any) =>
      ReactLib.createElement(
        'select',
        {
          'data-testid': 'mock-select',
          value: value ?? '',
          disabled,
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      ),
    SelectTrigger: ({ children }: any) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    SelectItem: ({ children, value, ...rest }: any) =>
      ReactLib.createElement('option', { value, ...rest }, children),
  };
});

// Flatten shadcn Collapsible to a div + button.
jest.mock('../ui/collapsible', () => {
  const ReactLib = require('react');
  return {
    Collapsible: ({ children, open, ...rest }: any) =>
      ReactLib.createElement(
        'div',
        { 'data-open': open ? 'true' : 'false', ...rest },
        children,
      ),
    CollapsibleTrigger: ({ children, asChild: _asChild }: any) => {
      // The form passes a real <button> inside via `asChild`; render its child directly.
      const child = ReactLib.Children.only(children);
      return child;
    },
    CollapsibleContent: ({ children, ...rest }: any) =>
      ReactLib.createElement('div', { ...rest }, children),
  };
});

// Plain wrappers for Button / Input / Label / Textarea / Alert.
jest.mock('../ui/button', () => ({
  Button: ({ children, onClick, disabled, type, ...rest }: any) =>
    React.createElement(
      'button',
      { onClick, disabled, type: type ?? 'button', ...rest },
      children,
    ),
}));
jest.mock('../ui/input', () => ({
  Input: ({ onChange, value, type, ...rest }: any) =>
    React.createElement('input', { value, onChange, type: type ?? 'text', ...rest }),
}));
jest.mock('../ui/label', () => ({
  Label: ({ children, htmlFor, ...rest }: any) =>
    React.createElement('label', { htmlFor, ...rest }, children),
}));
jest.mock('../ui/textarea', () => ({
  Textarea: ({ onChange, value, ...rest }: any) =>
    React.createElement('textarea', { value, onChange, ...rest }),
}));
jest.mock('../ui/alert', () => ({
  Alert: ({ children, ...rest }: any) =>
    React.createElement('div', { role: 'alert', ...rest }, children),
  AlertTitle: ({ children }: any) =>
    React.createElement('div', null, children),
  AlertDescription: ({ children }: any) =>
    React.createElement('div', null, children),
}));

import {
  DynamicConnectorForm,
  type ConnectorFormData,
} from '../DynamicConnectorForm';
import {
  CONNECTOR_REGISTRY,
  type ConnectorType,
} from '../../config/connectorRegistry';

const mcpServerType: ConnectorType = (() => {
  const def = CONNECTOR_REGISTRY.MCP_SERVER;
  return {
    id: def.type,
    name: def.name,
    description: def.description,
    icon: def.icon,
    authMethod: def.authMethod,
    provider: def.provider,
    category: def.category,
    isPopular: def.isPopular,
  };
})();

function renderForm(
  overrides: Partial<React.ComponentProps<typeof DynamicConnectorForm>> = {},
) {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const props = {
    connectorType: mcpServerType,
    mode: 'create' as const,
    onSubmit,
    ...overrides,
  };
  render(React.createElement(DynamicConnectorForm, props as any));
  return { onSubmit };
}

/**
 * Locate the <select> bound to a particular field by walking up to the
 * field-row container and scoping the query to it.
 */
function selectFor(fieldName: string): HTMLSelectElement {
  const label = screen.getByText(
    new RegExp(`^${labelFor(fieldName)}\\b`, 'i'),
  );
  // The <label> has `htmlFor={fieldName}` and shares a row container with the select.
  const row = label.closest('div')!;
  const select = row.querySelector('select') as HTMLSelectElement;
  if (!select) {
    throw new Error(`No <select> found in row for field "${fieldName}"`);
  }
  return select;
}

function labelFor(fieldName: string): string {
  const labels: Record<string, string> = {
    authMethod: 'Authentication Method',
    grantType: 'Grant Type',
    clientAuthenticationMethod: 'Client Authentication Method',
  };
  return labels[fieldName] ?? fieldName;
}

function setSelectValue(fieldName: string, value: string): void {
  const select = selectFor(fieldName);
  fireEvent.change(select, { target: { value } });
}

function setInputValue(fieldName: string, value: string): void {
  const input = document.getElementById(fieldName) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (!input) throw new Error(`No input found with id "${fieldName}"`);
  fireEvent.change(input, { target: { value } });
}

function getInput(fieldName: string): HTMLInputElement | null {
  return document.getElementById(fieldName) as HTMLInputElement | null;
}

function clickSubmit(): void {
  const submit = screen.getByRole('button', { name: /Create Integration/i });
  fireEvent.click(submit);
}

describe('DynamicConnectorForm — MCP_SERVER conditional fields', () => {
  afterEach(() => cleanup());

  it('MCP_SERVER + API_KEY: shows apiKey field, hides OAuth fields', () => {
    renderForm();

    // authMethod default is the placeholder value (empty); explicitly choose API_KEY.
    setSelectValue('authMethod', 'API_KEY');

    expect(getInput('apiKey')).not.toBeNull();
    expect(getInput('clientId')).toBeNull();
    expect(getInput('clientSecret')).toBeNull();
    expect(getInput('discoveryUrl')).toBeNull();
    expect(getInput('tokenUrl')).toBeNull();
    expect(getInput('authorizationUrl')).toBeNull();
    expect(getInput('scopes')).toBeNull();
  });

  it('MCP_SERVER + OAUTH2 + CLIENT_CREDENTIALS: shows clientId/clientSecret/grantType/scopes/tokenUrl, hides authorizationUrl', () => {
    renderForm();

    setSelectValue('authMethod', 'OAUTH2');
    // grantType defaults to CLIENT_CREDENTIALS via field.defaultValue.

    expect(getInput('clientId')).not.toBeNull();
    expect(getInput('clientSecret')).not.toBeNull();
    expect(selectFor('grantType').value).toBe('CLIENT_CREDENTIALS');
    expect(getInput('scopes')).not.toBeNull();
    // tokenUrl is required (no discoveryUrl)
    expect(getInput('tokenUrl')).not.toBeNull();
    // authorizationUrl is hidden for CLIENT_CREDENTIALS
    expect(getInput('authorizationUrl')).toBeNull();
  });

  it('MCP_SERVER + OAUTH2 + AUTHORIZATION_CODE: shows authorizationUrl + tokenUrl when no discoveryUrl', () => {
    renderForm();

    setSelectValue('authMethod', 'OAUTH2');
    setSelectValue('grantType', 'AUTHORIZATION_CODE');

    expect(getInput('clientId')).not.toBeNull();
    expect(getInput('clientSecret')).not.toBeNull();
    expect(getInput('scopes')).not.toBeNull();
    expect(getInput('tokenUrl')).not.toBeNull();
    expect(getInput('authorizationUrl')).not.toBeNull();
  });

  it('MCP_SERVER + OAUTH2 + discoveryUrl: hides tokenUrl + authorizationUrl', () => {
    renderForm();

    setSelectValue('authMethod', 'OAUTH2');
    setSelectValue('grantType', 'AUTHORIZATION_CODE');
    setInputValue('discoveryUrl', 'https://idp.example.com/.well-known/oauth-authorization-server');

    expect(getInput('discoveryUrl')).not.toBeNull();
    // Both endpoint URLs auto-discovered → hidden.
    expect(getInput('tokenUrl')).toBeNull();
    expect(getInput('authorizationUrl')).toBeNull();
  });

  it('Advanced: clientAuthenticationMethod is rendered under the Advanced disclosure', () => {
    renderForm();
    setSelectValue('authMethod', 'OAUTH2');

    // The Advanced trigger button is rendered when there is at least one
    // visible advanced field. We assert: trigger present, advanced field
    // present, default value applied. Toggle is Radix's responsibility.
    const advancedTrigger = screen.getByRole('button', { name: /Advanced/i });
    expect(advancedTrigger).toBeInTheDocument();

    const cam = selectFor('clientAuthenticationMethod');
    expect(cam.value).toBe('CLIENT_SECRET_BASIC');

    // The advanced field lives inside the Collapsible disclosure container.
    const wrapper = cam.closest('[data-testid="advanced-disclosure"]');
    expect(wrapper).not.toBeNull();
  });
});

describe('DynamicConnectorForm — MCP_SERVER OAuth2 validation', () => {
  afterEach(() => cleanup());

  it('rejects empty scopes with an inline error', () => {
    const { onSubmit } = renderForm();

    setInputValue('name', 'My MCP');
    setSelectValue('authMethod', 'OAUTH2');
    setInputValue('clientId', 'cid');
    setInputValue('clientSecret', 'cs');
    setInputValue('tokenUrl', 'https://idp.example.com/token');
    setInputValue('serverUrl', 'https://mcp.example.com');
    // scopes left blank
    clickSubmit();

    expect(screen.getByText(/Scopes is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('AUTHORIZATION_CODE without authorizationUrl (no discoveryUrl) → error', () => {
    const { onSubmit } = renderForm();

    setInputValue('name', 'My MCP');
    setSelectValue('authMethod', 'OAUTH2');
    setSelectValue('grantType', 'AUTHORIZATION_CODE');
    setInputValue('clientId', 'cid');
    setInputValue('clientSecret', 'cs');
    setInputValue('tokenUrl', 'https://idp.example.com/token');
    setInputValue('scopes', 'read');
    setInputValue('serverUrl', 'https://mcp.example.com');
    // authorizationUrl left blank
    clickSubmit();

    expect(screen.getByText(/Authorization URL is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects non-https tokenUrl with an inline error', () => {
    const { onSubmit } = renderForm();

    setInputValue('name', 'My MCP');
    setSelectValue('authMethod', 'OAUTH2');
    setInputValue('clientId', 'cid');
    setInputValue('clientSecret', 'cs');
    setInputValue('tokenUrl', 'http://idp.example.com/token');
    setInputValue('scopes', 'read');
    setInputValue('serverUrl', 'https://mcp.example.com');
    clickSubmit();

    expect(
      screen.getByText(/Token URL must be a valid https:\/\/ URL/i),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('discoveryUrl alternative path: submits without tokenUrl/authorizationUrl', async () => {
    const { onSubmit } = renderForm();

    setInputValue('name', 'My MCP');
    setSelectValue('authMethod', 'OAUTH2');
    setSelectValue('grantType', 'AUTHORIZATION_CODE');
    setInputValue('clientId', 'cid');
    setInputValue('clientSecret', 'cs');
    setInputValue(
      'discoveryUrl',
      'https://idp.example.com/.well-known/oauth-authorization-server',
    );
    setInputValue('scopes', 'read, write');
    setInputValue('serverUrl', 'https://mcp.example.com');

    await act(async () => {
      clickSubmit();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = (onSubmit.mock.calls[0][0] as ConnectorFormData);
    // scopes parsed to deduped array on submit
    expect(submitted.credentials.scopes).toEqual(['read', 'write']);
    // hidden fields not submitted
    expect((submitted.credentials as any).tokenUrl).toBeUndefined();
    expect((submitted.credentials as any).authorizationUrl).toBeUndefined();
    // grantType included
    expect(submitted.credentials.grantType).toBe('AUTHORIZATION_CODE');
    // clientAuthenticationMethod default carried through
    expect(submitted.credentials.clientAuthenticationMethod).toBe(
      'CLIENT_SECRET_BASIC',
    );
  });

  it('exposes ARIA attributes on validation errors', () => {
    const { onSubmit } = renderForm();

    // Submit empty form to trigger validation errors. `serverUrl` (a plain
    // Input rendered by renderField from configFields) and `name` (the
    // standalone integration-name input) are both required, so both will
    // surface aria-* error wiring.
    clickSubmit();

    expect(onSubmit).not.toHaveBeenCalled();

    // 1) Field rendered via renderField (Input branch).
    const serverUrl = getInput('serverUrl');
    expect(serverUrl).not.toBeNull();
    expect(serverUrl).toHaveAttribute('aria-required', 'true');
    expect(serverUrl).toHaveAttribute('aria-invalid', 'true');
    expect(serverUrl).toHaveAttribute('aria-describedby', 'serverUrl-error');

    const serverUrlError = document.getElementById('serverUrl-error');
    expect(serverUrlError).not.toBeNull();
    expect(serverUrlError).toHaveAttribute('role', 'alert');
    expect(serverUrlError!.textContent).toMatch(/required/i);

    // 2) Standalone Integration Name input also wired up.
    const nameInput = getInput('name');
    expect(nameInput).not.toBeNull();
    expect(nameInput).toHaveAttribute('aria-required', 'true');
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput).toHaveAttribute('aria-describedby', 'name-error');

    const nameError = document.getElementById('name-error');
    expect(nameError).not.toBeNull();
    expect(nameError).toHaveAttribute('role', 'alert');
  });
});

/**
 * Defect regression: Agent Tools page render crash on partial/summary
 * registry rows.
 *
 * Post-deploy, listResources can hydrate a tool via the summary fallback
 * (per-record detail GET failed), projecting a bare string — the plain
 * human-readable description or '' — into the AWSJSON `config` field.
 * AWSJSON double-encodes bare strings, so the service's first parse
 * (toolConfigService listToolConfigs) succeeds but yields a STRING, and
 * ToolCard's render-time `JSON.parse(tool.config)` then threw a
 * SyntaxError into the page error boundary.
 *
 * ToolCard must render these rows (falling back to toolId / default copy),
 * never throw during render.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-test' }),
}));

// Not under test; avoids pulling the sandbox's service dependencies into jsdom.
jest.mock('@/components/ToolTestingSandbox', () => ({
  ToolTestingSandbox: () => null,
}));

import { ToolCard } from '../ToolCard';
import { ToolConfig } from '../../services/toolConfigService';

const makeTool = (config: unknown): ToolConfig => ({
  toolId: 'weather-fetcher',
  config,
  state: 'active',
  categories: ['registry'],
});

const renderCard = (config: unknown) =>
  render(
    <ToolCard tool={makeTool(config)} onToggleState={jest.fn()} onConfigure={jest.fn()} />,
  );

describe('ToolCard — summary-fallback (non-JSON) registry config', () => {
  it('renders a tool whose config is plain human-readable text instead of throwing', () => {
    // Real projection shape: summary-fallback row where config fell back to
    // record.description (plain text), delivered double-encoded via AWSJSON
    // and already string-decoded once by the service.
    renderCard('Fetches weather data');

    expect(screen.getAllByText('weather-fetcher').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('No description available')).toBeInTheDocument();
  });

  it("renders a tool whose config is the empty string ('' projection) instead of throwing", () => {
    // Real projection shape: summary row with no description → config: ''.
    renderCard('');

    expect(screen.getAllByText('weather-fetcher').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('No description available')).toBeInTheDocument();
  });

  it('still surfaces name and description from a valid JSON-string config', () => {
    renderCard(
      JSON.stringify({ name: 'Weather Tool', description: 'Fetches weather data', version: 'v1.2.0' }),
    );

    expect(screen.getByText('Weather Tool')).toBeInTheDocument();
    expect(screen.getByText('Fetches weather data')).toBeInTheDocument();
    expect(screen.getByText('v1.2.0')).toBeInTheDocument();
  });
});

/**
 * GovernanceIamTrustPath tests.
 *
 * Mocks @xyflow/react as inert, the governance service, OrganizationContext,
 * and the shadcn select/sheet/skeleton/button/label/input primitives so the
 * test environment renders predictable DOM.
 */

import React from 'react';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('../../components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) =>
    React.createElement(
      'div',
      { className, 'data-testid': 'page-container' },
      children,
    ),
}));

jest.mock('../../components/ui/skeleton', () => ({
  Skeleton: ({ className, ...rest }: any) =>
    React.createElement('div', {
      'data-testid': 'skeleton',
      className,
      ...rest,
    }),
}));

jest.mock('../../components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) =>
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('../../components/ui/badge', () => ({
  Badge: ({ children, className, ...rest }: any) =>
    React.createElement('span', { className, ...rest }, children),
}));

jest.mock('../../components/ui/input', () => ({
  Input: ({ ...rest }: any) => React.createElement('input', { ...rest }),
}));

jest.mock('../../components/ui/label', () => ({
  Label: ({ children, htmlFor, className }: any) =>
    React.createElement('label', { htmlFor, className }, children),
}));

jest.mock('../../components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) =>
    open
      ? React.createElement(
          'div',
          { 'data-testid': 'iam-hop-drawer' },
          children,
        )
      : null,
  SheetContent: ({ children }: any) =>
    React.createElement('div', null, children),
  SheetHeader: ({ children }: any) =>
    React.createElement('div', null, children),
  SheetTitle: ({ children, ...rest }: any) =>
    React.createElement('div', rest, children),
  SheetDescription: ({ children }: any) =>
    React.createElement('div', null, children),
}));

jest.mock('../../components/ui/select', () => {
  const ReactLib = require('react');
  return {
    Select: ({ value, onValueChange, children }: any) => {
      const options: Array<{ value: string; label: any }> = [];
      const collect = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) {
          for (const c of node) collect(c);
          return;
        }
        if (
          node?.props?.value !== undefined &&
          node.type?._optionMarker === true
        ) {
          options.push({ value: node.props.value, label: node.props.children });
        }
        if (node?.props?.children) collect(node.props.children);
      };
      collect(children);
      return ReactLib.createElement(
        'select',
        {
          value: value ?? '',
          onChange: (e: any) => onValueChange && onValueChange(e.target.value),
          'data-testid': 'select-mock',
          'data-current-value': value ?? '',
        },
        options.map((o: any) =>
          ReactLib.createElement(
            'option',
            { key: o.value, value: o.value },
            o.label,
          ),
        ),
      );
    },
    SelectTrigger: ({ children, id, className, ...rest }: any) =>
      ReactLib.createElement(
        'div',
        { id, className, 'data-testid': 'select-trigger', ...rest },
        children,
      ),
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      ReactLib.createElement('div', null, children),
    SelectItem: Object.assign(
      ({ children }: any) => ReactLib.createElement('span', null, children),
      { _optionMarker: true },
    ),
  };
});

// Replace @xyflow/react with a minimal inert renderer that exposes
// hops as `<li data-testid="iam-rf-node-<id>">` so the test can assert
// composition + simulate node clicks.
jest.mock('@xyflow/react', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    ReactFlow: ({
      nodes,
      edges,
      onNodeClick,
    }: {
      nodes: any[];
      edges: any[];
      onNodeClick?: (evt: any, node: any) => void;
    }) =>
      ReactLib.createElement(
        'div',
        { 'data-testid': 'reactflow-mock' },
        ReactLib.createElement(
          'ul',
          { 'data-testid': 'iam-rf-nodes' },
          nodes.map((n: any) =>
            ReactLib.createElement(
              'li',
              {
                key: n.id,
                'data-testid': `iam-rf-node-${n.id}`,
                'data-scope': n.data?.hop?.scope,
                onClick: (e: any) => onNodeClick && onNodeClick(e, n),
              },
              n.data?.hop?.name ?? n.id,
            ),
          ),
        ),
        ReactLib.createElement(
          'ul',
          { 'data-testid': 'iam-rf-edges' },
          edges.map((e: any) =>
            ReactLib.createElement(
              'li',
              {
                key: e.id,
                'data-testid': `iam-rf-edge-${e.id}`,
                'data-edge-kind': e.data?.edgeKind,
              },
              e.label ?? '',
            ),
          ),
        ),
      ),
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
  };
});

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    getTrustPath: jest.fn(),
    getResourceIamDrift: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceIamTrustPath } from '../../pages/governance/IamTrustPath';

function setOrg(isAdmin: boolean) {
  mockUseOrganization.mockReturnValue({
    selectedOrganization: 'TestOrg',
    setSelectedOrganization: jest.fn(),
    organizations: ['TestOrg'],
    currentUser: null,
    isAdmin,
    loading: false,
  });
}

function makeReport(overrides: Partial<any> = {}): any {
  return {
    resourceType: 'datastore',
    resourceId: 'ds-1',
    generatedAt: 1715000000,
    hops: [
      {
        arn: 'arn:aws:iam::123:role/lambda-exec',
        name: 'lambda-exec',
        scope: 'lambda',
        trustPolicyPrincipals: ['arn:aws:iam::123:role/x'],
        inlinePolicy: [],
        inlinePolicyName: null,
        totalActions: 0,
        totalResources: 0,
      },
      {
        arn: 'arn:aws:iam::123:role/citadel-ds-ds-1',
        name: 'citadel-ds-ds-1',
        scope: 'datastore',
        trustPolicyPrincipals: ['arn:aws:iam::123:role/lambda-exec'],
        inlinePolicy: [
          {
            effect: 'Allow',
            actions: ['s3:GetObject', 's3:PutObject'],
            resources: ['arn:aws:s3:::b/*'],
            conditionsJson: null,
          },
        ],
        inlinePolicyName: 'DataStoreAccess',
        totalActions: 2,
        totalResources: 1,
      },
    ],
    notes: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* noop */
  }
});

describe('GovernanceIamTrustPath', () => {
  it('renders an admin-only empty state when the caller is not admin and does not fetch', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceIamTrustPath));
    });

    expect(screen.getByTestId('iam-empty-state')).toBeInTheDocument();
    expect(governanceService.getTrustPath).not.toHaveBeenCalled();
  });

  it('renders a walkthrough card for admins when no resourceId selected yet', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceIamTrustPath));
    });

    expect(screen.getByTestId('iam-walkthrough-card')).toBeInTheDocument();
    expect(screen.getByText(/POLICY_MANAGER\.md/i)).toBeInTheDocument();
  });

  it('shows the IAM drift overlay footer note', async () => {
    setOrg(true);
    await act(async () => {
      render(React.createElement(GovernanceIamTrustPath));
    });
    expect(screen.getByTestId('iam-wave-5c2-footer')).toHaveTextContent(
      'Drift detection overlay highlights roles whose inline policies exceed declared requirements.',
    );
  });

  it('admin + resourceId: fetches getTrustPath on Inspect click and renders a node per hop', async () => {
    setOrg(true);
    (governanceService.getTrustPath as jest.Mock).mockResolvedValue(
      makeReport(),
    );

    await act(async () => {
      render(React.createElement(GovernanceIamTrustPath));
    });

    const input = screen.getByTestId('iam-resource-id-input');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'ds-1' } });
    });
    const button = screen.getByTestId('iam-inspect-button');
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      expect(governanceService.getTrustPath).toHaveBeenCalledWith(
        'datastore',
        'ds-1',
      );
    });

    expect(screen.getByTestId('iam-trust-path-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('iam-rf-node-hop-0')).toBeInTheDocument();
    expect(screen.getByTestId('iam-rf-node-hop-1')).toBeInTheDocument();
  });

  it('renders a notes banner when report.notes is non-empty', async () => {
    setOrg(true);
    (governanceService.getTrustPath as jest.Mock).mockResolvedValue(
      makeReport({
        hops: [makeReport().hops[0]],
        notes: ['Resource not found: datastore/missing'],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceIamTrustPath));
    });

    fireEvent.change(screen.getByTestId('iam-resource-id-input'), {
      target: { value: 'missing' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('iam-inspect-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('iam-notes-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('iam-note-0')).toHaveTextContent(
      'Resource not found: datastore/missing',
    );
  });

  it('clicking a hop opens the side drawer with policy statements', async () => {
    setOrg(true);
    (governanceService.getTrustPath as jest.Mock).mockResolvedValue(
      makeReport(),
    );

    await act(async () => {
      render(React.createElement(GovernanceIamTrustPath));
    });

    fireEvent.change(screen.getByTestId('iam-resource-id-input'), {
      target: { value: 'ds-1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('iam-inspect-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('iam-rf-node-hop-1')).toBeInTheDocument();
    });

    // Drawer is hidden until a hop is selected.
    expect(screen.queryByTestId('iam-hop-drawer')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('iam-rf-node-hop-1'));
    });

    expect(screen.getByTestId('iam-hop-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('iam-hop-drawer-arn')).toHaveTextContent(
      'arn:aws:iam::123:role/citadel-ds-ds-1',
    );
    expect(screen.getByTestId('iam-policy-statement-0')).toBeInTheDocument();
  });

  it('localStorage caches recent resourceIds (max 10)', async () => {
    setOrg(true);
    (governanceService.getTrustPath as jest.Mock).mockResolvedValue(
      makeReport(),
    );

    await act(async () => {
      render(React.createElement(GovernanceIamTrustPath));
    });

    // Inspect 12 distinct resourceIds; the 11th and 12th should evict the
    // oldest 2 entries.
    for (let i = 0; i < 12; i++) {
      fireEvent.change(screen.getByTestId('iam-resource-id-input'), {
        target: { value: `ds-${i}` },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('iam-inspect-button'));
      });
      await waitFor(() => {
        expect(governanceService.getTrustPath).toHaveBeenCalledWith(
          'datastore',
          `ds-${i}`,
        );
      });
    }

    const raw = window.localStorage.getItem(
      'governance.iam-trust-path.recents',
    );
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Array<{
      resourceType: string;
      resourceId: string;
    }>;
    expect(parsed).toHaveLength(10);
    // Most recent first.
    expect(parsed[0]).toEqual({ resourceType: 'datastore', resourceId: 'ds-11' });
    // ds-0 and ds-1 should have been evicted.
    expect(parsed.some((e) => e.resourceId === 'ds-0')).toBe(false);
    expect(parsed.some((e) => e.resourceId === 'ds-1')).toBe(false);
  });

  it('surfaces resolver errors as an inline banner', async () => {
    setOrg(true);
    (governanceService.getTrustPath as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await act(async () => {
      render(React.createElement(GovernanceIamTrustPath));
    });

    fireEvent.change(screen.getByTestId('iam-resource-id-input'), {
      target: { value: 'ds-1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('iam-inspect-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('iam-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('iam-error-banner')).toHaveTextContent(
      'Forbidden: admin required',
    );
  });

  describe('drift overlay', () => {
    async function inspectAndSelectHop(hopId: 'hop-0' | 'hop-1') {
      setOrg(true);
      (governanceService.getTrustPath as jest.Mock).mockResolvedValue(
        makeReport(),
      );

      await act(async () => {
        render(React.createElement(GovernanceIamTrustPath));
      });

      fireEvent.change(screen.getByTestId('iam-resource-id-input'), {
        target: { value: 'ds-1' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('iam-inspect-button'));
      });

      await waitFor(() => {
        expect(screen.getByTestId(`iam-rf-node-${hopId}`)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId(`iam-rf-node-${hopId}`));
      });
    }

    it('Check Drift button hidden for Lambda hop', async () => {
      await inspectAndSelectHop('hop-0');

      // Drawer is open for the lambda hop, but the drift section/button
      // are scope-gated and must not render for scope:'lambda'.
      expect(screen.getByTestId('iam-hop-drawer')).toBeInTheDocument();
      expect(screen.queryByTestId('iam-drift-section')).toBeNull();
      expect(screen.queryByTestId('iam-drift-check-button')).toBeNull();
    });

    it('Check Drift button visible for datastore hop', async () => {
      await inspectAndSelectHop('hop-1');

      expect(screen.getByTestId('iam-hop-drawer')).toBeInTheDocument();
      expect(screen.getByTestId('iam-drift-check-button')).toBeInTheDocument();
    });

    it('Click Check Drift renders "In sync" badge when hasDrift=false', async () => {
      (governanceService.getResourceIamDrift as jest.Mock).mockResolvedValue({
        hasDrift: false,
        totalExcess: 0,
        totalMissing: 0,
        groups: [],
        notes: [],
      });

      await inspectAndSelectHop('hop-1');

      await act(async () => {
        fireEvent.click(screen.getByTestId('iam-drift-check-button'));
      });

      await waitFor(() => {
        expect(governanceService.getResourceIamDrift).toHaveBeenCalledWith(
          'datastore',
          'ds-1',
        );
      });

      expect(
        screen.getByTestId('iam-drift-status-badge'),
      ).toHaveTextContent('In sync');
    });

    it('Click Check Drift renders "Drift detected" + excess action when hasDrift=true', async () => {
      (governanceService.getResourceIamDrift as jest.Mock).mockResolvedValue({
        hasDrift: true,
        totalExcess: 1,
        totalMissing: 0,
        groups: [
          {
            resourceArnPattern: 'arn:b/*',
            excessActions: ['s3:DeleteObject'],
            missingActions: [],
            declaredActions: [],
            effectiveActions: ['s3:DeleteObject'],
          },
        ],
        notes: [],
      });

      await inspectAndSelectHop('hop-1');

      await act(async () => {
        fireEvent.click(screen.getByTestId('iam-drift-check-button'));
      });

      await waitFor(() => {
        expect(
          screen.getByTestId('iam-drift-status-badge'),
        ).toHaveTextContent('Drift detected');
      });

      expect(screen.getByText('s3:DeleteObject')).toBeInTheDocument();
    });
  });
});

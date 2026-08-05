/**
 * GovernanceEvalComparison page tests.
 *
 * Mocks the evalComparisonService, OrganizationContext, and shadcn
 * primitives so the test environment renders predictable DOM. Covers the
 * honest-state matrix (loading, no baseline, NOTHING_TO_COMPARE,
 * unauthorized, empty) plus the per-dimension aggregate table and
 * per-case diff rendering with non-colour-only classification cues.
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('../../components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) =>
    React.createElement('div', { className, 'data-testid': 'page-container' }, children),
}));

jest.mock('../../components/governance/GovernanceBreadcrumbs', () => ({
  GovernanceBreadcrumbs: ({ title }: any) =>
    React.createElement('div', { 'data-testid': 'governance-breadcrumbs' }, title),
}));

jest.mock('../../components/ui/skeleton', () => ({
  Skeleton: ({ className, ...rest }: any) =>
    React.createElement('div', { 'data-testid': 'skeleton', className, ...rest }),
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

jest.mock('../../components/ui/card', () => ({
  Card: ({ children, className, ...rest }: any) =>
    React.createElement('div', { className, ...rest }, children),
  CardHeader: ({ children }: any) => React.createElement('div', null, children),
  CardTitle: ({ children }: any) => React.createElement('div', null, children),
  CardDescription: ({ children }: any) => React.createElement('div', null, children),
  CardContent: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('../../components/ui/alert', () => ({
  Alert: ({ children, className, ...rest }: any) =>
    React.createElement('div', { className, role: 'alert', ...rest }, children),
  AlertDescription: ({ children }: any) => React.createElement('div', null, children),
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
        if (node?.props?.value !== undefined && node.type?._optionMarker === true) {
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
        },
        options.map((o: any) => ReactLib.createElement('option', { key: o.value, value: o.value }, o.label)),
      );
    },
    SelectTrigger: ({ children, id, className, ...rest }: any) =>
      ReactLib.createElement('div', { id, className, 'data-testid': 'select-trigger', ...rest }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) => ReactLib.createElement('div', null, children),
    SelectItem: Object.assign(
      ({ children }: any) => ReactLib.createElement('span', null, children),
      { _optionMarker: true },
    ),
  };
});

jest.mock('../../components/ui/table', () => {
  const ReactLib = require('react');
  return {
    Table: ({ children, ...rest }: any) => ReactLib.createElement('table', rest, children),
    TableHeader: ({ children }: any) => ReactLib.createElement('thead', null, children),
    TableBody: ({ children }: any) => ReactLib.createElement('tbody', null, children),
    TableRow: ({ children, ...rest }: any) => ReactLib.createElement('tr', rest, children),
    TableHead: ({ children, ...rest }: any) => ReactLib.createElement('th', rest, children),
    TableCell: ({ children, ...rest }: any) => ReactLib.createElement('td', rest, children),
  };
});

jest.mock('../../components/ui/sheet', () => {
  const ReactLib = require('react');
  return {
    Sheet: ({ children, open }: any) => (open ? ReactLib.createElement('div', { 'data-testid': 'sheet-root' }, children) : null),
    SheetContent: ({ children, ...rest }: any) =>
      ReactLib.createElement('div', { role: 'dialog', 'aria-modal': 'true', 'data-testid': 'sheet-content', ...rest }, children),
    SheetHeader: ({ children }: any) => ReactLib.createElement('div', null, children),
    SheetTitle: ({ children }: any) => ReactLib.createElement('h2', null, children),
    SheetDescription: ({ children }: any) => ReactLib.createElement('p', null, children),
    SheetFooter: ({ children }: any) => ReactLib.createElement('div', null, children),
    SheetClose: ({ children }: any) => ReactLib.createElement('div', null, children),
  };
});

jest.mock('../../components/ui/tabs', () => {
  const ReactLib = require('react');
  return {
    Tabs: ({ children, value }: any) => {
      const kids = ReactLib.Children.toArray(children) as any[];
      return ReactLib.createElement(
        'div',
        { 'data-testid': 'tabs-root', 'data-value': value },
        kids.map((child: any, i: number) =>
          ReactLib.cloneElement(child, { key: child.key ?? i, __activeValue: value }),
        ),
      );
    },
    TabsList: ({ children }: any) => ReactLib.createElement('div', { role: 'tablist' }, children),
    TabsTrigger: ({ children, value, onClick, ...rest }: any) =>
      ReactLib.createElement(
        'button',
        { role: 'tab', onClick: () => onClick && onClick(value), 'data-value': value, ...rest },
        children,
      ),
    TabsContent: ({ children, value, __activeValue, ...rest }: any) =>
      __activeValue !== value
        ? null
        : ReactLib.createElement('div', { role: 'tabpanel', 'data-value': value, ...rest }, children),
  };
});

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/evalComparisonService', () => ({
  evalComparisonService: {
    getEvalBaseline: jest.fn(),
    listEvalBaselines: jest.fn(),
    getEvalComparison: jest.fn(),
    listEvalComparisons: jest.fn(),
    getEvalComparisonThresholdConfig: jest.fn(),
    designateEvalBaseline: jest.fn(),
    computeEvalComparison: jest.fn(),
    setEvalComparisonThresholdConfig: jest.fn(),
    getEvalCaseArtifactDiff: jest.fn(),
  },
}));

import { evalComparisonService } from '../../services/evalComparisonService';
import { GovernanceEvalComparison } from '../../pages/governance/EvalComparison';

function setOrg() {
  mockUseOrganization.mockReturnValue({
    selectedOrganization: 'TestOrg',
    setSelectedOrganization: jest.fn(),
    organizations: ['TestOrg'],
    currentUser: null,
    isAdmin: true,
    loading: false,
  });
}

function makeDimension(overrides: Partial<any> = {}): any {
  return {
    dimension: 'task_success',
    direction: 'unchanged',
    materialRegression: false,
    unstable: false,
    baselineStat: 0.9,
    candidateStat: 0.9,
    delta: 0,
    caseCounts: {
      improved: 0,
      regressed: 0,
      unstable: 0,
      unchanged: 3,
      incomparable: 0,
      new: 0,
      dropped: 0,
    },
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<any> = {}): any {
  return {
    comparisonId: 'cmp-1',
    orgId: 'TestOrg',
    suiteId: 'suite-1',
    suiteVersion: 2,
    agentTargetId: 'agent-1',
    baselineEvalRunId: 'run-base',
    baselineAgentTargetVersion: 'v1',
    candidateEvalRunIds: ['run-cand'],
    candidateAgentTargetVersion: 'v2',
    repeatCount: 1,
    scorerVersions: ['v1'],
    thresholds: {
      passRateDropThreshold: 0.15,
      meanScoreDropThreshold: 0.15,
      latencyP95IncreaseMsThreshold: 500,
      costIncreaseThreshold: 0.05,
      minSampleCount: 10,
      scoreStabilityBand: 0.05,
    },
    dimensions: [makeDimension()],
    anyMaterialRegression: false,
    materiallyRegressedDimensions: [],
    unstableDimensions: [],
    verdictStatus: 'PASS',
    caseDetail: JSON.stringify({
      task_success: [
        { caseId: 'case-1', classification: 'unchanged', baselineValue: 1, candidateValue: 1 },
      ],
    }),
    caseDetailRef: null,
    createdAt: '2026-08-01T00:00:00Z',
    createdBy: 'user-1',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setOrg();
});

describe('GovernanceEvalComparison', () => {
  it('renders the page header and suite/run selection form', async () => {
    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    expect(screen.getByTestId('eval-comparison-form')).toBeInTheDocument();
    expect(screen.getByTestId('eval-suite-id-input')).toBeInTheDocument();
    expect(screen.getByTestId('eval-agent-target-id-input')).toBeInTheDocument();
    expect(screen.getByTestId('eval-baseline-run-id-input')).toBeInTheDocument();
    expect(screen.getByTestId('eval-candidate-run-id-input')).toBeInTheDocument();
  });

  it('honest empty state: shows "no baseline designated" when getEvalBaseline resolves null and no manual override is given', async () => {
    (evalComparisonService.getEvalBaseline as jest.Mock).mockResolvedValue(null);

    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
    fireEvent.change(screen.getByTestId('eval-agent-target-id-input'), { target: { value: 'agent-1' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-check-baseline-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('eval-no-baseline-state')).toBeInTheDocument();
    });
    expect(screen.getByTestId('eval-no-baseline-state')).toHaveTextContent(
      /no baseline designated/i,
    );
  });

  it('shows a loading state while computing the comparison', async () => {
    let resolveCompute: (v: any) => void = () => {};
    (evalComparisonService.computeEvalComparison as jest.Mock).mockImplementation(
      () => new Promise((resolve) => { resolveCompute = resolve; }),
    );

    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
    fireEvent.change(screen.getByTestId('eval-baseline-run-id-input'), { target: { value: 'run-base' } });
    fireEvent.change(screen.getByTestId('eval-candidate-run-id-input'), { target: { value: 'run-cand' } });

    act(() => {
      fireEvent.click(screen.getByTestId('eval-compute-button'));
    });

    expect(screen.getByTestId('eval-loading-state')).toBeInTheDocument();

    await act(async () => {
      resolveCompute(makeVerdict());
    });
  });

  it('renders NOTHING_TO_COMPARE as an explicit, honest state (not a fabricated pass)', async () => {
    (evalComparisonService.computeEvalComparison as jest.Mock).mockResolvedValue(
      makeVerdict({ verdictStatus: 'NOTHING_TO_COMPARE', dimensions: [] }),
    );

    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
    fireEvent.change(screen.getByTestId('eval-baseline-run-id-input'), { target: { value: 'run-base' } });
    fireEvent.change(screen.getByTestId('eval-candidate-run-id-input'), { target: { value: 'run-cand' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-compute-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('eval-nothing-to-compare-state')).toBeInTheDocument();
    });
  });

  it('renders an unauthorized cross-org error distinctly from a generic error', async () => {
    (evalComparisonService.computeEvalComparison as jest.Mock).mockRejectedValue(
      new Error('UnauthorizedError: eval:run permission required to compute eval comparisons'),
    );

    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
    fireEvent.change(screen.getByTestId('eval-baseline-run-id-input'), { target: { value: 'run-base' } });
    fireEvent.change(screen.getByTestId('eval-candidate-run-id-input'), { target: { value: 'run-cand' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-compute-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('eval-unauthorized-state')).toBeInTheDocument();
    });
    expect(screen.getByTestId('eval-unauthorized-state')).toHaveTextContent(/unauthorized/i);
  });

  it('renders a generic error banner for non-auth failures', async () => {
    (evalComparisonService.computeEvalComparison as jest.Mock).mockRejectedValue(
      new Error('EvalRun not found: run-base'),
    );

    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
    fireEvent.change(screen.getByTestId('eval-baseline-run-id-input'), { target: { value: 'run-base' } });
    fireEvent.change(screen.getByTestId('eval-candidate-run-id-input'), { target: { value: 'run-cand' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-compute-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('eval-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('eval-error-banner')).toHaveTextContent('EvalRun not found: run-base');
  });

  it('renders the verdict summary badge with an icon (not colour-only) and per-dimension aggregate table', async () => {
    (evalComparisonService.computeEvalComparison as jest.Mock).mockResolvedValue(
      makeVerdict({
        verdictStatus: 'REGRESSED',
        anyMaterialRegression: true,
        materiallyRegressedDimensions: ['task_success'],
        dimensions: [
          makeDimension({
            dimension: 'task_success',
            direction: 'regressed',
            materialRegression: true,
            baselineStat: 0.95,
            candidateStat: 0.7,
            delta: -0.25,
            caseCounts: {
              improved: 0,
              regressed: 2,
              unstable: 0,
              unchanged: 1,
              incomparable: 0,
              new: 0,
              dropped: 0,
            },
          }),
        ],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
    fireEvent.change(screen.getByTestId('eval-baseline-run-id-input'), { target: { value: 'run-base' } });
    fireEvent.change(screen.getByTestId('eval-candidate-run-id-input'), { target: { value: 'run-cand' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-compute-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('eval-verdict-summary')).toBeInTheDocument();
    });

    expect(screen.getByTestId('eval-verdict-badge')).toHaveTextContent('REGRESSED');
    // Non-colour-only cue: an icon element must accompany the badge.
    expect(screen.getByTestId('eval-verdict-icon')).toBeInTheDocument();

    const dimRow = screen.getByTestId('eval-dimension-row-task_success');
    expect(dimRow).toBeInTheDocument();
    expect(dimRow).toHaveTextContent('regressed');
    // Material regression rows carry a text/icon marker, not just colour.
    expect(screen.getByTestId('eval-dimension-regression-marker-task_success')).toBeInTheDocument();
  });

  it('renders per-case diff rows with classification labels distinguishing improved/regressed/unstable', async () => {
    (evalComparisonService.computeEvalComparison as jest.Mock).mockResolvedValue(
      makeVerdict({
        dimensions: [
          makeDimension({
            dimension: 'task_success',
            direction: 'regressed',
            materialRegression: true,
          }),
        ],
        caseDetail: JSON.stringify({
          task_success: [
            { caseId: 'case-improved', classification: 'improved', baselineValue: 0, candidateValue: 1 },
            { caseId: 'case-regressed', classification: 'regressed', baselineValue: 1, candidateValue: 0 },
            { caseId: 'case-unstable', classification: 'unstable', baselineValue: null, candidateValue: null },
          ],
        }),
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
    fireEvent.change(screen.getByTestId('eval-baseline-run-id-input'), { target: { value: 'run-base' } });
    fireEvent.change(screen.getByTestId('eval-candidate-run-id-input'), { target: { value: 'run-cand' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-compute-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('eval-dimension-row-task_success')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-dimension-expand-task_success'));
    });

    expect(screen.getByTestId('eval-case-row-case-improved')).toHaveTextContent('improved');
    expect(screen.getByTestId('eval-case-row-case-regressed')).toHaveTextContent('regressed');
    expect(screen.getByTestId('eval-case-row-case-unstable')).toHaveTextContent('unstable');
  });

  it('designate baseline button calls the service with the form inputs', async () => {
    (evalComparisonService.designateEvalBaseline as jest.Mock).mockResolvedValue({
      orgId: 'TestOrg',
      agentTargetId: 'agent-1',
      suiteId: 'suite-1',
      baselineEvalRunId: 'run-base',
      baselineSuiteVersion: 1,
      baselineAgentTargetVersion: 'v1',
      designatedAt: '2026-08-01T00:00:00Z',
      designatedBy: 'user-1',
      version: 1,
    });

    await act(async () => {
      render(React.createElement(GovernanceEvalComparison));
    });

    fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
    fireEvent.change(screen.getByTestId('eval-agent-target-id-input'), { target: { value: 'agent-1' } });
    fireEvent.change(screen.getByTestId('eval-baseline-run-id-input'), { target: { value: 'run-base' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-designate-baseline-button'));
    });

    await waitFor(() => {
      expect(evalComparisonService.designateEvalBaseline).toHaveBeenCalledWith({
        orgId: 'TestOrg',
        agentTargetId: 'agent-1',
        suiteId: 'suite-1',
        baselineEvalRunId: 'run-base',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Artifact diff panel (transcript + trajectory), reached from a per-case row
// ---------------------------------------------------------------------------

function makeSideView(overrides: Partial<any> = {}): any {
  return {
    side: 'BASELINE',
    availability: 'OK',
    evalRunId: 'run-base',
    caseId: 'case-improved',
    caseKind: 'CONVERSATION',
    artifactKind: 'conversation',
    correlationId: 'corr-1',
    sanitisation: { redactPiiVersion: 'v1', secretPatternsVersion: 'v1', gate: 'strict' },
    transcript: [
      { index: 0, role: 'user', content: 'hello', truncated: false },
      { index: 1, role: 'assistant', content: 'hi there', truncated: false },
    ],
    transcriptTotalCount: 2,
    transcriptReturnedCount: 2,
    transcriptTruncated: false,
    transcriptNextCursor: null,
    transcriptTotalBytes: 13,
    transcriptReturnedBytes: 13,
    trajectory: [
      { stepIndex: 0, nodeId: 'node-a', agentId: 'agent-1', status: 'COMPLETED', startedAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-01T00:00:01Z', output: { ok: true }, outputTruncated: false },
    ],
    trajectoryTotalCount: 1,
    trajectoryReturnedCount: 1,
    trajectoryTruncated: false,
    trajectoryNextCursor: null,
    toolSet: ['tool-a'],
    toolOrder: null,
    ...overrides,
  };
}

async function renderWithExpandedCaseRow() {
  (evalComparisonService.computeEvalComparison as jest.Mock).mockResolvedValue(
    makeVerdict({
      dimensions: [makeDimension({ dimension: 'task_success', direction: 'regressed', materialRegression: true })],
      caseDetail: JSON.stringify({
        task_success: [
          { caseId: 'case-improved', classification: 'improved', baselineValue: 0, candidateValue: 1 },
        ],
      }),
    }),
  );

  await act(async () => {
    render(React.createElement(GovernanceEvalComparison));
  });

  fireEvent.change(screen.getByTestId('eval-suite-id-input'), { target: { value: 'suite-1' } });
  fireEvent.change(screen.getByTestId('eval-baseline-run-id-input'), { target: { value: 'run-base' } });
  fireEvent.change(screen.getByTestId('eval-candidate-run-id-input'), { target: { value: 'run-cand' } });

  await act(async () => {
    fireEvent.click(screen.getByTestId('eval-compute-button'));
  });

  await waitFor(() => {
    expect(screen.getByTestId('eval-dimension-row-task_success')).toBeInTheDocument();
  });

  await act(async () => {
    fireEvent.click(screen.getByTestId('eval-dimension-expand-task_success'));
  });

  await waitFor(() => {
    expect(screen.getByTestId('eval-case-row-case-improved')).toBeInTheDocument();
  });
}

describe('GovernanceEvalComparison — artifact diff panel', () => {
  it('per-case row exposes a "view artifacts" action', async () => {
    await renderWithExpandedCaseRow();
    expect(screen.getByTestId('eval-view-artifacts-case-improved')).toBeInTheDocument();
  });

  it('opens the diff panel and fetches the artifact diff for baseline/candidate runs on the form', async () => {
    (evalComparisonService.getEvalCaseArtifactDiff as jest.Mock).mockResolvedValue({
      suiteId: 'suite-1',
      caseId: 'case-improved',
      baseline: makeSideView(),
      candidate: makeSideView({ side: 'CANDIDATE', evalRunId: 'run-cand' }),
    });

    await renderWithExpandedCaseRow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-view-artifacts-case-improved'));
    });

    await waitFor(() => {
      expect(evalComparisonService.getEvalCaseArtifactDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'TestOrg',
          suiteId: 'suite-1',
          caseId: 'case-improved',
          baselineEvalRunId: 'run-base',
          candidateEvalRunId: 'run-cand',
        }),
      );
    });

    expect(screen.getByTestId('artifact-diff-panel')).toBeInTheDocument();
    // Transcript rendered side by side, distinguishable per side.
    expect(screen.getByTestId('artifact-transcript-BASELINE')).toHaveTextContent('hello');
    expect(screen.getByTestId('artifact-transcript-CANDIDATE')).toHaveTextContent('hello');
  });

  it('renders each of the 7 per-side availability states honestly and distinguishably', async () => {
    const states: string[] = [
      'OK',
      'RUN_ABSENT',
      'RUN_NOT_COMPLETED',
      'CASE_ABSENT',
      'ARTIFACT_MISSING',
      'ARTIFACT_UNRESOLVED',
      'ARTIFACT_WITHHELD_SANITISATION',
    ];

    const stateLabelPattern: Record<string, RegExp> = {
      OK: /OK/,
      RUN_ABSENT: /run absent/i,
      RUN_NOT_COMPLETED: /run not completed/i,
      CASE_ABSENT: /case absent/i,
      ARTIFACT_MISSING: /artifact missing/i,
      ARTIFACT_UNRESOLVED: /artifact unresolved/i,
      ARTIFACT_WITHHELD_SANITISATION: /artifact withheld/i,
    };

    for (const state of states) {
      jest.clearAllMocks();
      cleanup();
      setOrg();
      (evalComparisonService.getEvalCaseArtifactDiff as jest.Mock).mockResolvedValue({
        suiteId: 'suite-1',
        caseId: 'case-improved',
        baseline: makeSideView({ availability: state, transcript: [], trajectory: [] }),
        candidate: makeSideView({ side: 'CANDIDATE', evalRunId: 'run-cand' }),
      });

      await renderWithExpandedCaseRow();

      await act(async () => {
        fireEvent.click(screen.getByTestId('eval-view-artifacts-case-improved'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('artifact-diff-panel')).toBeInTheDocument();
      });

      expect(screen.getByTestId('artifact-availability-BASELINE')).toHaveTextContent(
        stateLabelPattern[state],
      );
    }
  });

  it('surfaces truncation visibly with returned-vs-total counts and bytes, and a "load more" control wired to the cursor', async () => {
    (evalComparisonService.getEvalCaseArtifactDiff as jest.Mock).mockResolvedValue({
      suiteId: 'suite-1',
      caseId: 'case-improved',
      baseline: makeSideView({
        transcriptTruncated: true,
        transcriptTotalCount: 50,
        transcriptReturnedCount: 2,
        transcriptTotalBytes: 5000,
        transcriptReturnedBytes: 13,
        transcriptNextCursor: 'cursor-abc',
      }),
      candidate: makeSideView({ side: 'CANDIDATE', evalRunId: 'run-cand' }),
    });

    await renderWithExpandedCaseRow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-view-artifacts-case-improved'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('artifact-diff-panel')).toBeInTheDocument();
    });

    const truncationNotice = screen.getByTestId('artifact-transcript-truncated-BASELINE');
    expect(truncationNotice).toHaveTextContent('2');
    expect(truncationNotice).toHaveTextContent('50');
    expect(truncationNotice).toHaveTextContent('13');
    expect(truncationNotice).toHaveTextContent('5000');

    const loadMoreButton = screen.getByTestId('artifact-transcript-load-more-BASELINE');
    expect(loadMoreButton).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(loadMoreButton);
    });

    await waitFor(() => {
      expect(evalComparisonService.getEvalCaseArtifactDiff).toHaveBeenLastCalledWith(
        expect.objectContaining({ transcriptCursor: 'cursor-abc' }),
      );
    });
  });

  it('does not render a "load more" control when not truncated (never fabricates pagination)', async () => {
    (evalComparisonService.getEvalCaseArtifactDiff as jest.Mock).mockResolvedValue({
      suiteId: 'suite-1',
      caseId: 'case-improved',
      baseline: makeSideView({ transcriptTruncated: false, transcriptNextCursor: null }),
      candidate: makeSideView({ side: 'CANDIDATE', evalRunId: 'run-cand', transcriptTruncated: false, transcriptNextCursor: null }),
    });

    await renderWithExpandedCaseRow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-view-artifacts-case-improved'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('artifact-diff-panel')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('artifact-transcript-load-more-BASELINE')).not.toBeInTheDocument();
  });

  it('renders the ordered tool-call trajectory diff with truncation visibility', async () => {
    (evalComparisonService.getEvalCaseArtifactDiff as jest.Mock).mockResolvedValue({
      suiteId: 'suite-1',
      caseId: 'case-improved',
      baseline: makeSideView({
        trajectory: [
          { stepIndex: 0, nodeId: 'node-a', agentId: 'agent-1', status: 'COMPLETED', startedAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-01T00:00:01Z', output: { ok: true }, outputTruncated: false },
        ],
        trajectoryTruncated: true,
        trajectoryTotalCount: 10,
        trajectoryReturnedCount: 1,
        trajectoryNextCursor: 'traj-cursor',
      }),
      candidate: makeSideView({ side: 'CANDIDATE', evalRunId: 'run-cand' }),
    });

    await renderWithExpandedCaseRow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-view-artifacts-case-improved'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('artifact-diff-panel')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /trajectory/i }));
    });

    expect(screen.getByTestId('artifact-trajectory-step-BASELINE-0')).toHaveTextContent('node-a');
    expect(screen.getByTestId('artifact-trajectory-truncated-BASELINE')).toHaveTextContent('1');
    expect(screen.getByTestId('artifact-trajectory-truncated-BASELINE')).toHaveTextContent('10');
    expect(screen.getByTestId('artifact-trajectory-load-more-BASELINE')).toBeInTheDocument();
  });

  it('closes the diff panel via the close control', async () => {
    (evalComparisonService.getEvalCaseArtifactDiff as jest.Mock).mockResolvedValue({
      suiteId: 'suite-1',
      caseId: 'case-improved',
      baseline: makeSideView(),
      candidate: makeSideView({ side: 'CANDIDATE', evalRunId: 'run-cand' }),
    });

    await renderWithExpandedCaseRow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('eval-view-artifacts-case-improved'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('artifact-diff-panel')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('artifact-diff-panel-close'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('artifact-diff-panel')).not.toBeInTheDocument();
    });
  });
});

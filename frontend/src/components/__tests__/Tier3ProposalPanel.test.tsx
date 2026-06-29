/**
 * Tier3ProposalPanel — operator UI for the Tier-3 (AI-assisted) agent-import
 * manifest proposal + human accept flow.
 *
 * The panel is self-contained: given a DRAFT import record id (importId) and the
 * candidate `reference`, it drives the whole lifecycle —
 *   propose -> PENDING -> (refresh) -> pending_review -> accept -> accepted
 * with a retry-able `failed` branch — talking only to the mocked
 * `agentImportService`. It NEVER calls the service on mount.
 *
 * Security/UX framing under test: the proposed manifest is AI-generated,
 * LOW-CONFIDENCE, and REQUIRES HUMAN REVIEW; Accept only fills in the manifest —
 * the agent STAYS a DRAFT and is NOT activated.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('../../services/agentImportService', () => ({
  agentImportService: {
    proposeAgentManifestTier3: jest.fn(),
    acceptProposedManifestTier3: jest.fn(),
    getImportRecord: jest.fn(),
  },
}));

import { Tier3ProposalPanel } from '../Tier3ProposalPanel';
import { agentImportService } from '../../services/agentImportService';
import type {
  AgentImportRecord,
  ProposedManifest,
  Tier3ProposalResult,
} from '../../types/agentImport';

const svc = agentImportService as unknown as {
  proposeAgentManifestTier3: jest.Mock;
  acceptProposedManifestTier3: jest.Mock;
  getImportRecord: jest.Mock;
};

const enqueued: Tier3ProposalResult = { requestId: 'req-1', status: 'PENDING' };

const pendingProposal: ProposedManifest = {
  manifest: {
    name: 'Orders Agent',
    description: 'Handles the order lifecycle',
    skills: ['create_order'],
  },
  confidence: 'low',
  reviewState: 'pending_review',
  source: 'llm_tier3',
  fieldConfidence: { description: 'low' },
  proposedAt: '2026-06-29T00:00:00.000Z',
};

const failedProposal: ProposedManifest = {
  manifest: null,
  confidence: 'low',
  reviewState: 'failed',
  source: 'llm_tier3',
  error: 'Fabricator timed out',
  proposedAt: '2026-06-29T00:00:00.000Z',
};

const acceptedRecord: AgentImportRecord = {
  agentId: 'agent-new-1',
  name: 'Orders Agent',
  config: { name: 'Orders Agent' },
  state: 'inactive',
  proposedManifest: { ...pendingProposal, reviewState: 'accepted' },
};

describe('Tier3ProposalPanel — propose (no proposal yet)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('offers the Propose action and renders NO proposal/review panel when there is no proposedManifest', () => {
    render(<Tier3ProposalPanel agentId="agent-new-1" reference="ref-orders-1" />);

    expect(
      screen.getByRole('button', { name: /propose manifest \(tier-3/i }),
    ).toBeInTheDocument();
    // no review affordances without a landed proposal
    expect(
      screen.queryByRole('button', { name: /accept proposed manifest/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/review required/i)).not.toBeInTheDocument();
    // the panel must NOT touch the service on mount
    expect(svc.getImportRecord).not.toHaveBeenCalled();
    expect(svc.proposeAgentManifestTier3).not.toHaveBeenCalled();
  });

  it('Propose calls proposeAgentManifestTier3 with the ref and enters a PENDING state', async () => {
    const user = userEvent.setup();
    svc.proposeAgentManifestTier3.mockResolvedValue(enqueued);
    render(<Tier3ProposalPanel agentId="agent-new-1" reference="ref-orders-1" />);

    await user.click(
      screen.getByRole('button', { name: /propose manifest \(tier-3/i }),
    );

    await waitFor(() =>
      expect(svc.proposeAgentManifestTier3).toHaveBeenCalledTimes(1),
    );
    expect(svc.proposeAgentManifestTier3).toHaveBeenCalledWith(
      'ref-orders-1',
      undefined,
    );
    // pending state surfaced, non-blocking, with a manual refresh affordance
    expect(await screen.findByText(/appear here once ready/i)).toBeInTheDocument();
    expect(screen.getByText(/proposing/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /refresh/i }),
    ).toBeInTheDocument();
  });

  it('forwards cross-account discovery opts (discoveryRoleArn/discoveryExternalId) into the proposal request', async () => {
    const user = userEvent.setup();
    svc.proposeAgentManifestTier3.mockResolvedValue(enqueued);
    render(
      <Tier3ProposalPanel
        agentId="agent-new-1"
        reference="ref-xacct"
        discoveryRoleArn="arn:aws:iam::444455556666:role/citadel-discovery-readonly"
        discoveryExternalId="citadel-ext-scan-1"
      />,
    );

    await user.click(
      screen.getByRole('button', { name: /propose manifest \(tier-3/i }),
    );

    await waitFor(() =>
      expect(svc.proposeAgentManifestTier3).toHaveBeenCalledTimes(1),
    );
    expect(svc.proposeAgentManifestTier3).toHaveBeenCalledWith('ref-xacct', {
      discoveryRoleArn: 'arn:aws:iam::444455556666:role/citadel-discovery-readonly',
      discoveryExternalId: 'citadel-ext-scan-1',
    });
  });

  it('surfaces a propose error and lets the operator retry', async () => {
    const user = userEvent.setup();
    svc.proposeAgentManifestTier3.mockRejectedValue(new Error('Fabricator unavailable'));
    render(<Tier3ProposalPanel agentId="agent-new-1" reference="ref-orders-1" />);

    await user.click(
      screen.getByRole('button', { name: /propose manifest \(tier-3/i }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/fabricator unavailable/i);
    // still offers Propose (retry)
    expect(
      screen.getByRole('button', { name: /propose manifest \(tier-3/i }),
    ).toBeInTheDocument();
  });

  it('Refresh pulls the async result off the record and renders the landed proposal', async () => {
    const user = userEvent.setup();
    svc.proposeAgentManifestTier3.mockResolvedValue(enqueued);
    svc.getImportRecord.mockResolvedValue({
      agentId: 'agent-new-1',
      config: {},
      state: 'inactive',
      proposedManifest: pendingProposal,
    } satisfies AgentImportRecord);
    render(<Tier3ProposalPanel agentId="agent-new-1" reference="ref-orders-1" />);

    await user.click(
      screen.getByRole('button', { name: /propose manifest \(tier-3/i }),
    );
    await screen.findByText(/appear here once ready/i);

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(svc.getImportRecord).toHaveBeenCalledWith('agent-new-1'));
    // the landed pending_review proposal is now rendered with an Accept action
    expect(
      await screen.findByRole('button', { name: /accept proposed manifest/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/review required/i)).toBeInTheDocument();
  });
});

describe('Tier3ProposalPanel — pending_review proposal (read-only review gate)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the proposal READ-ONLY with the AI-proposed / low-confidence / review-required framing and an Accept button', () => {
    render(
      <Tier3ProposalPanel
        agentId="agent-new-1"
        reference="ref-orders-1"
        proposedManifest={pendingProposal}
      />,
    );

    // AI-proposed + review-required labelling (text, not colour-only)
    expect(screen.getByText(/ai-proposed.*review required/i)).toBeInTheDocument();
    // low confidence surfaced
    expect(screen.getByText(/low confidence/i)).toBeInTheDocument();

    // the proposed manifest body is shown READ-ONLY (no editable form control)
    const body = screen.getByLabelText('AI-proposed agent manifest (read-only)');
    expect(body).toBeInTheDocument();
    expect(body).toHaveTextContent(/Orders Agent/);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    // explicit human Accept action + the "still a DRAFT, not activated" framing
    expect(
      screen.getByRole('button', { name: /accept proposed manifest/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/stays a draft/i)).toBeInTheDocument();
    expect(screen.getByText(/not activated/i)).toBeInTheDocument();
  });

  it('Accept calls acceptProposedManifestTier3(importId); success reflects accepted + manifest-populated + still-DRAFT/not-activated messaging', async () => {
    const user = userEvent.setup();
    const onAccepted = jest.fn();
    svc.acceptProposedManifestTier3.mockResolvedValue(acceptedRecord);
    render(
      <Tier3ProposalPanel
        agentId="agent-new-1"
        reference="ref-orders-1"
        proposedManifest={pendingProposal}
        onAccepted={onAccepted}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: /accept proposed manifest/i }),
    );

    await waitFor(() =>
      expect(svc.acceptProposedManifestTier3).toHaveBeenCalledWith('agent-new-1'),
    );
    // accepted state: manifest populated, agent STILL a draft and NOT activated
    expect(await screen.findByText(/accepted/i)).toBeInTheDocument();
    expect(screen.getByText(/still a draft/i)).toBeInTheDocument();
    expect(screen.getByText(/not been activated/i)).toBeInTheDocument();
    // Accept is gone once accepted (no double-accept)
    expect(
      screen.queryByRole('button', { name: /accept proposed manifest/i }),
    ).not.toBeInTheDocument();
    expect(onAccepted).toHaveBeenCalledWith(acceptedRecord);
  });

  it('does NOT auto-accept — acceptProposedManifestTier3 is untouched until the operator clicks Accept', () => {
    render(
      <Tier3ProposalPanel
        agentId="agent-new-1"
        reference="ref-orders-1"
        proposedManifest={pendingProposal}
      />,
    );
    expect(svc.acceptProposedManifestTier3).not.toHaveBeenCalled();
  });

  it('surfaces an accept error and keeps the Accept action available for retry', async () => {
    const user = userEvent.setup();
    svc.acceptProposedManifestTier3.mockRejectedValue(new Error('Forbidden: admin only'));
    render(
      <Tier3ProposalPanel
        agentId="agent-new-1"
        reference="ref-orders-1"
        proposedManifest={pendingProposal}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: /accept proposed manifest/i }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/forbidden: admin only/i);
    expect(
      screen.getByRole('button', { name: /accept proposed manifest/i }),
    ).toBeInTheDocument();
  });
});

describe('Tier3ProposalPanel — failed / accepted states', () => {
  beforeEach(() => jest.clearAllMocks());

  it("reviewState='failed' shows a retry-able failed notice and NO Accept button", () => {
    render(
      <Tier3ProposalPanel
        agentId="agent-new-1"
        reference="ref-orders-1"
        proposedManifest={failedProposal}
      />,
    );

    expect(screen.getByText(/proposal failed/i)).toBeInTheDocument();
    expect(screen.getByText(/fabricator timed out/i)).toBeInTheDocument();
    // failed → no accept, but a retry (propose) action
    expect(
      screen.queryByRole('button', { name: /accept proposed manifest/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /propose manifest \(tier-3/i }),
    ).toBeInTheDocument();
  });

  it("reviewState='accepted' renders the accepted/still-DRAFT state without an Accept button", () => {
    render(
      <Tier3ProposalPanel
        agentId="agent-new-1"
        reference="ref-orders-1"
        proposedManifest={{ ...pendingProposal, reviewState: 'accepted' }}
      />,
    );

    expect(screen.getByText(/accepted/i)).toBeInTheDocument();
    expect(screen.getByText(/still a draft/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /accept proposed manifest/i }),
    ).not.toBeInTheDocument();
  });
});

/**
 * Implementation placeholder page unit tests
 * Tests: navigation from ProjectCard, placeholder rendering, back button, dark theme
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock UI components
jest.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: any) => React.createElement('div', { 'data-testid': 'card', ...props }, children),
  CardContent: ({ children, ...props }: any) => React.createElement('div', props, children),
  CardDescription: ({ children, ...props }: any) => React.createElement('p', props, children),
  CardHeader: ({ children, ...props }: any) => React.createElement('div', props, children),
  CardTitle: ({ children, ...props }: any) => React.createElement('h3', props, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className }, children),
}));

jest.mock('@/components/ui/progress', () => ({
  Progress: ({ value }: any) => React.createElement('div', { role: 'progressbar', 'aria-valuenow': value }),
}));

jest.mock('@/components/ui/status-card', () => ({
  StatusCard: ({ children, ...props }: any) => React.createElement('div', props, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

// Mock the document service so ImplementationPage hits the empty state
jest.mock('../../services/documentService', () => ({
  getProjectDocument: jest.fn(),
}));

import { getProjectDocument } from '../../services/documentService';
import { ProjectCard } from '../../components/ProjectCard';
import { ImplementationPage } from '../ImplementationPage';

const mockGetProjectDocument = getProjectDocument as jest.MockedFunction<typeof getProjectDocument>;

const mockProject = {
  id: 'proj-abc',
  projectId: 'proj-abc',
  name: 'Test Project',
  description: 'A test project for implementation',
  status: 'IN_PROGRESS' as const,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  progress: {
    overall: 66,
    assessment: 100,
    design: 100,
    planning: 100,
    implementation: 0,
    currentPhase: 'Implementation',
  },
};

describe('ProjectCard — Implement navigation', () => {
  it('calls onSelectImplement with project when Implement status card button is clicked', () => {
    const onSelectImplement = jest.fn();
    render(
      <ProjectCard
        project={mockProject}
        onSelectAssess={jest.fn()}
        onSelectPlan={jest.fn()}
        onSelectImplement={onSelectImplement}
      />,
    );

    // The Implement status card has a "Status & Details" button
    const buttons = screen.getAllByText('Status & Details');
    // Third button is the Implement one (Assess, Plan, Implement)
    fireEvent.click(buttons[2]);

    expect(onSelectImplement).toHaveBeenCalledWith(mockProject);
  });
});

describe('ImplementationPage — Placeholder', () => {
  const defaultProps = {
    projectId: 'proj-abc',
    projectName: 'Test Project',
    onBack: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no document available so ImplementationPage shows the empty state
    mockGetProjectDocument.mockResolvedValue(null);
  });

  it('renders project name', () => {
    render(<ImplementationPage {...defaultProps} />);
    expect(screen.getByText('Test Project')).toBeInTheDocument();
  });

  // The page no longer renders a "Coming Soon" placeholder; it shows either
  // a loading state, the loaded document, or the empty-state copy below.
  // TODO: when ImplementationPage adds 'Coming Soon' state, restore the
  //       original assertion (`expect(screen.getByText('Coming Soon'))`).
  it('renders empty-state message when no implementation document exists', async () => {
    render(<ImplementationPage {...defaultProps} />);
    await waitFor(() => {
      expect(
        screen.getByText(/no implementation recommendations available yet/i),
      ).toBeInTheDocument();
    });
  });

  it('renders a back button', () => {
    render(<ImplementationPage {...defaultProps} />);
    const backButton = screen.getByText(/Back/i);
    expect(backButton).toBeInTheDocument();
  });

  it('back button calls onBack when clicked', () => {
    render(<ImplementationPage {...defaultProps} />);
    const backButton = screen.getByText(/Back/i);
    fireEvent.click(backButton);
    expect(defaultProps.onBack).toHaveBeenCalledTimes(1);
  });

  it('uses dark theme styling', () => {
    const { container } = render(<ImplementationPage {...defaultProps} />);
    // Check for dark theme classes on the root element
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('bg-background');
  });
});

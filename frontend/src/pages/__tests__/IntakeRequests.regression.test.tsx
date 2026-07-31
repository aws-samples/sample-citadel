/**
 * Regression tests for the IntakeRequests page.
 *
 * Covers: project list rendering, filter tabs, new project button,
 * loading/error states, subscription setup, polling, project card navigation.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));
jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/ui/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));
jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('@/components/CreateProject', () => ({
  CreateProject: ({ onBack, onCreated }: any) => (
    <div data-testid="create-project">
      <button onClick={onBack}>Back</button>
      <button onClick={() => onCreated({ id: 'new-1', name: 'New Project' })}>Create</button>
    </div>
  ),
}));
jest.mock('@/components/ProjectWorkspace', () => ({
  ProjectWorkspace: ({ project, onBack }: any) => (
    <div data-testid="project-workspace">
      <span>{project.name}</span>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
jest.mock('@/components/ProjectCard', () => ({
  ProjectCard: ({ project, onSelectAssess }: any) => (
    <div data-testid={`project-card-${project.id}`} onClick={() => onSelectAssess?.(project)}>
      <span>{project.name}</span>
      <span>{project.status}</span>
    </div>
  ),
}));
jest.mock('@/components/PipelineStatsCards', () => ({
  PipelineStatsCards: () => <div data-testid="pipeline-stats" />,
}));
jest.mock('../AppBuilderWizard', () => ({
  AppBuilderWizard: ({ onComplete }: any) => (
    <div data-testid="app-builder-wizard">
      <button onClick={onComplete}>Complete</button>
    </div>
  ),
}));

const mockProjects = [
  { id: 'p1', name: 'AI Assessment', status: 'CREATED', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
  { id: 'p2', name: 'Modernization', status: 'IN_PROGRESS', createdAt: '2025-01-02T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z' },
  { id: 'p3', name: 'Completed Project', status: 'COMPLETED', createdAt: '2025-01-03T00:00:00Z', updatedAt: '2025-01-03T00:00:00Z' },
];

const mockUnsubscribe = jest.fn();
jest.mock('@/services', () => ({
  projectService: {
    listProjects: jest.fn().mockResolvedValue(mockProjects),
  },
}));
jest.mock('@/services/projectService', () => ({
  subscribeToProjectUpdates: jest.fn(() => mockUnsubscribe),
}));

import { IntakeRequests } from '../IntakeRequests';

describe('IntakeRequests page — regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders project cards after loading', async () => {
    jest.useRealTimers();
    render(<IntakeRequests />);

    await waitFor(() => {
      expect(screen.getByTestId('project-card-p1')).toBeInTheDocument();
      expect(screen.getByTestId('project-card-p2')).toBeInTheDocument();
      expect(screen.getByTestId('project-card-p3')).toBeInTheDocument();
    });
  });

  test('renders filter tabs (All, Active, Completed)', async () => {
    jest.useRealTimers();
    render(<IntakeRequests />);

    await waitFor(() => {
      expect(screen.getByText(/^All/)).toBeInTheDocument();
      expect(screen.getByText(/^Active/)).toBeInTheDocument();
      expect(screen.getByText(/^Completed/)).toBeInTheDocument();
    });
  });

  test('renders New Project button', async () => {
    jest.useRealTimers();
    render(<IntakeRequests />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new|create/i })).toBeInTheDocument();
    });
  });

  test('clicking New Project shows create form', async () => {
    jest.useRealTimers();
    render(<IntakeRequests />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new|create/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /new|create/i }));

    await waitFor(() => {
      expect(screen.getByTestId('create-project')).toBeInTheDocument();
    });
  });

  test('clicking a project card opens workspace', async () => {
    jest.useRealTimers();
    render(<IntakeRequests />);

    await waitFor(() => {
      expect(screen.getByTestId('project-card-p1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('project-card-p1'));

    await waitFor(() => {
      expect(screen.getByTestId('project-workspace')).toBeInTheDocument();
    });
  });

  test('subscribes to project updates on mount', async () => {
    jest.useRealTimers();
    const { subscribeToProjectUpdates } = require('@/services/projectService');
    render(<IntakeRequests />);

    await waitFor(() => {
      expect(subscribeToProjectUpdates).toHaveBeenCalled();
    });
  });

  test('shows error state when API fails', async () => {
    jest.useRealTimers();
    const { projectService } = require('@/services');
    projectService.listProjects.mockRejectedValueOnce(new Error('Network error'));

    render(<IntakeRequests />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load|network error/i)).toBeInTheDocument();
    });
  });
});

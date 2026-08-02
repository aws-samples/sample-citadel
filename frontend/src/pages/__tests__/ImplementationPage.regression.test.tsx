/**
 * Regression tests for the ImplementationPage.
 *
 * Covers: loading state, document rendering (markdown), error state with
 * retry, empty state, back button, refresh button.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));
jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: any) => <div className={className}>{children}</div>,
}));
jest.mock('react-markdown', () => ({ children }: any) => <div data-testid="markdown">{children}</div>);
jest.mock('remark-gfm', () => () => {});

const mockGetProjectDocument = jest.fn();
jest.mock('@/services/documentService', () => ({
  getProjectDocument: (...args: any[]) => mockGetProjectDocument(...args),
}));

import { ImplementationPage } from '../ImplementationPage';

describe('ImplementationPage — regression', () => {
  const defaultProps = {
    projectId: 'proj-123',
    projectName: 'AI Assessment',
    onBack: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('shows loading spinner initially', () => {
    mockGetProjectDocument.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ImplementationPage {...defaultProps} />);

    expect(screen.getByText(/loading implementation/i)).toBeInTheDocument();
  });

  test('renders markdown content on success', async () => {
    mockGetProjectDocument.mockResolvedValue({ content: '# Hello World\n\nSome content.' });
    render(<ImplementationPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('markdown')).toBeInTheDocument();
      expect(screen.getByText(/# Hello World/)).toBeInTheDocument();
    });
  });

  test('shows error state with retry button on failure', async () => {
    mockGetProjectDocument.mockRejectedValue(new Error('Network timeout'));
    render(<ImplementationPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Network timeout')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });
  });

  test('retry button re-fetches the document', async () => {
    mockGetProjectDocument
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce({ content: '# Recovered' });

    render(<ImplementationPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByTestId('markdown')).toBeInTheDocument();
    });

    expect(mockGetProjectDocument).toHaveBeenCalledTimes(2);
  });

  test('shows empty state when document is null', async () => {
    mockGetProjectDocument.mockResolvedValue({ content: null });
    render(<ImplementationPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/no implementation recommendations/i)).toBeInTheDocument();
    });
  });

  test('shows empty state when document response is null', async () => {
    mockGetProjectDocument.mockResolvedValue(null);
    render(<ImplementationPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/no implementation recommendations/i)).toBeInTheDocument();
    });
  });

  test('Back button calls onBack', async () => {
    mockGetProjectDocument.mockResolvedValue({ content: '# Test' });
    render(<ImplementationPage {...defaultProps} />);

    const backBtn = screen.getByRole('button', { name: /back/i });
    fireEvent.click(backBtn);

    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  test('Refresh button re-fetches document', async () => {
    mockGetProjectDocument.mockResolvedValue({ content: '# Initial' });
    render(<ImplementationPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('markdown')).toBeInTheDocument();
    });

    mockGetProjectDocument.mockResolvedValue({ content: '# Updated' });
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(mockGetProjectDocument).toHaveBeenCalledTimes(2);
    });
  });

  test('displays project name in header', async () => {
    mockGetProjectDocument.mockResolvedValue({ content: '# Test' });
    render(<ImplementationPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('AI Assessment')).toBeInTheDocument();
    });
  });

  test('fetches the correct document path', async () => {
    mockGetProjectDocument.mockResolvedValue({ content: '# Test' });
    render(<ImplementationPage {...defaultProps} />);

    await waitFor(() => {
      expect(mockGetProjectDocument).toHaveBeenCalledWith('proj-123', 'design/technical_design.md');
    });
  });
});

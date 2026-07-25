/**
 * EstimateBadge / UnpricedChip tests
 *
 * Covers honest-state rendering rules: EstimateBadge shown whenever any
 * row is estimate:true (i.e. whenever `show` is true), hidden otherwise;
 * UnpricedChip shows the count whenever unpricedRows > 0, hidden at 0.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { EstimateBadge } from '../EstimateBadge';
import { UnpricedChip } from '../UnpricedChip';

describe('EstimateBadge', () => {
  it('renders the "Estimate" label when show is true', () => {
    render(<EstimateBadge show={true} />);
    expect(screen.getByText('Estimate')).toBeInTheDocument();
  });

  it('renders nothing when show is false', () => {
    const { container } = render(<EstimateBadge show={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UnpricedChip', () => {
  it('renders the unpriced count when count > 0', () => {
    render(<UnpricedChip count={7} />);
    expect(screen.getByText('7 unpriced')).toBeInTheDocument();
  });

  it('renders nothing when count is 0', () => {
    const { container } = render(<UnpricedChip count={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when count is negative', () => {
    const { container } = render(<UnpricedChip count={-1} />);
    expect(container).toBeEmptyDOMElement();
  });
});

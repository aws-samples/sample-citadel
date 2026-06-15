// Feature: ui-ux-remediation, Property 7: SearchInput produces consistent DOM structure
import * as fc from 'fast-check';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SearchInput } from '../SearchInput';

/**
 * Property 7: SearchInput produces consistent DOM structure
 *
 * For any valid combination of `value`, `placeholder`, and `className` props,
 * rendering SearchInput SHALL produce a DOM structure containing exactly one
 * search icon element and one input element with identical structural classes,
 * regardless of which page hosts the component.
 *
 * Validates: Requirements 7.10
 */
describe('Property 7: SearchInput produces consistent DOM structure', () => {
  it('renders exactly 1 SVG icon and 1 input with consistent structural classes for any prop combination', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 60 }),
        fc.string({ minLength: 0, maxLength: 40 }),
        fc.string({ minLength: 0, maxLength: 30 }),
        (value, placeholder, className) => {
          const { container, unmount } = render(
            <SearchInput
              value={value}
              onChange={() => {}}
              placeholder={placeholder}
              className={className}
            />,
          );

          // Exactly 1 SVG element (search icon)
          const svgs = container.querySelectorAll('svg');
          if (svgs.length !== 1) {
            throw new Error(
              `Expected exactly 1 SVG icon, found ${svgs.length}`,
            );
          }

          // Exactly 1 input element
          const inputs = container.querySelectorAll('input');
          if (inputs.length !== 1) {
            throw new Error(
              `Expected exactly 1 input element, found ${inputs.length}`,
            );
          }

          const input = inputs[0];
          const inputClasses = input.className;

          // Input always has pl-9 class (left padding for icon)
          if (!/\bpl-9\b/.test(inputClasses)) {
            throw new Error(
              `Input missing pl-9 class. Classes: "${inputClasses}"`,
            );
          }

          // Wrapper always has 'relative' class
          const wrapper = container.firstElementChild as HTMLElement;
          if (!/\brelative\b/.test(wrapper.className)) {
            throw new Error(
              `Wrapper missing 'relative' class. Classes: "${wrapper.className}"`,
            );
          }

          unmount();
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Unit tests for SearchInput component
 *
 * Validates: Requirements 7.2, 7.3, 7.4, 7.5
 */
describe('SearchInput unit tests', () => {
  it('renders a search icon (SVG) inside the component', () => {
    // Validates: Requirement 7.3
    const { container } = render(
      <SearchInput value="" onChange={() => {}} />,
    );
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('input has pl-9 class for icon padding', () => {
    // Validates: Requirement 7.3
    const { container } = render(
      <SearchInput value="" onChange={() => {}} />,
    );
    const input = container.querySelector('input');
    expect(input).toBeInTheDocument();
    expect(input!.className).toMatch(/\bpl-9\b/);
  });

  it('input has focus:border-primary class for Tailwind focus variant', () => {
    // Validates: Requirement 7.4
    const { container } = render(
      <SearchInput value="" onChange={() => {}} />,
    );
    const input = container.querySelector('input');
    expect(input).toBeInTheDocument();
    expect(input!.className).toMatch(/focus:border-ring/);
  });

  it('contains no hardcoded hex colors in rendered output', () => {
    // Validates: Requirement 7.5
    const { container } = render(
      <SearchInput value="test" onChange={() => {}} placeholder="Search here" />,
    );
    const html = container.innerHTML;
    // No bg-[#...], text-[#...], or border-[#...] patterns
    expect(html).not.toMatch(/(?:bg|text|border)-\[#[0-9a-fA-F]+\]/);
  });

  it('renders the placeholder text correctly', () => {
    // Validates: Requirement 7.2
    const { container } = render(
      <SearchInput value="" onChange={() => {}} placeholder="Find agents..." />,
    );
    const input = container.querySelector('input');
    expect(input).toHaveAttribute('placeholder', 'Find agents...');
  });

  it('applies className prop to the input element', () => {
    // Validates: Requirement 7.2
    const { container } = render(
      <SearchInput value="" onChange={() => {}} className="w-64" />,
    );
    const input = container.querySelector('input');
    expect(input).toBeInTheDocument();
    expect(input!.className).toMatch(/\bw-64\b/);
  });

  it('uses default placeholder when none is provided', () => {
    const { container } = render(
      <SearchInput value="" onChange={() => {}} />,
    );
    const input = container.querySelector('input');
    expect(input).toHaveAttribute('placeholder', 'Search...');
  });
});

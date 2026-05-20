import { useRef, useState, useEffect, ReactNode } from 'react';

interface LazyLoadSectionProps {
  children: ReactNode;
  fallback: ReactNode;
  /** IntersectionObserver rootMargin — how far before the viewport to trigger */
  rootMargin?: string;
}

/**
 * IntersectionObserver-based lazy load wrapper.
 * Renders `fallback` (skeleton) until the section scrolls into view,
 * then renders `children`. Once visible, stays visible permanently.
 *
 * Requirement 15.7: Lazy_Loading using IntersectionObserver
 */
export function LazyLoadSection({
  children,
  fallback,
  rootMargin = '200px',
}: LazyLoadSectionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  return (
    <div ref={ref} data-testid="lazy-load-section">
      {isVisible ? children : fallback}
    </div>
  );
}

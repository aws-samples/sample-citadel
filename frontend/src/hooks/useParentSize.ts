import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hook that tracks the width and height of a container element via
 * ResizeObserver. Returns a ref to attach to the container and the
 * current `{ width, height }`.
 *
 * Replaces the `@visx/responsive` `<ParentSize>` render-prop pattern
 * with a hook-based approach that avoids the external dependency.
 */
export function useParentSize<T extends HTMLElement = HTMLDivElement>(): {
  ref: React.RefCallback<T>;
  width: number;
  height: number;
} {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    // Disconnect previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!node) return;

    // Read initial size synchronously
    const rect = node.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });

    // Observe future resizes (skip when ResizeObserver is unavailable, e.g. jsdom)
    if (typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          setSize((prev) =>
            prev.width === width && prev.height === height
              ? prev
              : { width, height },
          );
        }
      });
      observerRef.current.observe(node);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  return { ref, ...size };
}

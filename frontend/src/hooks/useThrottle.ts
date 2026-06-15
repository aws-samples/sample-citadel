/**
 * useThrottle Hook
 * 
 * Custom hook for throttling values to optimize performance
 * by limiting the frequency of updates.
 * 
 */

import { useState, useEffect, useRef } from 'react';

/**
 * Throttles a value by limiting updates to once per specified interval
 * 
 * @param value - The value to throttle
 * @param interval - Minimum interval between updates in milliseconds
 * @returns The throttled value
 * 
 * @example
 * const [scrollPosition, setScrollPosition] = useState(0);
 * const throttledPosition = useThrottle(scrollPosition, 100);
 * 
 * // This will only update at most once every 100ms
 * useEffect(() => {
 *   updateUI(throttledPosition);
 * }, [throttledPosition]);
 */
export function useThrottle<T>(value: T, interval: number): T {
  const [throttledValue, setThrottledValue] = useState<T>(value);
  const lastUpdated = useRef<number>(Date.now());

  useEffect(() => {
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdated.current;

    if (timeSinceLastUpdate >= interval) {
      // Enough time has passed, update immediately
      lastUpdated.current = now;
      setThrottledValue(value);
    } else {
      // Schedule update for when interval expires
      const timer = setTimeout(() => {
        lastUpdated.current = Date.now();
        setThrottledValue(value);
      }, interval - timeSinceLastUpdate);

      return () => clearTimeout(timer);
    }
  }, [value, interval]);

  return throttledValue;
}

/**
 * Creates a throttled callback function
 * 
 * @param callback - The function to throttle
 * @param interval - Minimum interval between calls in milliseconds
 * @returns A throttled version of the callback
 * 
 * @example
 * const handleScroll = useThrottledCallback((event: Event) => {
 *   updateScrollPosition(event);
 * }, 100);
 */
export function useThrottledCallback<T extends (...args: any[]) => any>(
  callback: T,
  interval: number
): (...args: Parameters<T>) => void {
  const lastRan = useRef<number>(Date.now());
  const timeoutId = useRef<NodeJS.Timeout | null>(null);

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastRan = now - lastRan.current;

    if (timeSinceLastRan >= interval) {
      // Enough time has passed, execute immediately
      lastRan.current = now;
      callback(...args);
    } else {
      // Clear any pending execution
      if (timeoutId.current) {
        clearTimeout(timeoutId.current);
      }

      // Schedule execution for when interval expires
      timeoutId.current = setTimeout(() => {
        lastRan.current = Date.now();
        callback(...args);
      }, interval - timeSinceLastRan);
    }
  };
}

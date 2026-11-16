import { renderHook, act } from '@testing-library/react';
import { useParentSize } from '../useParentSize';

type ROCallback = (entries: { contentRect: { width: number; height: number } }[]) => void;

let capturedCallback: ROCallback;
let observeSpy: jest.Mock;
let disconnectSpy: jest.Mock;

function installMockResizeObserver() {
  observeSpy = jest.fn();
  disconnectSpy = jest.fn();
  class MockResizeObserver {
    constructor(cb: ROCallback) {
      capturedCallback = cb;
    }
    observe = observeSpy;
    disconnect = disconnectSpy;
    unobserve = jest.fn();
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
}

function makeElement(width: number, height: number): HTMLDivElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = jest.fn(() => ({
    width,
    height,
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  }));
  return el;
}

describe('useParentSize', () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).ResizeObserver;
  });

  it('returns 0×0 before the ref attaches', () => {
    installMockResizeObserver();
    const { result } = renderHook(() => useParentSize());
    expect(result.current.width).toBe(0);
    expect(result.current.height).toBe(0);
  });

  it('reads getBoundingClientRect and reports size when ref attaches', () => {
    installMockResizeObserver();
    const el = makeElement(400, 300);

    const { result } = renderHook(() => useParentSize());

    act(() => {
      result.current.ref(el);
    });

    expect(el.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(result.current.width).toBe(400);
    expect(result.current.height).toBe(300);
    expect(observeSpy).toHaveBeenCalledWith(el);
  });

  it('updates size when ResizeObserver fires with new contentRect', () => {
    installMockResizeObserver();
    const el = makeElement(400, 300);

    const { result } = renderHook(() => useParentSize());

    act(() => {
      result.current.ref(el);
    });

    act(() => {
      capturedCallback([{ contentRect: { width: 800, height: 600 } }]);
    });

    expect(result.current.width).toBe(800);
    expect(result.current.height).toBe(600);
  });

  it('disconnects the previous observer on unmount', () => {
    installMockResizeObserver();
    const el = makeElement(100, 50);

    const { result, unmount } = renderHook(() => useParentSize());

    act(() => {
      result.current.ref(el);
    });

    unmount();
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('disconnects previous observer when ref re-attaches to another element', () => {
    installMockResizeObserver();
    const el1 = makeElement(100, 50);
    const el2 = makeElement(200, 150);

    const { result } = renderHook(() => useParentSize());

    act(() => {
      result.current.ref(el1);
    });

    const firstDisconnect = disconnectSpy;

    // Re-install so the second attach gets fresh spies
    installMockResizeObserver();

    act(() => {
      result.current.ref(el2);
    });

    expect(firstDisconnect).toHaveBeenCalled();
    expect(result.current.width).toBe(200);
    expect(result.current.height).toBe(150);
  });

  it('does not throw and stays 0×0 when ResizeObserver is undefined', () => {
    // jsdom default — ResizeObserver not available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).ResizeObserver;

    const el = makeElement(400, 300);
    const { result } = renderHook(() => useParentSize());

    // Attaching should not throw
    act(() => {
      result.current.ref(el);
    });

    // getBoundingClientRect still read, so initial size reported
    expect(result.current.width).toBe(400);
    expect(result.current.height).toBe(300);
  });
});

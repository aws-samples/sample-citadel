/**
 * CIT-307: vite:preloadError graceful reload.
 *
 * Verifies the one-shot reload guard:
 * 1. First preload error → calls reload callback once
 * 2. Second preload error (same session) → no second reload
 */
import { registerPreloadErrorGuard } from "../preload-error-guard";

describe("vite:preloadError reload guard", () => {
  let reloadMock: jest.Mock;
  let teardown: () => void;

  beforeEach(() => {
    sessionStorage.clear();
    reloadMock = jest.fn();
    teardown = registerPreloadErrorGuard(reloadMock);
  });

  afterEach(() => {
    teardown();
  });

  function dispatchPreloadError(): void {
    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);
  }

  test("first preload error triggers a reload", () => {
    dispatchPreloadError();

    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("preload-reloaded")).toBe("1");
  });

  test("second preload error does NOT trigger another reload", () => {
    dispatchPreloadError();
    dispatchPreloadError();

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * CIT-307: One-shot reload guard for Vite chunk preload failures.
 *
 * After a deploy, browsers holding a stale index.html may try to lazy-load
 * hashed chunks that have been replaced. Vite emits a `vite:preloadError`
 * event in that case. We reload once (guarded by sessionStorage) so the
 * browser fetches the fresh index.html and its matching chunks.
 */

const SESSION_KEY = "preload-reloaded";

/**
 * Register the preload error guard. Returns a teardown function that removes
 * the listeners (useful in tests).
 */
export function registerPreloadErrorGuard(
  doReload: () => void = () => window.location.reload(),
): () => void {
  const onPreloadError = (e: Event): void => {
    e.preventDefault();
    if (!sessionStorage.getItem(SESSION_KEY)) {
      sessionStorage.setItem(SESSION_KEY, "1");
      doReload();
    }
  };

  // Clear the flag on successful load so a future deploy can trigger
  // another one-shot reload.
  const onLoad = (): void => {
    sessionStorage.removeItem(SESSION_KEY);
  };

  window.addEventListener("vite:preloadError", onPreloadError);
  window.addEventListener("load", onLoad);

  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    window.removeEventListener("load", onLoad);
  };
}

/**
 * Thin wrapper around `window.location.assign` for full-page external
 * navigation (e.g. OAuth 3LO redirect). Extracted as a module so unit tests
 * can mock it; jsdom's `Location.prototype.assign` is not redefinable in the
 * usual ways.
 */
export function navigateExternal(url: string): void {
  window.location.assign(url);
}

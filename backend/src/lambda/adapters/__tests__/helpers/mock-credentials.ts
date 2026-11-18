/**
 * Shared mock credentials for adapter tests.
 * All adapter data-plane operations now require scoped credentials;
 * tests must pass these to avoid CredentialMissingError.
 *
 * H4 (Citadel PR-1): `requireScopedCredentials` now also enforces a
 * non-forgeable provenance marker (a WeakSet only `markScopedCredentials`
 * can add to) in addition to the field-presence check. This fixture is
 * marked once, here, so every existing test that imports it continues to
 * satisfy the guard without each test needing to know about the marker.
 */
import { markScopedCredentials } from "../../credential-guard";

export const MOCK_SCOPED_CREDENTIALS = markScopedCredentials({
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "FwoGZXIvYXdzEBY…EXAMPLE",
});

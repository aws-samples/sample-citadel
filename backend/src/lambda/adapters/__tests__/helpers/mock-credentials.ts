/**
 * Shared mock credentials for adapter tests.
 * All adapter data-plane operations now require scoped credentials;
 * tests must pass these to avoid CredentialMissingError.
 */
export const MOCK_SCOPED_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "FwoGZXIvYXdzEBY…EXAMPLE",
};

/**
 * Shared error for agent-source adapter capabilities that are not yet
 * implemented.
 *
 * The invocation-dispatcher story implements ONLY `invoke()` on each adapter;
 * discover / describe / healthCheck / vendCredentials are filled in by later
 * import stories and throw this until then.
 */
export class NotImplementedError extends Error {
  constructor(message = 'implemented in a later story') {
    super(message);
    this.name = 'NotImplementedError';
    // Preserve the prototype chain so `instanceof NotImplementedError` holds
    // even when transpiled to a lower target.
    Object.setPrototypeOf(this, NotImplementedError.prototype);
  }
}

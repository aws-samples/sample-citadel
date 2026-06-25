/**
 * HTTP_ENDPOINT adapter.
 *
 * POSTs a JSON body to `descriptor.invocation.target`. When auth.mode is
 * SIGV4 the request is signed with SignatureV4 (the same approach the legacy
 * handler uses for AppSync) before sending; otherwise it is sent as-is.
 * API_KEY / OAUTH2 secret resolution is a TODO stub for a later story.
 * Only invoke() is implemented for now.
 */
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { AgentSourceAdapter } from './base';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  AgentInvocationProtocol,
  HealthCheckResult,
  InvokeRequest,
  InvokeResponse,
  VendedCredentials,
} from './base';
import { NotImplementedError } from './not-implemented';
import { NO_RESPONSE_TEXT, extractTextOutput } from './invoke-support';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';

/** Minimal signer surface so tests can inject a double. */
export interface HttpSigner {
  sign(request: HttpRequest): Promise<{ headers: Record<string, string> }>;
}
export type HttpSignerFactory = (region: string) => HttpSigner;

export interface HttpEndpointAdapterDeps {
  fetchFn?: typeof fetch;
  signerFactory?: HttpSignerFactory;
}

const defaultSignerFactory: HttpSignerFactory = (region: string): HttpSigner => {
  const signer = new SignatureV4({
    service: 'execute-api',
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  return { sign: (request: HttpRequest) => signer.sign(request) };
};

export class HttpEndpointAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'HTTP_ENDPOINT';
  private readonly fetchFn: typeof fetch;
  private readonly signerFactory: HttpSignerFactory;

  constructor(deps: HttpEndpointAdapterDeps = {}) {
    // Late-bind to the current global fetch so test stubs are honoured.
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.signerFactory = deps.signerFactory ?? defaultSignerFactory;
  }

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, auth, region } = descriptor.invocation;
    const body = JSON.stringify({
      prompt: req.prompt,
      session_id: req.sessionId,
      attributes: req.attributes ?? {},
    });
    const url = new URL(target);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      host: url.hostname,
    };

    let requestHeaders: Record<string, string> = headers;

    if (auth.mode === 'SIGV4') {
      const request = new HttpRequest({
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname + (url.search || ''),
        headers,
        body,
      });
      const signed = await this.signerFactory(region || DEFAULT_REGION).sign(request);
      requestHeaders = signed.headers;
    } else if (auth.secretRef) {
      // TODO(import-auth): resolve auth.secretRef from Secrets Manager and
      // attach the API_KEY / OAUTH2 credential header here. Sent unauthenticated
      // for now (handled in a later import story).
    }

    const response = await this.fetchFn(target, {
      method: 'POST',
      headers: requestHeaders,
      body,
    });
    const text = await response.text();
    return { output: extractTextOutput(text) || NO_RESPONSE_TEXT, raw: text };
  }

  async discover(_scope: unknown): Promise<AgentCandidate[]> {
    throw new NotImplementedError();
  }
  async describe(_ref: AgentCandidate | string): Promise<AgentCapabilityDescriptor> {
    throw new NotImplementedError();
  }
  async healthCheck(_ref: AgentCandidate | string): Promise<HealthCheckResult> {
    throw new NotImplementedError();
  }
  async vendCredentials(_ref: AgentCandidate | string): Promise<VendedCredentials> {
    throw new NotImplementedError();
  }
}

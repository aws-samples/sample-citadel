/**
 * LAMBDA_INVOKE adapter.
 *
 * Invokes a Lambda function (`descriptor.invocation.target`) via InvokeCommand.
 * InvocationType is 'RequestResponse' for sync mode and 'Event' for
 * async_callback mode. Only invoke() is implemented for now.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
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
import type { CommandSender } from './invoke-support';
import { NO_RESPONSE_TEXT, bytesToString, extractTextOutput } from './invoke-support';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';

export class LambdaInvokeAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'LAMBDA_INVOKE';

  constructor(private readonly sender?: CommandSender) {}

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, region, mode } = descriptor.invocation;
    const invocationType = mode === 'async_callback' ? 'Event' : 'RequestResponse';

    const command = new InvokeCommand({
      FunctionName: target,
      InvocationType: invocationType,
      Payload: new TextEncoder().encode(
        JSON.stringify({
          prompt: req.prompt,
          session_id: req.sessionId,
          attributes: req.attributes ?? {},
        }),
      ),
    });

    const response = this.sender
      ? await this.sender.send(command)
      : await new LambdaClient({ region: region || DEFAULT_REGION }).send(command);

    // Async ('Event') invocations return no payload (HTTP 202); the real
    // result arrives later out-of-band, so there is no synchronous text.
    if (invocationType === 'Event') {
      return { output: '', raw: response };
    }

    const payloadText = bytesToString((response as { Payload?: unknown }).Payload);
    return { output: extractTextOutput(payloadText) || NO_RESPONSE_TEXT, raw: response };
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

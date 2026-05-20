/**
 * Custom Resource Lambda for provisioning an AgentCore Registry.
 *
 * CloudFormation does not yet have a native resource type for AgentCore Registry,
 * so this Lambda backs a CDK CustomResource to manage the registry lifecycle
 * (Create / Update / Delete).
 */
import {
  BedrockAgentCoreControlClient,
  CreateRegistryCommand,
  DeleteRegistryCommand,
  GetRegistryCommand,
  ListRegistriesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';

const client = new BedrockAgentCoreControlClient({});

async function sendResponse(
  event: CloudFormationCustomResourceEvent,
  status: 'SUCCESS' | 'FAILED',
  data: Record<string, string> = {},
  physicalResourceId?: string,
  reason?: string,
): Promise<void> {
  const body = JSON.stringify({
    Status: status,
    Reason: reason ?? `See CloudWatch Log Stream: ${process.env.AWS_LAMBDA_LOG_STREAM_NAME}`,
    PhysicalResourceId: physicalResourceId ?? event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  } satisfies CloudFormationCustomResourceResponse);

  await fetch(event.ResponseURL, {
    method: 'PUT',
    headers: { 'Content-Type': '' },
    body,
  });
}

export async function handler(event: CloudFormationCustomResourceEvent): Promise<void> {
  console.log('Event:', JSON.stringify(event));

  const props = event.ResourceProperties;
  const registryName: string = props.RegistryName;
  const autoApproval: boolean = props.AutoApproval === 'true';
  const description: string | undefined = props.Description || undefined;

  try {
    switch (event.RequestType) {
      case 'Create': {
        let registryArn: string;
        try {
          const result = await client.send(
            new CreateRegistryCommand({
              name: registryName,
              description,
              approvalConfiguration: { autoApproval },
            }),
          );
          registryArn = result.registryArn!;
        } catch (createErr: any) {
          if (createErr.name === 'ConflictException' || createErr.name === 'ResourceAlreadyExistsException') {
            console.log('Registry already exists, looking it up...');
            const list = await client.send(new ListRegistriesCommand({}));
            const existing = list.registries?.find(r => r.name === registryName);
            if (!existing?.registryArn) throw new Error(`Registry ${registryName} exists but could not be found`);
            registryArn = existing.registryArn;
          } else {
            throw createErr;
          }
        }

        const registryId = registryArn.split('/').pop()!;
        await sendResponse(event, 'SUCCESS', {
          RegistryArn: registryArn,
          RegistryId: registryId,
        }, registryArn);
        break;
      }

      case 'Update': {
        const physicalId = (event as any).PhysicalResourceId as string;

        // Check if the existing registry is still alive
        let registryArn = physicalId;
        try {
          const existing = await client.send(new GetRegistryCommand({ registryId: physicalId.split('/').pop()! }));
          const status = existing.status as string;
          if (status === 'CREATE_FAILED' || status === 'DELETING' || status === 'DELETE_FAILED') {
            throw new Error(`Registry in bad state: ${existing.status}`);
          }
        } catch {
          // Registry is gone or failed — find or create a replacement
          console.log('Existing registry unavailable, finding or creating replacement...');
          try {
            const result = await client.send(
              new CreateRegistryCommand({ name: registryName, description, approvalConfiguration: { autoApproval } }),
            );
            registryArn = result.registryArn!;
          } catch (createErr: any) {
            if (createErr.name === 'ConflictException' || createErr.name === 'ResourceAlreadyExistsException') {
              const list = await client.send(new ListRegistriesCommand({}));
              const found = list.registries?.find(r => r.name === registryName);
              if (!found?.registryArn) throw new Error(`Registry ${registryName} conflict but not found`);
              registryArn = found.registryArn;
            } else {
              throw createErr;
            }
          }
        }

        const registryId = registryArn.split('/').pop()!;
        await sendResponse(event, 'SUCCESS', {
          RegistryArn: registryArn,
          RegistryId: registryId,
        }, registryArn);
        break;
      }

      case 'Delete': {
        const physicalId = (event as any).PhysicalResourceId as string;
        const registryId = physicalId.split('/').pop()!;

        try {
          await client.send(new DeleteRegistryCommand({ registryId }));
        } catch (err: any) {
          // Ignore if already deleted
          if (err.name !== 'ResourceNotFoundException') {
            console.warn('Delete registry error (non-fatal):', err.message);
          }
        }

        await sendResponse(event, 'SUCCESS', {}, physicalId);
        break;
      }
    }
  } catch (err: any) {
    console.error('Registry provisioner error:', err);
    await sendResponse(
      event,
      'FAILED',
      {},
      (event as any).PhysicalResourceId ?? event.LogicalResourceId,
      err.message,
    );
  }
}

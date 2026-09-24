/**
 * Custom Resource Lambda for provisioning an Agent Registry (GA namespace).
 *
 * CloudFormation does not yet have a native resource type for Agent Registry,
 * so this Lambda backs a CDK CustomResource to manage the registry lifecycle
 * (Create / Update / Delete). ARNs are of the form
 * `arn:aws:agent-registry:<region>:<account>:registry/<registryId>`.
 */
import {
  AgentRegistryControlClient,
  CreateRegistryCommand,
  DeleteRegistryCommand,
  GetRegistryCommand,
  ListRegistriesCommand,
  AutoApprovalRule,
} from "@aws-sdk/client-agent-registry-control";
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from "aws-lambda";

const client = new AgentRegistryControlClient({});

async function sendResponse(
  event: CloudFormationCustomResourceEvent,
  status: "SUCCESS" | "FAILED",
  data: Record<string, string> = {},
  physicalResourceId?: string,
  reason?: string,
): Promise<void> {
  const body = JSON.stringify({
    Status: status,
    Reason:
      reason ??
      `See CloudWatch Log Stream: ${process.env.AWS_LAMBDA_LOG_STREAM_NAME}`,
    PhysicalResourceId: physicalResourceId ?? event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  } satisfies CloudFormationCustomResourceResponse);

  await fetch(event.ResponseURL, {
    method: "PUT",
    headers: { "Content-Type": "" },
    body,
  });
}

export async function handler(
  event: CloudFormationCustomResourceEvent,
): Promise<void> {
  console.log("Event:", JSON.stringify(event));

  const props = event.ResourceProperties;
  const registryName: string = props.RegistryName;
  const autoApproval: boolean = props.AutoApproval === "true";
  const description: string | undefined = props.Description || undefined;
  // GA shape: the old boolean `autoApproval` flag is now expressed as a list
  // of auto-approval rules. APPROVE_ALL preserves the auto-approve-all
  // semantics used for dev; an empty/undefined list means every submitted
  // record requires manual review (the previous `autoApproval: false`
  // behaviour).
  const approvalConfiguration = {
    autoApprovalRules: autoApproval
      ? [AutoApprovalRule.APPROVE_ALL]
      : undefined,
  };

  try {
    switch (event.RequestType) {
      case "Create": {
        let registryArn: string;
        try {
          const result = await client.send(
            new CreateRegistryCommand({
              name: registryName,
              description,
              approvalConfiguration,
            }),
          );
          registryArn = result.registryArn!;
        } catch (createErr: unknown) {
          if (
            createErr instanceof Error &&
            (createErr.name === "ConflictException" ||
              createErr.name === "ResourceAlreadyExistsException")
          ) {
            console.log("Registry already exists, looking it up...");
            const list = await client.send(new ListRegistriesCommand({}));
            const existing = list.registries?.find(
              (r) => r.name === registryName,
            );
            if (!existing?.registryArn)
              throw new Error(
                `Registry ${registryName} exists but could not be found`,
              );
            registryArn = existing.registryArn;
          } else {
            throw createErr;
          }
        }

        const registryId = registryArn.split("/").pop()!;
        await sendResponse(
          event,
          "SUCCESS",
          {
            RegistryArn: registryArn,
            RegistryId: registryId,
          },
          registryArn,
        );
        break;
      }

      case "Update": {
        const physicalId = event.PhysicalResourceId;

        // Check if the existing registry is still alive
        let registryArn = physicalId;
        try {
          const existing = await client.send(
            new GetRegistryCommand({
              registryId: physicalId.split("/").pop()!,
            }),
          );
          const status = existing.status as string;
          if (
            status === "CREATE_FAILED" ||
            status === "DELETING" ||
            status === "DELETE_FAILED"
          ) {
            throw new Error(`Registry in bad state: ${existing.status}`);
          }
        } catch {
          // Registry is gone or failed — find or create a replacement
          console.log(
            "Existing registry unavailable, finding or creating replacement...",
          );
          try {
            const result = await client.send(
              new CreateRegistryCommand({
                name: registryName,
                description,
                approvalConfiguration,
              }),
            );
            registryArn = result.registryArn!;
          } catch (createErr: unknown) {
            if (
              createErr instanceof Error &&
              (createErr.name === "ConflictException" ||
                createErr.name === "ResourceAlreadyExistsException")
            ) {
              const list = await client.send(new ListRegistriesCommand({}));
              const found = list.registries?.find(
                (r) => r.name === registryName,
              );
              if (!found?.registryArn)
                throw new Error(
                  `Registry ${registryName} conflict but not found`,
                );
              registryArn = found.registryArn;
            } else {
              throw createErr;
            }
          }
        }

        const registryId = registryArn.split("/").pop()!;
        await sendResponse(
          event,
          "SUCCESS",
          {
            RegistryArn: registryArn,
            RegistryId: registryId,
          },
          registryArn,
        );
        break;
      }

      case "Delete": {
        const physicalId = event.PhysicalResourceId;
        const registryId = physicalId.split("/").pop()!;

        try {
          await client.send(new DeleteRegistryCommand({ registryId }));
        } catch (err: unknown) {
          // Ignore if already deleted
          if (
            !(err instanceof Error) ||
            err.name !== "ResourceNotFoundException"
          ) {
            console.warn(
              "Delete registry error (non-fatal):",
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        await sendResponse(event, "SUCCESS", {}, physicalId);
        break;
      }
    }
  } catch (err: unknown) {
    console.error("Registry provisioner error:", err);
    await sendResponse(
      event,
      "FAILED",
      {},
      (event as { PhysicalResourceId?: string }).PhysicalResourceId ??
        event.LogicalResourceId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

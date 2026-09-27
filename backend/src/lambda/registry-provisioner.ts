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
  ListRegistryRecordsCommand,
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
        const registryId = physicalId.split("/").pop()!;

        // Check if the existing registry is still alive
        let registryArn = physicalId;
        let needsReplacement = false;
        try {
          const existing = await client.send(
            new GetRegistryCommand({ registryId }),
          );
          const status = existing.status as string;
          if (
            status === "CREATE_FAILED" ||
            status === "DELETING" ||
            status === "DELETE_FAILED"
          ) {
            throw new Error(`Registry in bad state: ${existing.status}`);
          }
        } catch (getErr: unknown) {
          const errName =
            getErr instanceof Error ? getErr.name : "UnknownError";
          const httpStatus = (
            getErr as { $metadata?: { httpStatusCode?: number } }
          )?.$metadata?.httpStatusCode;
          const isThrottling =
            errName === "ThrottlingException" ||
            errName === "TooManyRequestsException" ||
            (httpStatus !== undefined && httpStatus >= 500);

          if (errName === "ResourceNotFoundException") {
            console.log(
              `GetRegistry error (${errName}): registry is gone, finding or creating replacement...`,
            );
            needsReplacement = true;
          } else if (isThrottling) {
            console.log(
              `GetRegistry error (${errName}): retrying up to 3 times before failing`,
            );
            let lastErr: unknown = getErr;
            let recovered = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              await new Promise((resolve) =>
                setTimeout(resolve, 500 * attempt),
              );
              try {
                const retried = await client.send(
                  new GetRegistryCommand({ registryId }),
                );
                const status = retried.status as string;
                if (
                  status === "CREATE_FAILED" ||
                  status === "DELETING" ||
                  status === "DELETE_FAILED"
                ) {
                  throw new Error(`Registry in bad state: ${retried.status}`);
                }
                recovered = true;
                break;
              } catch (retryErr: unknown) {
                lastErr = retryErr;
                console.log(
                  `GetRegistry retry ${attempt} failed (${
                    retryErr instanceof Error ? retryErr.name : "UnknownError"
                  })`,
                );
              }
            }
            if (!recovered) {
              throw lastErr;
            }
          } else {
            console.log(`GetRegistry error (${errName}): failing update`);
            throw new Error(
              `GetRegistry failed with ${errName}: ${
                getErr instanceof Error ? getErr.message : String(getErr)
              }`,
            );
          }
        }

        if (needsReplacement) {
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

        const finalRegistryId = registryArn.split("/").pop()!;
        await sendResponse(
          event,
          "SUCCESS",
          {
            RegistryArn: registryArn,
            RegistryId: finalRegistryId,
          },
          registryArn,
        );
        break;
      }

      case "Delete": {
        const physicalId = event.PhysicalResourceId;
        const registryId = physicalId.split("/").pop()!;

        const recordsClient = new AgentRegistryControlClient({});
        const existingRecords = await recordsClient.send(
          new ListRegistryRecordsCommand({ registryId, maxResults: 1 }),
        );
        if (
          existingRecords.registryRecords &&
          existingRecords.registryRecords.length > 0
        ) {
          console.log("refusing to delete registry with records; retaining");
          await sendResponse(event, "SUCCESS", {}, physicalId);
          break;
        }

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

import { EventBridgeEvent } from "aws-lambda";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

interface FabricationEventDetail {
  orchestration_id: string;
  agent_use_id?: string;
  data?: string;
  error?: string;
  orgId?: string;
}

const publishFabricationEventMutation = `
  mutation PublishFabricationEvent($input: FabricationEventInput!) {
    publishFabricationEvent(input: $input) {
      type
      requestId
      agentId
      errorMessage
      timestamp
      orgId
    }
  }
`;

async function executeGraphQL(
  query: string,
  variables: Record<string, unknown>,
) {
  const endpoint = new URL(APPSYNC_ENDPOINT);
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: AWS_REGION,
    service: "appsync",
    sha256: Sha256,
  });

  const requestToBeSigned = new HttpRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host: endpoint.host,
    },
    hostname: endpoint.host,
    body: JSON.stringify({ query, variables }),
    path: endpoint.pathname,
  });

  const signed = await signer.sign(requestToBeSigned);
  const response = await fetch(APPSYNC_ENDPOINT, {
    method: "POST",
    headers: signed.headers as HeadersInit,
    body: signed.body as string,
  });

  const result = await response.json();

  if (result.errors) {
    console.error("GraphQL errors:", JSON.stringify(result.errors, null, 2));
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

export const handler = async (
  event: EventBridgeEvent<string, FabricationEventDetail>,
): Promise<void> => {
  console.log("Received fabrication event:", JSON.stringify(event, null, 2));

  try {
    const detail = event.detail;
    const eventType = event["detail-type"];

    // Determine event type
    let fabricationType: "COMPLETED" | "FAILED";
    let errorMessage: string | undefined;

    if (eventType === "agent.fabricated") {
      fabricationType = "COMPLETED";
    } else if (eventType === "agent.fabrication.failed") {
      fabricationType = "FAILED";
      errorMessage = detail.error || detail.data || "Unknown error";
    } else {
      console.log("Ignoring non-fabrication event:", eventType);
      return;
    }

    // Wave-2a tenancy (finding 87a171ad): fail closed — never publish a
    // fabrication event without orgId. The arbiter-side fabrication
    // producer threading orgId onto agent.fabricated/agent.fabrication.failed
    // Detail is tracked separately (finding 87a171ad section C); until
    // then, an event lacking it is dropped here rather than broadcast
    // org-less to every onFabricationEvent subscriber.
    if (!detail.orgId) {
      console.error(
        "Refusing to publish fabrication event: missing orgId on EventBridge detail",
        { eventType, requestId: detail.orchestration_id },
      );
      return;
    }

    // Prepare GraphQL mutation
    const variables = {
      input: {
        type: fabricationType,
        requestId: detail.orchestration_id,
        agentId: detail.agent_use_id,
        errorMessage,
        timestamp: new Date().toISOString(),
        orgId: detail.orgId,
      },
    };

    console.log(
      "Publishing fabrication event to AppSync:",
      JSON.stringify(variables, null, 2),
    );

    // Sign and send request to AppSync
    await executeGraphQL(publishFabricationEventMutation, variables);

    console.log("Successfully published fabrication event to AppSync");
  } catch (error) {
    console.error("Error handling fabrication event:", error);
    throw error;
  }
};

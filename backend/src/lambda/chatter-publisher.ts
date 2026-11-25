import { EventBridgeEvent } from "aws-lambda";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { emitMetrics } from "../utils/emf";
import {
  METRIC_CHATTER_ORG_ID_MISSING,
  UNIT_COUNT,
} from "../utils/metrics-constants";

const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

const publishChatterMutation = `
  mutation PublishChatter($input: AgentChatterInput!) {
    publishChatter(input: $input) {
      id
      timestamp
      source
      detailType
      detail
      orgId
    }
  }
`;

interface ChatterInput {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: unknown;
  orgId: string;
}

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

export const handler = async (event: EventBridgeEvent<string, unknown>) => {
  console.log("Received EventBridge event:", JSON.stringify(event, null, 2));

  try {
    // Wave-2a tenancy (finding 87a171ad): fail closed — never publish
    // chatter without orgId. The Supervisor stamps orgId on every
    // EventBridge Detail it emits (chatter / supervisor.feedback); an
    // event lacking it (e.g. a producer that hasn't been updated, or a
    // non-tenancy event incidentally matching this catch-all rule) is
    // dropped here rather than broadcast org-less to every subscriber.
    //
    // Downgraded from ERROR to WARN (chatter-producer stamping fix):
    // the ChatterRule is now narrowed to the specific sources/detail
    // types the known producers emit, and those producers now stamp
    // orgId — so a refusal here means an unexpected/legacy producer,
    // observability-only rather than a page-worthy failure. The
    // ChatterOrgIdMissing counter metric (EMF, no new IAM grant needed)
    // is the measurable signal for dashboards/alarms in place of
    // grepping ERROR logs.
    const detail = event.detail as { orgId?: unknown } | null | undefined;
    const orgId =
      detail && typeof detail.orgId === "string" ? detail.orgId : "";
    if (!orgId) {
      console.warn(
        "Refusing to publish chatter: EventBridge event carries no orgId",
        { source: event.source, detailType: event["detail-type"] },
      );
      emitMetrics({
        metrics: [
          { name: METRIC_CHATTER_ORG_ID_MISSING, value: 1, unit: UNIT_COUNT },
        ],
        properties: {
          source: event.source,
          detailType: event["detail-type"],
        },
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, reason: "missing orgId" }),
      };
    }

    const chatterInput: ChatterInput = {
      id: event.id,
      timestamp: event.time,
      source: event.source,
      detailType: event["detail-type"],
      detail: JSON.stringify(event.detail), // Convert to JSON string for AWSJSON type
      orgId,
    };

    console.log(
      "Publishing chatter message:",
      JSON.stringify(chatterInput, null, 2),
    );

    const result = await executeGraphQL(publishChatterMutation, {
      input: chatterInput,
    });

    console.log(
      "Successfully published chatter message:",
      JSON.stringify(result, null, 2),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, result }),
    };
  } catch (error) {
    console.error("Error publishing chatter message:", error);
    throw error;
  }
};

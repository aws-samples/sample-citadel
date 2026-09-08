import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { AppSyncResolverEvent } from "aws-lambda";
import {
  assertRowOrg,
  isAdminFromEvent,
  hasRoleFromEvent,
} from "../utils/auth-event";
import { RegistryService } from "../services/registry-service";

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const AGENT_BUCKET_NAME = process.env.AGENT_BUCKET_NAME!;
const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE!;
const REGION = process.env.AWS_REGION || "us-east-1";

let _registryService: RegistryService | undefined;

/**
 * Lazy RegistryService singleton, mirroring the pattern in
 * app-publish-handler.ts / registry-agent-record-resolver.ts. Read-only
 * usage here: this resolver only calls getResource to fetch the agent's
 * manifest for the org/role gate (finding 1a9181a4) — it never writes to
 * the Registry.
 */
function getRegistryService(): RegistryService {
  if (!_registryService) {
    const registryId = process.env.REGISTRY_ID;
    if (!registryId) {
      throw new Error(
        "REGISTRY_ID environment variable is required by agent-code-resolver",
      );
    }
    _registryService = new RegistryService({ registryId, region: REGION });
  }
  return _registryService;
}

interface GetAgentCodeArgs {
  agentId: string;
}

interface UpdateAgentCodeArgs {
  input: {
    agentId: string;
    code: string;
  };
}

/**
 * Role required to overwrite an agent's executable source. Reusable
 * platform-role check (backend/src/utils/auth-event.ts hasRoleFromEvent) —
 * NOT the app-manifest `access` role map (viewer/editor/owner) used by
 * assertManifestAccess in registry-agent-record-resolver.ts, which does not
 * apply here: agent Registry records (RegistryService.getResource("agent",
 * id) as used by agent-config-resolver.ts) carry a flat `orgId` in their
 * customDescriptorContent, with NO per-record access/ACL map to check a
 * manifest role against. The available role signal is the caller's own
 * platform role claim (custom:role / cognito:groups), whose vocabulary is
 * admin / project manager / architect / developer (README.md "Access
 * Control"). 'architect' is chosen — not 'developer' — because overwriting
 * an agent's Python source is equivalent to deploying code that will run
 * with that agent's scoped credentials and tool bindings (per the finding),
 * the same trust tier already required for comparable agent-lifecycle
 * mutations in this codebase (agent-import-resolver.ts gates import/attest/
 * activate/gateway-publish operations on isAdminFromEvent(event) ||
 * hasRoleFromEvent(event, "architect")). This mirrors the task's owner/
 * editor framing one level down: publish (app-level, provisions billable
 * infra + mints a plaintext key) is owner-reserved; overwriting agent code
 * (agent-level, no infra provisioning) is architect-reserved, the next tier
 * down used elsewhere in this codebase for agent-lifecycle authority.
 */
const REQUIRED_WRITE_ROLE = "architect";

/**
 * Org (and, for the write, role) reconciliation gate shared by both
 * operations below. Loads the agent's Registry record via
 * RegistryService.getResource("agent", agentId) — the SAME lookup
 * agent-config-resolver.ts's getAgentConfigRegistry uses for this resource
 * type — then reuses the shared `assertRowOrg` gate (auth-event.ts) for org
 * reconciliation, since RegistryService.mapToAgentConfig(record) already
 * projects the record into a `{orgId}`-shaped object assertRowOrg expects.
 * This is NOT the registry-agent-record-resolver.ts assertManifestAccess
 * gate: that helper reads `manifest.access` (a per-app role map) which
 * agent Registry records never populate — using it here would silently
 * treat every non-admin caller as unauthorized (or, if orgId were merged in
 * unsafely, risk misreading the wrong manifest shape). Fails closed on any
 * missing identity, unresolvable caller org, missing/mismatched record,
 * or record with no orgId (assertRowOrg's own fail-closed contract) BEFORE
 * any S3 or DynamoDB call is made. `requiredWriteRole`, when supplied,
 * additionally requires the caller be admin or hold that platform role —
 * checked only after the org gate passes, so a cross-org caller never
 * learns whether they merely lack the right role.
 */
async function assertAgentCodeAccess(
  agentId: string,
  event: unknown,
  requiredWriteRole?: string,
): Promise<void> {
  const record = await getRegistryService().getResource("agent", agentId);
  if (!record) {
    throw new Error(`Access denied: agent ${agentId} not found`);
  }

  const mapped = getRegistryService().mapToAgentConfig(record);
  await assertRowOrg(mapped, event);

  if (requiredWriteRole) {
    if (
      !isAdminFromEvent(event) &&
      !hasRoleFromEvent(event, requiredWriteRole)
    ) {
      throw new Error(
        `Access denied: requires ${requiredWriteRole} role to update agent ${agentId}`,
      );
    }
  }
}

export const handler = async (
  event: AppSyncResolverEvent<Partial<GetAgentCodeArgs & UpdateAgentCodeArgs>>,
) => {
  console.log("Agent Code Resolver Event:", JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    switch (fieldName) {
      case "getAgentCode":
        return await getAgentCode(event.arguments as GetAgentCodeArgs, event);
      case "updateAgentCode":
        return await updateAgentCode(
          event.arguments as UpdateAgentCodeArgs,
          event,
        );
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: unknown) {
    console.error(`Error in ${fieldName}:`, error);
    throw error;
  }
};

async function getAgentCode(args: GetAgentCodeArgs, event: unknown) {
  const { agentId } = args;

  // Org gate (finding 1a9181a4) — BEFORE any S3 or DynamoDB access. Reads
  // require org membership only, no additional role (mirrors
  // getAgentConfigRegistry's read-side gate in agent-config-resolver.ts).
  await assertAgentCodeAccess(agentId, event);

  try {
    // Get agent config from DynamoDB to retrieve filename
    const getConfigCommand = new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
    });

    const configResponse = await docClient.send(getConfigCommand);

    let filename: string;
    if (configResponse.Item) {
      // Parse config to get filename
      let config = configResponse.Item.config;
      if (typeof config === "string") {
        try {
          config = JSON.parse(config);
        } catch {
          config = {};
        }
      }
      filename = config.filename || `${agentId}.py`;
    } else {
      // Registry-based agent: DynamoDB has no record.
      // Try using agentId directly as filename.
      filename = `${agentId}.py`;
    }

    const key = `agents/${filename}`;

    // Get code from S3
    const s3Command = new GetObjectCommand({
      Bucket: AGENT_BUCKET_NAME,
      Key: key,
    });

    const s3Response = await s3Client.send(s3Command);
    const code = await s3Response.Body?.transformToString();

    return {
      agentId,
      code: code || "# Agent code not found\n",
      version: s3Response.VersionId,
      lastModified: s3Response.LastModified?.toISOString(),
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "NoSuchKey") {
      // Return default code if file doesn't exist
      return {
        agentId,
        code: `# Agent: ${agentId}
# Add your agent code here

def handler(event, context):
    """
    Main handler for the agent.
    
    Args:
        event: The event data passed to the agent
        context: Runtime information
    
    Returns:
        dict: Response from the agent
    """
    pass
`,
        version: null,
        lastModified: null,
      };
    }
    console.error("Error getting agent code:", error);
    throw error;
  }
}

async function updateAgentCode(args: UpdateAgentCodeArgs, event: unknown) {
  const { agentId, code } = args.input;

  // Org + role gate (finding 1a9181a4) — BEFORE any S3 or DynamoDB access.
  // The write additionally requires REQUIRED_WRITE_ROLE (or admin): see
  // that constant's comment for why 'architect' was chosen over mere org
  // membership.
  await assertAgentCodeAccess(agentId, event, REQUIRED_WRITE_ROLE);

  try {
    // Get agent config from DynamoDB to retrieve filename
    const getConfigCommand = new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
    });

    const configResponse = await docClient.send(getConfigCommand);

    let filename: string;
    if (configResponse.Item) {
      // Parse config to get filename
      let config = configResponse.Item.config;
      if (typeof config === "string") {
        try {
          config = JSON.parse(config);
        } catch {
          config = {};
        }
      }
      filename = config.filename || `${agentId}.py`;
    } else {
      // Registry-based agent: DynamoDB has no record.
      filename = `${agentId}.py`;
    }

    const key = `agents/${filename}`;

    // Update code in S3
    const s3Command = new PutObjectCommand({
      Bucket: AGENT_BUCKET_NAME,
      Key: key,
      Body: code,
      ContentType: "text/x-python",
    });

    const s3Response = await s3Client.send(s3Command);

    return {
      agentId,
      code,
      version: s3Response.VersionId,
      lastModified: new Date().toISOString(),
    };
  } catch (error: unknown) {
    console.error("Error updating agent code:", error);
    throw new Error(
      `Failed to update agent code: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Schema guard (wave-2a tenancy fix, finding 87a171ad): every
 * `@aws_cognito_user_pools`-authenticated field on `type Subscription`
 * must declare a tenancy argument (`orgId`, `projectId`, `appId`, or
 * `executionId`) — an argument-less user-pool subscription has no basis
 * for AppSync's implicit per-connection filter, which is a cross-tenant
 * disclosure (chatter/fabrication events broadcast to every authenticated
 * subscriber). Admin-group-gated fields are exempt (`onGovernanceFinding`/
 * `onGovernanceEvent` style), but none of those are user-pool-only today.
 *
 * The allowlist below MUST be empty — any entry represents a known,
 * unfixed gap.
 */
import * as fs from "fs";
import * as path from "path";

const SCHEMA_PATH = path.join(__dirname, "../../schema/schema.graphql");

const ALLOWLIST: string[] = [];

const TENANCY_ARG_NAMES = ["orgId", "projectId", "appId", "executionId"];

interface SubscriptionField {
  name: string;
  args: string[];
  directives: string;
}

function extractSubscriptionFields(schema: string): SubscriptionField[] {
  const typeMatch = schema.match(/type Subscription \{([\s\S]*?)\n\}/);
  if (!typeMatch) {
    throw new Error(
      "Could not locate `type Subscription { ... }` block in schema.graphql",
    );
  }
  const body = typeMatch[1];

  // Each field may span multiple lines (directives on following lines).
  // Split on lines starting a new field: `  fieldName(...)` or `  fieldName:`.
  const fieldRegex =
    /^\s{2}(\w+)(\([^)]*\))?\s*:\s*[^\n@]+((?:\s*@\w+(?:\([^)]*\))?)*)/gm;
  const fields: SubscriptionField[] = [];
  let match: RegExpExecArray | null;

  while ((match = fieldRegex.exec(body)) !== null) {
    const [, name, argsRaw, firstLineDirectives] = match;
    // Directives can continue on subsequent indented lines before the next field.
    const afterMatch = body.slice(match.index + match[0].length);
    const continuationMatch = afterMatch.match(
      /^([\s\S]*?)(?=\n\s{2}\w+(?:\(|:))/,
    );
    const continuation = continuationMatch ? continuationMatch[1] : "";
    const directives = (firstLineDirectives || "") + continuation;

    const args = argsRaw
      ? argsRaw
          .slice(1, -1)
          .split(",")
          .map((a) => a.split(":")[0].trim())
          .filter(Boolean)
      : [];

    fields.push({ name, args, directives });
  }

  return fields;
}

describe("Subscription schema tenancy guard", () => {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const fields = extractSubscriptionFields(schema);

  it("finds a non-trivial number of Subscription fields (sanity check on the parser)", () => {
    expect(fields.length).toBeGreaterThanOrEqual(5);
  });

  it("allowlist is empty", () => {
    expect(ALLOWLIST).toEqual([]);
  });

  for (const field of fields) {
    const isUserPoolAuthed = field.directives.includes(
      "@aws_cognito_user_pools",
    );
    const isAdminGated = /cognito_groups\s*:\s*\[\s*"admin"\s*\]/.test(
      field.directives,
    );

    if (!isUserPoolAuthed || isAdminGated) {
      continue;
    }

    it(`Subscription.${field.name} declares a tenancy argument (orgId/projectId)`, () => {
      const hasTenancyArg = field.args.some((a) =>
        TENANCY_ARG_NAMES.includes(a),
      );
      if (!hasTenancyArg && ALLOWLIST.includes(field.name)) {
        return;
      }
      expect({
        field: field.name,
        args: field.args,
        hasTenancyArg,
      }).toEqual({
        field: field.name,
        args: field.args,
        hasTenancyArg: true,
      });
    });
  }
});

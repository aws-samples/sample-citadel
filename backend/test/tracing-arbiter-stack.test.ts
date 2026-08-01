/**
 * Tracing foundation — arbiter stack assertions (architect task
 * 5459301e-1e7b-4bfd-bccb-b106aba2748c, design §7 test list): the 4
 * PythonFunction Lambdas (SupervisorAgent, WorkerAgentWrapper,
 * FabricatorAgent, ActivatorAgent) plus every other application Lambda in
 * citadel-arbiter-<env> must carry TracingConfig Mode=Active and the
 * AWSXRayDaemonWriteAccess managed policy, same as the TS side.
 */
import * as fs from "fs";
import * as path from "path";

const ENV = process.env.SPLIT_GATES_ENV ?? "dev";
const STACK_NAME = `citadel-arbiter-${ENV}`;
const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "cdk.out",
  `${STACK_NAME}.template.json`,
);

const templateExists = fs.existsSync(TEMPLATE_PATH);

// The 4 PythonFunction Lambdas explicitly named by the design (§0/§1(b)).
const EXPECTED_PYTHON_FUNCTION_MARKERS = [
  "SupervisorAgent",
  "WorkerAgentWrapper",
  "FabricatorAgent",
  "ActivatorAgent",
];

describe("tracing foundation — citadel-arbiter-<env> stack", () => {
  if (!templateExists) {
    it.skip(`skipped: fresh template missing at ${TEMPLATE_PATH} (run 'npm run build && npx cdk synth ${STACK_NAME}' first)`, () => {});
    return;
  }

  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
  const lambdaEntries = Object.entries(template.Resources).filter(
    ([, r]: [string, any]) => r.Type === "AWS::Lambda::Function",
  ) as Array<[string, any]>;

  test("all 4 PythonFunction agents (Supervisor/Worker/Fabricator/Activator) are present in the fixture", () => {
    for (const marker of EXPECTED_PYTHON_FUNCTION_MARKERS) {
      const found = lambdaEntries.some(([id]) => id.includes(marker));
      expect(found).toBe(true);
    }
  });

  test.each(lambdaEntries.map(([id, r]) => [id, r]))(
    "%s has TracingConfig Mode=Active",
    (id, resource) => {
      expect(resource.Properties?.TracingConfig).toEqual({ Mode: "Active" });
    },
  );

  test.each(lambdaEntries.map(([id, r]) => [id, r]))(
    "%s's execution role carries the AWSXRayDaemonWriteAccess managed policy",
    (id, resource) => {
      const roleRef = resource.Properties?.Role;
      expect(roleRef?.["Fn::GetAtt"]).toBeDefined();
      const roleLogicalId = roleRef["Fn::GetAtt"][0];
      const role = template.Resources[roleLogicalId];
      expect(role).toBeDefined();

      const managedPolicyArns: unknown[] =
        role.Properties?.ManagedPolicyArns ?? [];
      const hasXrayPolicy = managedPolicyArns.some((arn) =>
        JSON.stringify(arn).includes("AWSXRayDaemonWriteAccess"),
      );
      expect(hasXrayPolicy).toBe(true);
    },
  );
});

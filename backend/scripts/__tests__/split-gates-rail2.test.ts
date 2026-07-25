import { buildBaseline } from "../../scripts/split-gates/baseline-builder";
import { CfnTemplate } from "../../scripts/split-gates/types";
import {
  isStatefulType,
  keyPropsEqual,
} from "../../scripts/split-gates/template-utils";
import { STATEFUL_KEY_PROPS } from "../../scripts/split-gates/types";

interface DynamoTableProperties {
  TableName: string;
  KeySchema: Array<{ AttributeName: string; KeyType: string }>;
  AttributeDefinitions?: Array<{
    AttributeName: string;
    AttributeType: string;
  }>;
}

/**
 * Rail 2 is implemented as a Jest/CDK-assertions test in
 * test/split-gates-rail2-stateful-pin.test.ts, driven by the committed
 * baseline + a live cdk.out synth. This suite exercises the same
 * comparison logic (buildBaseline + keyPropsEqual) directly against
 * doctored in-memory templates, so the "removed stateful ID" and "modified
 * key property" failure modes are covered without depending on a real
 * cdk synth being present in the test environment.
 */
function baseTemplate(): CfnTemplate {
  return {
    Resources: {
      ProjectsTable: {
        Type: "AWS::DynamoDB::Table",
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
        Properties: {
          TableName: "citadel-projects-dev",
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        },
      },
      ADRsTable: {
        Type: "AWS::DynamoDB::Table",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          TableName: "citadel-adrs-dev",
          KeySchema: [{ AttributeName: "adrId", KeyType: "HASH" }],
        },
      },
    },
  };
}

function statefulLogicalIds(template: CfnTemplate): string[] {
  return Object.entries(template.Resources)
    .filter(([, r]) => isStatefulType(r.Type))
    .map(([id]) => id);
}

describe("rail 2 — stateful logical-ID pin (positive, direct comparison logic)", () => {
  it("passes when the fresh template retains every stateful ID unchanged", () => {
    const baseline = buildBaseline("citadel-backend-dev", baseTemplate());
    const fresh = buildBaseline("citadel-backend-dev", baseTemplate());
    for (const id of statefulLogicalIds(baseTemplate())) {
      expect(fresh.resources[id]).toBeDefined();
      expect(fresh.resources[id].deletionPolicy).toBe(
        baseline.resources[id].deletionPolicy,
      );
    }
  });
});

describe("rail 2 — stateful logical-ID pin (negative: doctored templates must FAIL correctly)", () => {
  it("FAILS (missing) when a stateful logical ID is removed from the fresh template", () => {
    const baseline = buildBaseline("citadel-backend-dev", baseTemplate());
    const doctored = baseTemplate();
    delete doctored.Resources.ADRsTable;
    const fresh = buildBaseline("citadel-backend-dev", doctored);

    expect(baseline.resources.ADRsTable).toBeDefined();
    expect(fresh.resources.ADRsTable).toBeUndefined();
  });

  it("FAILS (policy changed) when a RETAIN table's DeletionPolicy is weakened to Delete", () => {
    const baseline = buildBaseline("citadel-backend-dev", baseTemplate());
    const doctored = baseTemplate();
    doctored.Resources.ADRsTable.DeletionPolicy = "Delete";
    doctored.Resources.ADRsTable.UpdateReplacePolicy = "Delete";
    const fresh = buildBaseline("citadel-backend-dev", doctored);

    expect(baseline.resources.ADRsTable.deletionPolicy).toBe("Retain");
    expect(fresh.resources.ADRsTable.deletionPolicy).toBe("Delete");
    expect(fresh.resources.ADRsTable.deletionPolicy).not.toBe(
      baseline.resources.ADRsTable.deletionPolicy,
    );
  });

  it("FAILS (key props changed) when a stateful table's KeySchema is modified", () => {
    const baseline = buildBaseline("citadel-backend-dev", baseTemplate());
    const doctored = baseTemplate();
    (
      doctored.Resources.ProjectsTable
        .Properties as unknown as DynamoTableProperties
    ).KeySchema = [{ AttributeName: "orgId", KeyType: "HASH" }];
    const fresh = buildBaseline("citadel-backend-dev", doctored);

    const { equal, diffs } = keyPropsEqual(
      baseline.resources.ProjectsTable.properties,
      fresh.resources.ProjectsTable.properties,
      STATEFUL_KEY_PROPS["AWS::DynamoDB::Table"],
    );
    expect(equal).toBe(false);
    expect(diffs).toContain("KeySchema");
  });
});

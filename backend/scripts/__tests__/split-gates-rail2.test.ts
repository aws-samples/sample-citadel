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

describe("rail 2 — BucketName environment-token normalization (finding 389a16a)", () => {
  it("PASSES when only the account id and region segments of BucketName differ (CI sandbox vs baseline capture host)", () => {
    const baselineProps = {
      BucketName: "citadel-documents-test-257192363080-us-west-2",
    };
    const ciProps = {
      BucketName: "citadel-documents-test-000000000000-us-east-1",
    };
    const { equal, diffs } = keyPropsEqual(baselineProps, ciProps, [
      "BucketName",
    ]);
    expect({ equal, diffs }).toEqual({ equal: true, diffs: [] });
  });

  it("BITE-PROOF: FAILS when the base bucket name itself changes, even with identical account/region", () => {
    const baselineProps = {
      BucketName: "citadel-documents-test-257192363080-us-west-2",
    };
    // Genuine rename: different base name, same account/region — must not
    // be masked by env-token normalization.
    const renamedProps = {
      BucketName: "citadel-docs-renamed-test-257192363080-us-west-2",
    };
    const { equal, diffs } = keyPropsEqual(baselineProps, renamedProps, [
      "BucketName",
    ]);
    expect({ equal, diffs }).toEqual({ equal: false, diffs: ["BucketName"] });
  });

  it("BITE-PROOF: FAILS when both base name AND account/region differ (rename hiding behind an env mismatch)", () => {
    const baselineProps = {
      BucketName: "citadel-documents-test-257192363080-us-west-2",
    };
    const renamedInCiProps = {
      BucketName: "citadel-docs-renamed-test-000000000000-us-east-1",
    };
    const { equal, diffs } = keyPropsEqual(baselineProps, renamedInCiProps, [
      "BucketName",
    ]);
    expect({ equal, diffs }).toEqual({ equal: false, diffs: ["BucketName"] });
  });

  it("does not normalize non-BucketName props, even if they happen to contain 12-digit or region-shaped substrings", () => {
    const baselineProps = {
      TableName: "citadel-projects-test",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    };
    // A 12-digit-looking table name segment must still be byte-compared —
    // TableName is not in ENV_DERIVED_KEYS.
    const freshProps = {
      TableName: "citadel-projects-test-257192363080",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    };
    const { equal, diffs } = keyPropsEqual(baselineProps, freshProps, [
      "TableName",
      "KeySchema",
    ]);
    expect({ equal, diffs }).toEqual({ equal: false, diffs: ["TableName"] });
  });
});

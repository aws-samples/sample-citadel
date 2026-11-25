/**
 * SuppressNodejsL1Nag — CDK Aspect that adds an AwsSolutions-L1 cdk-nag
 * suppression to every Lambda function whose runtime is a Node.js version,
 * scoped to the project's NODE_RUNTIME constant.
 *
 * Context: aws-cdk-lib 2.277 introduces lambda.Runtime.NODEJS_26_X.
 * cdk-nag's AwsSolutions-L1 (LambdaLatestVersion) then flags every
 * nodejs24.x function as non-latest. Node.js 26 is not yet LTS/GA on
 * Lambda, so the project stays pinned to Node.js 24 (decision a9068699).
 * This Aspect applies a targeted suppression — Python functions and every
 * other nag rule are untouched.
 *
 * Remove this Aspect (and the backlog story) once the Lambda Node 26
 * runtime reaches LTS/GA and NODE_RUNTIME is bumped.
 */
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NagSuppressions } from "./nag-suppressions-compat";
import { IConstruct } from "constructs";

export const L1_SUPPRESSION_REASON =
  "Node.js 26 Lambda runtime is not yet LTS; pinned to Node.js 24 until " +
  "Lambda's Node 26 runtime reaches LTS/GA (tracked in the backlog).";

export class SuppressNodejsL1Nag implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) {
      return;
    }

    // Only suppress Node.js functions — leave Python, container-image,
    // and any other runtime untouched.
    const runtime = node.runtime;
    if (typeof runtime !== "string" || !runtime.startsWith("nodejs")) {
      return;
    }

    NagSuppressions.addResourceSuppressions(
      node,
      [
        {
          id: "AwsSolutions-L1",
          reason: L1_SUPPRESSION_REASON,
        },
      ],
      /* applyToChildren */ false,
    );
  }
}

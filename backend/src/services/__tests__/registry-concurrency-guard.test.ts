/**
 * Structural guard: LIST_DETAIL_CONCURRENCY must be 3 (not 10).
 *
 * After the GSI fix, global callers that still use listResourcesChecked
 * must limit concurrency to 3 to reduce burst pressure on the Registry.
 */
import * as fs from "fs";
import * as path from "path";

const REGISTRY_SERVICE_PATH = path.resolve(
  __dirname,
  "../../services/registry-service.ts",
);

describe("LIST_DETAIL_CONCURRENCY guard", () => {
  test("LIST_DETAIL_CONCURRENCY is set to 3", () => {
    const source = fs.readFileSync(REGISTRY_SERVICE_PATH, "utf-8");
    const match = source.match(/LIST_DETAIL_CONCURRENCY\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(3);
  });
});

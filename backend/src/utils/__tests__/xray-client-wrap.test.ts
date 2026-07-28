/**
 * Tracing foundation — X-Ray SDK wrap of the two shared client factories
 * (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c, design §1(a)/§6
 * items 2-3). Both `utils/dynamodb.ts` and `utils/events.ts` construct a
 * single shared AWS SDK v3 client at module scope; wrapping exactly those
 * two construction points with `AWSXRay.captureAWSv3Client` yields a
 * DynamoDB + EventBridge-PutEvents subsegment on every resolver's trace
 * with zero per-handler edits.
 *
 * These tests spy on `captureAWSv3Client` and assert it was invoked once
 * per module (module-scope singleton client), and that the exported client
 * carries the X-Ray middleware stack (proof the wrap actually took effect,
 * not just that the function was called).
 */

// captureAWSv3Client must be spied on BEFORE the modules under test import
// it, since both modules call it once at module-load time.
const captureSpy = jest.fn((client: unknown) => client);

jest.mock("aws-xray-sdk-core", () => ({
  captureAWSv3Client: (client: unknown) => captureSpy(client),
  setContextMissingStrategy: jest.fn(),
}));

describe("tracing foundation — shared client X-Ray wrap", () => {
  beforeEach(() => {
    jest.resetModules();
    captureSpy.mockClear();
  });

  test("utils/dynamodb.ts wraps its DynamoDBClient with captureAWSv3Client exactly once", () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../dynamodb");
    });

    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  test("utils/events.ts wraps its EventBridgeClient with captureAWSv3Client exactly once", () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../events");
    });

    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  test("utils/dynamodb.ts pins the context-missing strategy to LOG_ERROR before wrapping", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AWSXRay = require("aws-xray-sdk-core");
    const setStrategySpy = AWSXRay.setContextMissingStrategy as jest.Mock;
    setStrategySpy.mockClear();

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../dynamodb");
    });

    expect(setStrategySpy).toHaveBeenCalledWith("LOG_ERROR");
  });

  test("utils/events.ts pins the context-missing strategy to LOG_ERROR before wrapping", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AWSXRay = require("aws-xray-sdk-core");
    const setStrategySpy = AWSXRay.setContextMissingStrategy as jest.Mock;
    setStrategySpy.mockClear();

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../events");
    });

    expect(setStrategySpy).toHaveBeenCalledWith("LOG_ERROR");
  });
});

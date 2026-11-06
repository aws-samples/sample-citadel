/**
 * Shared region resolution for backend/scripts/*.ts CLI tools.
 *
 * Precedence:
 *   1. `--region <value>` CLI flag
 *   2. `AWS_REGION` env var
 *   3. `AWS_DEFAULT_REGION` env var
 *   4. Exit with code 2 and a descriptive error — no silent default.
 *
 * CIT-287: replaces the previous `process.env.AWS_REGION || 'us-east-1'`
 * pattern that silently defaulted to us-east-1, which caused scripts to
 * target the wrong region when run outside of a correctly configured shell.
 */

/**
 * Extract `--region <value>` from a raw argv array and return both the
 * resolved value and the remaining args (with `--region` and its value
 * removed so downstream parsers don't choke on an unknown flag).
 */
export function extractRegionFlag(argv: string[]): {
  regionFlag: string | undefined;
  rest: string[];
} {
  const rest: string[] = [];
  let regionFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--region") {
      regionFlag = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  return { regionFlag, rest };
}

/**
 * Resolve the AWS region following the documented precedence chain.
 *
 * Exported so it can be unit-tested with an injected env/argv without
 * mutating `process.env` or calling `process.exit`.
 *
 * @returns the resolved region string
 * @throws  {RegionRequiredError} when no source provides a region
 */
export class RegionRequiredError extends Error {
  constructor() {
    super("Region required: pass --region or set AWS_REGION");
    this.name = "RegionRequiredError";
  }
}

export function resolveRegion(argv: string[]): {
  region: string;
  rest: string[];
} {
  const { regionFlag, rest } = extractRegionFlag(argv);
  const region =
    regionFlag ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  if (!region) {
    throw new RegionRequiredError();
  }

  return { region, rest };
}

/**
 * Convenience wrapper that calls `resolveRegion` and exits the process
 * with code 2 on failure. Use this at the top-level `main()` of a script.
 */
export function resolveRegionOrExit(argv: string[]): {
  region: string;
  rest: string[];
} {
  try {
    return resolveRegion(argv);
  } catch (err) {
    if (err instanceof RegionRequiredError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

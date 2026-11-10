import * as net from "net";
import {
  ConnectorAdapter,
  ConnectorCategory,
  ConnectorSpec,
  AuthenticationMethod,
  RequiredPolicies,
  ProvisionResult,
  ConnectionTestResult,
  MetricsResult,
} from "../../adapters/base";
import { ProvisioningError, ConnectionError } from "./errors";
import { SdkError } from "./sdk-types";
import {
  classifyIp,
  parsePublicHttpsUrl,
  resolveAndPin,
  UrlRejectedError,
  emitUrlRefused,
  type DnsLookupFn,
  type PinnedEndpoint,
} from "../../utils/url-safety";

/**
 * CIT-300: resolve a hostname to public IPs and return the first pinned
 * address. Refuses private, link-local, loopback, and metadata IPs.
 *
 * @throws {UrlRejectedError} if the host resolves to any non-public address.
 */
async function resolvePublicHost(
  host: string,
  lookup?: DnsLookupFn,
): Promise<PinnedEndpoint> {
  // If host is already a literal IP, classify directly.
  if (net.isIPv4(host) || net.isIPv6(host)) {
    const cls = classifyIp(host);
    if (cls !== "public") {
      throw new UrlRejectedError(`literal IP is ${cls}`);
    }
    return { ip: host, servername: host, host };
  }

  // Construct a synthetic HTTPS URL so we can reuse resolveAndPin.
  const syntheticUrl = new URL(`https://${host}`);
  return resolveAndPin(syntheticUrl, { lookup });
}

/**
 * TCP reachability check connecting to a **pinned** IP address.
 * The caller must resolve the host through {@link resolvePublicHost} first;
 * this function never does its own DNS lookup.
 */
function tcpCheckPinned(
  ip: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, ip);
  });
}

export class ExternalDatabaseAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = "datastore";
  readonly spec: ConnectorSpec;

  /** Injectable DNS lookup for testing. */
  _dnsLookup?: DnsLookupFn;

  constructor(private kind: string) {
    this.spec = {
      type: `EXTERNAL_${kind.toUpperCase()}`,
      provider: "External",
      category: "datastore",
      authentication: {
        method: AuthenticationMethod.IAM_ROLE,
        fields: [],
        secretStructure: {},
      },
      configuration: { required: [], optional: [], ssmParameters: [] },
    };
  }

  requiredPolicies(
    _config: Record<string, unknown>,
    _accountId: string,
    _region: string,
  ): RequiredPolicies {
    return { provision: [], connect: [] };
  }

  async provision(
    _config: Record<string, unknown>,
    _credentials?: Record<string, unknown>,
  ): Promise<ProvisionResult> {
    throw new ProvisioningError(
      `Provisioning is not supported for external ${this.kind} data stores`,
    );
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.testConnection(config, credentials);
    if (!result.success) {
      throw new ConnectionError(
        `Failed to connect to ${this.kind}: ${result.message}`,
      );
    }
  }

  async disconnect(
    _config: Record<string, unknown>,
    _credentials?: Record<string, unknown>,
  ): Promise<void> {
    // No-op for external stores
  }

  async testConnection(
    config: Record<string, unknown>,
    _credentials?: Record<string, unknown>,
  ): Promise<ConnectionTestResult> {
    switch (this.kind) {
      case "mongodb":
        return this.testMongoConnection(config);
      case "api":
        return this.testApiConnection(config);
      case "postgresql":
      case "mysql":
      case "elasticsearch":
      case "redis":
        return this.testTcpConnection(config);
      default:
        return {
          success: false,
          message: `Unsupported external kind: ${this.kind}`,
        };
    }
  }

  async getMetrics(
    _config: Record<string, unknown>,
    _resourceArn?: string,
    _credentials?: Record<string, unknown>,
  ): Promise<MetricsResult> {
    return { size: "0 MB", records: 0 };
  }

  /**
   * CIT-300: resolve and pin the host, then TCP-check the pinned IP.
   * Refuses private/link-local/metadata addresses.
   */
  private async safeTcpCheck(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      const pinned = await resolvePublicHost(host, this._dnsLookup);
      return tcpCheckPinned(pinned.ip, port, timeoutMs);
    } catch (error) {
      if (error instanceof UrlRejectedError) {
        emitUrlRefused("external-adapter");
        return false;
      }
      throw error;
    }
  }

  private async testMongoConnection(
    config: Record<string, unknown>,
  ): Promise<ConnectionTestResult> {
    try {
      const url = new URL(config.connectionString as string);
      const host = url.hostname;
      const port = url.port ? parseInt(url.port, 10) : 27017;
      const reachable = await this.safeTcpCheck(host, port, 5000);
      if (reachable) {
        return {
          success: true,
          message: `Successfully connected to MongoDB at ${host}:${port}`,
          details: { host, port },
        };
      }
      return {
        success: false,
        message: `Failed to reach MongoDB at ${host}:${port}`,
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Invalid MongoDB connection string: ${err.message}`,
      };
    }
  }

  private async testApiConnection(
    config: Record<string, unknown>,
  ): Promise<ConnectionTestResult> {
    try {
      // CIT-300: validate the URL through the full url-safety pipeline.
      parsePublicHttpsUrl(config.baseUrl as string);
      return {
        success: true,
        message: `API URL is well-formed: ${config.baseUrl}`,
        details: { baseUrl: config.baseUrl },
      };
    } catch (error) {
      if (error instanceof UrlRejectedError) {
        emitUrlRefused("external-adapter");
      }
      return {
        success: false,
        message: `Invalid API URL: ${config.baseUrl}`,
      };
    }
  }

  private async testTcpConnection(
    config: Record<string, unknown>,
  ): Promise<ConnectionTestResult> {
    const host = config.host as string | undefined;
    const port = config.port as number | undefined;
    if (!host || !port) {
      return {
        success: false,
        message: `Missing host or port for ${this.kind} connection`,
      };
    }
    const reachable = await this.safeTcpCheck(host, port, 5000);
    if (reachable) {
      return {
        success: true,
        message: `Successfully connected to ${this.kind} at ${host}:${port}`,
        details: { host, port },
      };
    }
    return {
      success: false,
      message: `Failed to reach ${this.kind} at ${host}:${port}`,
    };
  }
}

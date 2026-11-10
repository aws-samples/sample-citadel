/**
 * CIT-300: ExternalDatabaseAdapter must refuse private/link-local/metadata
 * addresses and connect to the pinned IP on success.
 */
import { ExternalDatabaseAdapter } from "../external-adapter";

describe("ExternalDatabaseAdapter — CIT-300 egress-pin guard", () => {
  let adapter: ExternalDatabaseAdapter;

  beforeEach(() => {
    adapter = new ExternalDatabaseAdapter("postgresql");
  });

  describe("refuses metadata / private / link-local IPs", () => {
    const BLOCKED_HOSTS = [
      { host: "169.254.169.254", label: "metadata endpoint (IPv4)" },
      { host: "10.0.0.1", label: "RFC1918 10/8" },
      { host: "172.16.0.1", label: "RFC1918 172.16/12" },
      { host: "192.168.1.1", label: "RFC1918 192.168/16" },
      { host: "127.0.0.1", label: "loopback" },
    ];

    for (const { host, label } of BLOCKED_HOSTS) {
      it(`refuses ${label} (${host})`, async () => {
        const result = await adapter.testConnection({ host, port: 5432 });
        expect(result.success).toBe(false);
      });
    }
  });

  describe("refuses hostnames that resolve to private IPs", () => {
    it("refuses a hostname resolving to 169.254.169.254", async () => {
      adapter._dnsLookup = async () => ["169.254.169.254"];
      const result = await adapter.testConnection({
        host: "evil.example.com",
        port: 5432,
      });
      expect(result.success).toBe(false);
    });

    it("refuses a hostname resolving to 10.0.0.1", async () => {
      adapter._dnsLookup = async () => ["10.0.0.1"];
      const result = await adapter.testConnection({
        host: "internal.example.com",
        port: 3306,
      });
      expect(result.success).toBe(false);
    });

    it("refuses a hostname resolving to 127.0.0.1", async () => {
      adapter._dnsLookup = async () => ["127.0.0.1"];
      const result = await adapter.testConnection({
        host: "localhost.example.com",
        port: 6379,
      });
      expect(result.success).toBe(false);
    });

    it("refuses if ANY resolved address is non-public", async () => {
      // First address is public, second is private — must refuse
      adapter._dnsLookup = async () => ["8.8.8.8", "10.0.0.1"];
      const result = await adapter.testConnection({
        host: "mixed.example.com",
        port: 5432,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("MongoDB connection string SSRF prevention", () => {
    it("refuses mongodb://169.254.169.254:27017/admin", async () => {
      const adapter = new ExternalDatabaseAdapter("mongodb");
      const result = await adapter.testConnection({
        connectionString: "mongodb://169.254.169.254:27017/admin",
      });
      expect(result.success).toBe(false);
    });

    it("refuses mongodb hostname resolving to private IP", async () => {
      const adapter = new ExternalDatabaseAdapter("mongodb");
      adapter._dnsLookup = async () => ["192.168.1.1"];
      const result = await adapter.testConnection({
        connectionString: "mongodb://evil.example.com:27017/admin",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("API URL SSRF prevention", () => {
    it("refuses http:// (non-https)", async () => {
      const adapter = new ExternalDatabaseAdapter("api");
      const result = await adapter.testConnection({
        baseUrl: "http://example.com/api",
      });
      expect(result.success).toBe(false);
    });

    it("refuses https://169.254.169.254/latest/meta-data", async () => {
      const adapter = new ExternalDatabaseAdapter("api");
      const result = await adapter.testConnection({
        baseUrl: "https://169.254.169.254/latest/meta-data",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("connects to pinned IP on success (fake DNS)", () => {
    it("resolves hostname → public IP and attempts TCP to pinned IP", async () => {
      // Use a fake lookup that resolves to a public IP (TCP will fail since
      // nothing is listening, but the key assertion is that the adapter
      // does NOT refuse the connection attempt for SSRF reasons).
      adapter._dnsLookup = async () => ["203.0.113.1"];

      // TCP to 203.0.113.1 will time out or error — that's fine.
      // What matters: the adapter tried (success: false due to unreachable,
      // NOT due to SSRF rejection). We can tell by the message.
      const result = await adapter.testConnection({
        host: "public.example.com",
        port: 5432,
      });
      // Either success (unlikely) or failure due to TCP not SSRF
      expect(result.message).toMatch(/Failed to reach|Successfully connected/);
    });
  });
});

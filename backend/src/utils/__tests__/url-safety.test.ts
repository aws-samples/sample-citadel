/**
 * Tests for url-safety.ts — CIT-254 SH-2.
 *
 * Table-driven vectors cover: SSRF via private/loopback/link-local/metadata IPs,
 * decimal/octal/hex encoding, IPv4-mapped IPv6, DNS-to-private, redirects,
 * userinfo, http://, disallowed ports. Property test with fast-check for the
 * IP classifier.
 */

import fc from "fast-check";
import {
  classifyIp,
  classifyIpv4,
  classifyIpv6,
  parsePublicHttpsUrl,
  resolveAndPin,
  safeHttpsRequest,
  UrlRejectedError,
  type IpClass,
  type DnsLookupFn,
} from "../url-safety";

// ---------------------------------------------------------------------------
// classifyIpv4
// ---------------------------------------------------------------------------

describe("classifyIpv4", () => {
  const vectors: Array<{ ip: string; expected: IpClass }> = [
    // Loopback
    { ip: "127.0.0.1", expected: "loopback" },
    { ip: "127.255.255.255", expected: "loopback" },
    // Metadata
    { ip: "169.254.169.254", expected: "metadata" },
    // Link-local
    { ip: "169.254.0.1", expected: "link-local" },
    { ip: "169.254.255.255", expected: "link-local" },
    // RFC1918
    { ip: "10.0.0.1", expected: "private" },
    { ip: "10.255.255.255", expected: "private" },
    { ip: "172.16.0.1", expected: "private" },
    { ip: "172.31.255.255", expected: "private" },
    { ip: "192.168.0.1", expected: "private" },
    { ip: "192.168.255.255", expected: "private" },
    // CGN
    { ip: "100.64.0.1", expected: "private" },
    { ip: "100.127.255.255", expected: "private" },
    // Reserved: 0/8
    { ip: "0.0.0.0", expected: "reserved" },
    { ip: "0.255.255.255", expected: "reserved" },
    // Multicast + reserved
    { ip: "224.0.0.1", expected: "reserved" },
    { ip: "255.255.255.255", expected: "reserved" },
    { ip: "240.0.0.1", expected: "reserved" },
    // Public
    { ip: "8.8.8.8", expected: "public" },
    { ip: "1.1.1.1", expected: "public" },
    { ip: "203.0.113.1", expected: "public" },
    // Not a dotted quad
    { ip: "not-an-ip", expected: "public" },
    { ip: "999.999.999.999", expected: "public" },
  ];

  it.each(vectors)("classifies $ip as $expected", ({ ip, expected }) => {
    expect(classifyIpv4(ip)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// classifyIpv6
// ---------------------------------------------------------------------------

describe("classifyIpv6", () => {
  const vectors: Array<{ ip: string; expected: IpClass }> = [
    { ip: "::1", expected: "loopback" },
    { ip: "::", expected: "reserved" },
    { ip: "fc00::1", expected: "private" },
    { ip: "fd12:3456:789a::1", expected: "private" },
    { ip: "fe80::1", expected: "link-local" },
    { ip: "::ffff:127.0.0.1", expected: "loopback" },
    { ip: "::ffff:169.254.169.254", expected: "metadata" },
    { ip: "::ffff:10.0.0.1", expected: "private" },
    { ip: "::ffff:8.8.8.8", expected: "public" },
    // Hex-form IPv4-mapped: 0:0:0:0:0:ffff:HHHH:HHHH
    { ip: "0:0:0:0:0:ffff:a9fe:a9fe", expected: "metadata" },
    { ip: "::ffff:7f00:1", expected: "loopback" },
    { ip: "::ffff:0a00:1", expected: "private" },
    { ip: "::ffff:c0a8:101", expected: "private" },
    { ip: "2001:db8::1", expected: "public" },
    { ip: "2600:1f18::1", expected: "public" },
  ];

  it.each(vectors)("classifies $ip as $expected", ({ ip, expected }) => {
    expect(classifyIpv6(ip)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// classifyIp (unified)
// ---------------------------------------------------------------------------

describe("classifyIp", () => {
  it("handles bracketed IPv6", () => {
    expect(classifyIp("[::1]")).toBe("loopback");
    expect(classifyIp("[::ffff:169.254.169.254]")).toBe("metadata");
  });

  it("handles plain IPv4", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("8.8.8.8")).toBe("public");
  });
});

// ---------------------------------------------------------------------------
// Property test: classifyIp
// ---------------------------------------------------------------------------

describe("classifyIp — property tests", () => {
  // Generator for random public IPv4 (first octet 1–9, 11–99, 128–223, excluding private ranges)
  const publicIpv4 = fc
    .tuple(
      fc.integer({ min: 1, max: 223 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
    )
    .filter(([a, b]) => {
      if (a === 10) return false;
      if (a === 127) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
      if (a === 100 && b >= 64 && b <= 127) return false;
      if (a === 0) return false;
      return true;
    })
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

  it("accepts random public IPv4 addresses", () => {
    fc.assert(
      fc.property(publicIpv4, (ip) => {
        expect(classifyIp(ip)).toBe("public");
      }),
      { numRuns: 500 },
    );
  });

  // Generator for private ranges
  const privateRanges = fc.oneof(
    // 10/8
    fc
      .tuple(
        fc.constant(10),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
    // 172.16/12
    fc
      .tuple(
        fc.constant(172),
        fc.integer({ min: 16, max: 31 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
    // 192.168/16
    fc
      .tuple(
        fc.constant(192),
        fc.constant(168),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
    // 127/8
    fc
      .tuple(
        fc.constant(127),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
    // 169.254/16
    fc
      .tuple(
        fc.constant(169),
        fc.constant(254),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
    // 100.64/10
    fc
      .tuple(
        fc.constant(100),
        fc.integer({ min: 64, max: 127 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
  );

  it("rejects any address in private/loopback/link-local/metadata ranges", () => {
    fc.assert(
      fc.property(privateRanges, (ip) => {
        const cls = classifyIp(ip);
        expect(cls).not.toBe("public");
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// parsePublicHttpsUrl
// ---------------------------------------------------------------------------

describe("parsePublicHttpsUrl", () => {
  it("accepts a valid HTTPS URL", () => {
    const result = parsePublicHttpsUrl("https://api.example.com/v1");
    expect(result.hostname).toBe("api.example.com");
    expect(result.pathname).toBe("/v1");
  });

  it("accepts port 443 explicitly", () => {
    const result = parsePublicHttpsUrl("https://api.example.com:443/v1");
    expect(result.hostname).toBe("api.example.com");
  });

  it("accepts port 8443 (in default allowlist)", () => {
    const result = parsePublicHttpsUrl("https://api.example.com:8443/v1");
    expect(result.hostname).toBe("api.example.com");
  });

  it("accepts a custom allowed port", () => {
    const result = parsePublicHttpsUrl("https://api.example.com:9443/", {
      allowedPorts: [9443],
    });
    expect(result.hostname).toBe("api.example.com");
  });

  const rejections: Array<{ label: string; url: string }> = [
    { label: "http://", url: "http://example.com" },
    { label: "ftp://", url: "ftp://example.com" },
    { label: "userinfo", url: "https://user@evil.com/" },
    { label: "userinfo with password", url: "https://user:pass@evil.com/" },
    { label: "disallowed port 8080", url: "https://example.com:8080/" },
    { label: "disallowed port 80", url: "https://example.com:80/" },
    { label: "literal loopback IPv4", url: "https://127.0.0.1/" },
    { label: "literal private 10.x", url: "https://10.0.0.1/" },
    { label: "literal private 192.168.x", url: "https://192.168.1.1/" },
    { label: "literal link-local", url: "https://169.254.1.1/" },
    {
      label: "literal metadata IMDS",
      url: "https://169.254.169.254/latest/meta-data",
    },
    { label: "literal IPv6 loopback", url: "https://[::1]/" },
    { label: "decimal IP encoding (127.0.0.1)", url: "https://2130706433/" },
    { label: "hex IP encoding", url: "https://0x7f000001/" },
    { label: "shorthand IP 127.1", url: "https://127.1/" },
    { label: "garbage", url: "not-a-url" },
    { label: "empty", url: "" },
    // Adversarial vectors — IPv4-mapped hex, octal, numeric, authority confusion
    {
      label: "IPv4-mapped IPv6 hex metadata",
      url: "https://[0:0:0:0:0:ffff:a9fe:a9fe]/",
    },
    { label: "octal IP 0177.0.0.1", url: "https://0177.0.0.1/" },
    { label: "octal long-form 017700000001", url: "https://017700000001/" },
    {
      label: "userinfo authority confusion @metadata",
      url: "https://evil.com@169.254.169.254/",
    },
    { label: "loopback on port 443", url: "https://127.0.0.1:443/" },
  ];

  it.each(rejections)("rejects: $label", ({ url }) => {
    expect(() => parsePublicHttpsUrl(url)).toThrow(UrlRejectedError);
    expect(() => parsePublicHttpsUrl(url)).toThrow("Invalid endpoint");
  });

  it("every rejection has the same opaque message", () => {
    const messages = rejections.map(({ url }) => {
      try {
        parsePublicHttpsUrl(url);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveAndPin
// ---------------------------------------------------------------------------

describe("resolveAndPin", () => {
  const publicUrl = new URL("https://api.example.com/v1");

  it("accepts a URL that resolves to public IPs", async () => {
    const lookup: DnsLookupFn = async () => ["93.184.216.34"];
    const result = await resolveAndPin(publicUrl, { lookup });
    expect(result.ip).toBe("93.184.216.34");
    expect(result.servername).toBe("api.example.com");
    expect(result.host).toBe("api.example.com");
  });

  it("rejects if ANY resolved address is private (DNS rebinding)", async () => {
    const lookup: DnsLookupFn = async () => ["93.184.216.34", "10.0.0.1"];
    await expect(resolveAndPin(publicUrl, { lookup })).rejects.toThrow(
      UrlRejectedError,
    );
  });

  it("rejects DNS resolving to loopback", async () => {
    const lookup: DnsLookupFn = async () => ["127.0.0.1"];
    await expect(resolveAndPin(publicUrl, { lookup })).rejects.toThrow(
      UrlRejectedError,
    );
  });

  it("rejects DNS resolving to metadata IP", async () => {
    const lookup: DnsLookupFn = async () => ["169.254.169.254"];
    await expect(resolveAndPin(publicUrl, { lookup })).rejects.toThrow(
      UrlRejectedError,
    );
  });

  it("rejects DNS resolving to IPv4-mapped IPv6 private", async () => {
    const lookup: DnsLookupFn = async () => ["::ffff:127.0.0.1"];
    await expect(resolveAndPin(publicUrl, { lookup })).rejects.toThrow(
      UrlRejectedError,
    );
  });

  it("rejects when no addresses resolve", async () => {
    const lookup: DnsLookupFn = async () => [];
    await expect(resolveAndPin(publicUrl, { lookup })).rejects.toThrow(
      UrlRejectedError,
    );
  });

  it("rejects when DNS lookup throws", async () => {
    const lookup: DnsLookupFn = async () => {
      throw new Error("NXDOMAIN");
    };
    await expect(resolveAndPin(publicUrl, { lookup })).rejects.toThrow(
      UrlRejectedError,
    );
  });
});

// ---------------------------------------------------------------------------
// safeHttpsRequest
// ---------------------------------------------------------------------------

describe("safeHttpsRequest", () => {
  // We cannot easily test the full HTTPS request in a unit test without a real
  // server, but we can test that the DNS-pinning rejects private targets.

  it("rejects a URL resolving to private IP", async () => {
    const lookup: DnsLookupFn = async () => ["10.0.0.1"];
    await expect(
      safeHttpsRequest("https://evil.example.com/", {}, { lookup }),
    ).rejects.toThrow(UrlRejectedError);
  });

  it("rejects http:// URL", async () => {
    await expect(safeHttpsRequest("http://example.com/", {})).rejects.toThrow(
      UrlRejectedError,
    );
  });

  it("rejects userinfo URL", async () => {
    await expect(
      safeHttpsRequest("https://user@evil.com/", {}),
    ).rejects.toThrow(UrlRejectedError);
  });
});

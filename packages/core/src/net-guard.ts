/**
 * Keeps web_fetch on the public internet. Inside the agent's VM, loopback and link-local
 * addresses reach desktopd (file reads), the agent's own HTTP port (schedules, status) and
 * the cloud metadata service, and web.read is open to partners, family and friends. So
 * every hostname is resolved first and every address must be public, on every redirect.
 *
 * The check is a filter on the resolved addresses, not a pin: fetch resolves the name a
 * second time, so a host that flips its DNS between the two lookups (rebinding) can still
 * slip through. The server can close that gap by passing a `fetchImpl` whose dispatcher
 * connects to the address returned here.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type Lookup = (hostname: string) => Promise<string[]>;

/** Hostnames that always mean "this machine" or a cloud metadata service. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

export const defaultLookup: Lookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

function parseV4(ip: string): number[] | undefined {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return parts;
}

function isPublicV4(ip: string): boolean {
  const p = parseV4(ip);
  if (!p) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return false; // 0.0.0.0/8, "this network"
  if (a === 10) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space, includes Alibaba metadata 100.100.100.200
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, AWS/Azure/GCP metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 192 && b === 0 && p[2] === 0) return false; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expand an IPv6 literal into eight 16-bit groups. Returns undefined when it is not valid. */
function groupsV6(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail: ::ffff:127.0.0.1
  const v4Tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4Tail) {
    const v4 = parseV4(v4Tail[2]!);
    if (!v4) return undefined;
    s = `${v4Tail[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const headParts = halves[0] ? halves[0].split(":") : [];
  const tailParts = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - headParts.length - tailParts.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return undefined;
  const all = [...headParts, ...(halves.length === 2 ? Array<string>(fill).fill("0") : []), ...tailParts];
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.some((g) => Number.isNaN(g)) ? undefined : groups;
}

function isPublicV6(ip: string): boolean {
  const g = groupsV6(ip);
  if (!g) return false;
  const allZero = g.every((x) => x === 0);
  if (allZero) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  const first = g[0]!;
  const ipv4Mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): on a DNS64 network every IPv4-only host,
  // S3 included, resolves to one of these. The gateway forwards to the embedded IPv4 address.
  const nat64WellKnown = first === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (ipv4Mapped || nat64WellKnown) {
    // Judge the embedded IPv4 address.
    const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
    return isPublicV4(v4);
  }
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (first === 0x0064 && g[1] === 0xff9b) return false; // local-use NAT64 64:ff9b:1::/48 (RFC 8215): operator-defined, block
  return true;
}

/** True for a unicast address routable on the public internet. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (kind === 4) return isPublicV4(ip);
  if (kind === 6) return isPublicV6(ip);
  return false;
}

export interface PublicTarget {
  url: URL;
  /** Resolved addresses, all public. Empty for a literal IP host. */
  addresses: string[];
}

/**
 * Check a URL before fetching it. Rejects non-http(s) schemes, blocked hostnames, literal
 * IPs that are not public and hostnames that resolve to any non-public address.
 * Returns the reason when the target is refused.
 */
export async function checkPublicTarget(raw: string | URL, lookup: Lookup = defaultLookup): Promise<{ ok: true; target: PublicTarget } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw.trim());
  } catch {
    return { ok: false, reason: `not a valid URL: ${String(raw)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `only http and https URLs can be fetched: ${url.toString()}` };
  if (url.username || url.password) return { ok: false, reason: "URLs with embedded credentials are not fetched" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "URL has no host" };
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return { ok: false, reason: `${host} is not a public host` };
  }
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(literal)) {
    return isPublicAddress(literal) ? { ok: true, target: { url, addresses: [] } } : { ok: false, reason: `${literal} is a private, loopback, link-local or reserved address` };
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch (error) {
    return { ok: false, reason: `could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} did not resolve to any address` };
  const bad = addresses.find((a) => !isPublicAddress(a));
  if (bad) return { ok: false, reason: `${host} resolves to ${bad}, which is not a public address` };
  return { ok: true, target: { url, addresses } };
}

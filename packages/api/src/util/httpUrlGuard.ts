/**
 * SSRF-adjacent host checks for outbound webhook URLs. Kept dependency-free so
 * both boot-time config validation (bootstrap) and the runtime delivery sink
 * (webhook outbox) can share it without an import cycle.
 *
 * Scope (deliberate): this is a syntactic guard over the URL's host. It does
 * NOT resolve DNS, so a public hostname pointing at a private address (or DNS
 * rebinding) passes — the destinations here are operator-configured, not
 * tenant/user input, so resolution-time enforcement is out of scope. If a
 * tenant-settable webhook URL ever lands on the outbox, this guard must be
 * upgraded to pin and check the resolved address at connect time.
 */

/** Numeric value of an IPv4 host in ANY inet_aton form (decimal/hex/octal,
 * 1-4 parts, e.g. `2130706433`, `0x7f000001`, `017700000001`, `127.1`),
 * or null when the host is not a numeric IPv4. */
function ipv4Value(host: string): number | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(part)) return null;
    const value = /^0x/i.test(part)
      ? parseInt(part, 16)
      : /^0\d/.test(part)
        ? parseInt(part, 8)
        : parseInt(part, 10);
    if (!Number.isFinite(value)) return null;
    nums.push(value);
  }
  // inet_aton: the last part fills the remaining bytes.
  const last = nums[nums.length - 1]!;
  const prefix = nums.slice(0, -1);
  const lastBytes = 4 - prefix.length;
  if (last >= 2 ** (8 * lastBytes)) return null;
  if (prefix.some((n) => n > 255)) return null;
  let value = last;
  prefix.forEach((n, i) => {
    value += n * 2 ** (8 * (3 - i));
  });
  return value;
}

/** Value of a strict dotted-quad IPv4 (`a.b.c.d`), or null. Used only to decode
 * an IPv4 tail embedded in an IPv6 literal (`::ffff:127.0.0.1`). */
function ipv4DottedValue(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = parseInt(part, 10);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function inRange(value: number, start: number, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return value >= start && value < start + size;
}

const ip = (a: number, b: number, c: number, d: number) =>
  a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;

/**
 * Expand an IPv6 literal (no brackets, lowercased) into its eight 16-bit words,
 * or null when it isn't a well-formed IPv6 address. Handles `::` compression and
 * a trailing embedded dotted-quad IPv4 (`::ffff:127.0.0.1`, `64:ff9b::10.0.0.1`).
 */
function ipv6ToWords(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null; // at most one '::'

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const words: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      // A dotted-quad may only appear as the final group (the embedded IPv4 tail).
      if (i === groups.length - 1 && g.includes(".")) {
        const v4 = ipv4DottedValue(g);
        if (v4 === null) return null;
        words.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        words.push(parseInt(g, 16));
      }
    }
    return words;
  };

  if (halves.length === 2) {
    const left = parseGroups(halves[0]!);
    const right = parseGroups(halves[1]!);
    if (left === null || right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // '::' must stand for at least one zero group
    return [...left, ...Array<number>(missing).fill(0), ...right];
  }
  const only = parseGroups(host);
  if (only === null || only.length !== 8) return null;
  return only;
}

/**
 * True when an IPv6 address is loopback / unspecified / unique-local /
 * link-local, OR embeds a private IPv4 in one of the address families that
 * actually translate to IPv4 routing — IPv4-mapped (`::ffff:0:0/96`),
 * IPv4-compatible (`::/96`, e.g. `::127.0.0.1`), and the well-known NAT64
 * prefix (`64:ff9b::/96`). Decoding only these prefixes avoids over-blocking a
 * legitimate public IPv6 whose low 32 bits merely happen to look like a
 * private IPv4.
 */
function isPrivateIpv6Words(w: number[]): boolean {
  const allZeroHigh6 = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
  // ::1 loopback and :: unspecified.
  if (allZeroHigh6 && w[5] === 0 && w[6] === 0 && (w[7] === 0 || w[7] === 1)) return true;
  // fc00::/7 unique-local, fe80::/10 link-local — the IPv6 analogues of RFC1918
  // and 169.254.0.0/16.
  if ((w[0]! & 0xfe00) === 0xfc00) return true;
  if ((w[0]! & 0xffc0) === 0xfe80) return true;
  // fec0::/10 — deprecated site-local (RFC 3879), still honored by some stacks.
  if ((w[0]! & 0xffc0) === 0xfec0) return true;
  const embeddedV4 = () => isPrivateIpv4Value(w[6]! * 2 ** 16 + w[7]!);
  if (allZeroHigh6 && w[5] === 0xffff) return embeddedV4(); // ::ffff:0:0/96 (mapped)
  if (allZeroHigh6 && w[5] === 0) return embeddedV4(); // ::/96 (IPv4-compatible)
  // 64:ff9b::/96 (well-known NAT64) — an internal IPv4 wrapped for translation.
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
    return embeddedV4();
  }
  // 2002::/16 (6to4) embeds a routable IPv4 in words 1-2; block when that IPv4 is
  // private/metadata (e.g. 2002:a9fe:a9fe:: = 169.254.169.254).
  if (w[0] === 0x2002) return isPrivateIpv4Value(w[1]! * 2 ** 16 + w[2]!);
  return false;
}

/**
 * True if host is loopback / link-local / RFC1918 private / CGNAT / this-host
 * (SSRF-adjacent). Handles dotted-quad AND numeric IPv4 encodings
 * (`http://2130706433/` is 127.0.0.1) plus every IPv6 family that embeds an
 * IPv4 (`::ffff:...`, `::127.0.0.1`, `64:ff9b::...`).
 */
export function isPrivateHttpHost(host: string): boolean {
  // WHATWG URL keeps the brackets on IPv6 hostnames ("[::1]") — strip them or
  // no IPv6 comparison below can ever match. Also drop a single trailing dot:
  // "localhost." / "127.0.0.1." are the FQDN-root form and resolve identically,
  // so they must not slip past the checks below.
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // Any ':' means this is an IPv6 literal (URL strips the port, and IPv6 hosts
  // arrive bracketed which we removed above). Parse it fully and fail CLOSED on
  // a malformed literal rather than letting it fall through as "public".
  if (h.includes(":")) {
    const words = ipv6ToWords(h);
    return words ? isPrivateIpv6Words(words) : true;
  }
  const value = ipv4Value(h);
  if (value !== null) return isPrivateIpv4Value(value);
  return false;
}

/**
 * Parse and validate an outbound webhook destination: it must be http(s) and,
 * unless `allowPrivate`, must not target a private/link-local/loopback host.
 * Returns the normalized `URL` to POST (deliver `.href`, never the raw string);
 * throws on any violation. The single chokepoint every delivery sink routes
 * through so the SSRF guard can't be forgotten at one site and drift from
 * another (webhook outbox, budget-alert fallback, any future sink).
 */
export function assertPublicHttpUrl(rawUrl: string, opts: { allowPrivate?: boolean } = {}): URL {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error(`invalid destination URL: ${rawUrl}`);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(`destination URL must be http(s): ${rawUrl}`);
  }
  if (!opts.allowPrivate && isPrivateHttpHost(target.hostname)) {
    throw new Error(
      `refusing to deliver to private/link-local host '${target.hostname.toLowerCase()}' (SSRF guard)`,
    );
  }
  return target;
}

function isPrivateIpv4Value(value: number): boolean {
  return (
    inRange(value, ip(0, 0, 0, 0), 8) || // "this network" (0.0.0.0/8)
    inRange(value, ip(10, 0, 0, 0), 8) || // RFC1918
    inRange(value, ip(100, 64, 0, 0), 10) || // CGNAT
    inRange(value, ip(127, 0, 0, 0), 8) || // loopback
    inRange(value, ip(169, 254, 0, 0), 16) || // link-local
    inRange(value, ip(172, 16, 0, 0), 12) || // RFC1918
    inRange(value, ip(192, 168, 0, 0), 16) // RFC1918
  );
}

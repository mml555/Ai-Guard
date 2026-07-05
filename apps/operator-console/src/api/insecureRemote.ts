/**
 * True when a login URL would send the bearer token over plain http to a
 * non-local host (cleartext on the network). http to localhost / RFC1918 /
 * CGNAT / link-local hosts is normal for dev and not flagged.
 *
 * The check runs against the PARSED hostname, not a string prefix: matching a
 * prefix would misclassify a remote host whose name merely begins with a
 * private-range token (e.g. `http://127.evil.com/`, `http://192.168.evil.com/`,
 * `http://localhost.evil.com/`) as local and silently suppress the warning.
 */
export function isInsecureRemoteUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");

  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "::1" || host === "::") return false; // IPv6 loopback / unspecified

  // Dotted-quad IPv4 private / loopback / link-local / CGNAT ranges. Anything
  // that is not one of these (a real domain, a public IP) over http is remote
  // cleartext and must be flagged.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return false; // this-host / RFC1918 / loopback
    if (a === 192 && b === 168) return false; // RFC1918
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true; // any other IPv4 is a remote host
  }
  return true;
}

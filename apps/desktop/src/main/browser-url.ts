export function loopbackUrl(value: string): URL {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["http:", "https:"].includes(url.protocol) || !loopback || url.username || url.password) {
    throw new Error("The desktop browser is restricted to HTTP(S) pages on this computer.");
  }
  return url;
}

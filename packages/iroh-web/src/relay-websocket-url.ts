/**
 * Relay WebSocket URLs.
 *
 * iroh writes relay hostnames as fully qualified DNS names with a trailing dot
 * (n0's public relays are `<region>.relay.n0.iroh.link.`), and those names
 * reach the browser from every source: the default relay map, tickets, address
 * lookup and `relayUrls`. Browsers keep the dot in the TLS name check, and
 * WebKit then rejects the relay's certificate ("Unacceptable TLS certificate"),
 * so the relay WebSocket never opens.
 *
 * The relay URL itself stays as iroh wrote it, because it is also the relay's
 * identity in addresses and tickets. Only the URL handed to `new WebSocket`
 * changes: the build script routes every WebSocket the wasm glue opens through
 * {@link relayWebSocketUrl}.
 */

/**
 * Returns `url` with one trailing dot removed from its hostname. URLs whose
 * hostname has no trailing dot are returned unchanged.
 */
export function relayWebSocketUrl(url: string): string {
  const parsed = new URL(url)
  if (!parsed.hostname.endsWith('.')) return url
  parsed.hostname = parsed.hostname.slice(0, -1)
  return parsed.href
}

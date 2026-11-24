/**
 * URLs the wasm hands to the browser.
 *
 * iroh writes relay hostnames as fully qualified DNS names with a trailing dot
 * (n0's public relays are `<region>.relay.n0.iroh.link.`), and those names
 * reach the browser from every source: the default relay map, tickets, address
 * lookup and `relayUrls`. Browsers keep the dot in the TLS name check, and
 * WebKit then rejects the relay's certificate ("Unacceptable TLS certificate"),
 * both for the relay WebSocket and for the relay latency probe (`/ping`).
 *
 * The relay URL itself stays as iroh wrote it, because it is also the relay's
 * identity in addresses and tickets. Only the URL of each browser request
 * changes: the build script routes every URL the wasm glue passes to
 * `new WebSocket` or `new Request` (which every `fetch` goes through) through
 * {@link requestUrl}.
 */

/**
 * Returns `url` with one trailing dot removed from its hostname. URLs whose
 * hostname has no trailing dot are returned unchanged.
 */
export function requestUrl(url: string): string {
  const parsed = new URL(url)
  if (!parsed.hostname.endsWith('.')) return url
  parsed.hostname = parsed.hostname.slice(0, -1)
  return parsed.href
}

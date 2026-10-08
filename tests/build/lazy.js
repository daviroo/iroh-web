export async function load() {
  const { Endpoint } = await import('@daviroo/iroh-web')
  const endpoint = await Endpoint.bind({ relayUrls: ['http://127.0.0.1:1/'] })
  const id = endpoint.id
  await endpoint.close()
  return id
}

import type { TestProject } from 'vitest/node'
import { startRelay } from './relay.js'

declare module 'vitest' {
  export interface ProvidedContext {
    relayUrl: string
  }
}

export default async function setup(project: TestProject) {
  const relay = await startRelay()
  project.provide('relayUrl', relay.url)
  return async () => {
    await relay.stop()
  }
}

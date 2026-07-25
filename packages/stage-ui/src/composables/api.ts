import { hc } from 'hono/client'

import { authedFetch } from '../libs/auth-fetch'
import { SERVER_URL } from '../libs/server'

/**
 * Hosted API client surface.
 *
 * Typed as a loose client so stage packages do not import the hosted backend
 * app module (that pulls the entire server graph into vue-tsc). Companion /
 * game-coop do not need this client.
 */

export type StageApiClient = any

export const client = hc(SERVER_URL, {
  fetch: authedFetch,
}) as StageApiClient

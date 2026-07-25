import { describe, expect, it } from 'vitest'

import { buildAuthUiRedirectUrl, buildAuthUiUrl, resolveAuthUiUrl } from '../auth-ui'

describe('auth UI URL helpers', () => {
  it('builds auth UI URLs under the configured auth base path', () => {
    expect(buildAuthUiUrl('https://accounts.vera.build/ui', '/sign-in', '?client_id=web')).toBe(
      'https://accounts.vera.build/ui/sign-in?client_id=web',
    )
  })

  it('maps server /auth requests to the standalone auth UI while preserving queries', () => {
    expect(buildAuthUiRedirectUrl(
      'https://accounts.vera.build/ui/',
      'https://api.vera.build/auth/verify-email?verified=true',
    )).toBe('https://accounts.vera.build/ui/verify-email?verified=true')
  })

  it('adds the API server origin for standalone auth UI cross-environment redirects', () => {
    expect(buildAuthUiRedirectUrl(
      'https://auth-preview.example/ui/',
      'https://vera-server-dev.up.railway.app/auth/sign-in?client_id=vera-stage-web&api_server_url=https%3A%2F%2Fevil.example',
      'https://vera-server-dev.up.railway.app/api/auth',
    )).toBe(
      'https://auth-preview.example/ui/sign-in?client_id=vera-stage-web&api_server_url=https%3A%2F%2Fvera-server-dev.up.railway.app',
    )
  })

  it('routes server-dev default auth UI redirects to the matching Pages branch', () => {
    expect(buildAuthUiRedirectUrl(
      'https://accounts.vera.build/ui',
      'https://vera-server-dev.up.railway.app/auth/sign-in?client_id=vera-stage-web',
      'https://vera-server-dev.up.railway.app',
    )).toBe(
      'https://server-dev.vera-server-auth.pages.dev/ui/sign-in?client_id=vera-stage-web&api_server_url=https%3A%2F%2Fvera-server-dev.up.railway.app',
    )
  })

  it('keeps an explicitly configured auth UI URL for server-dev', () => {
    expect(resolveAuthUiUrl(
      'https://auth-preview.example/ui',
      'https://vera-server-dev.up.railway.app',
    )).toBe('https://auth-preview.example/ui')
  })
})

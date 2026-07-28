import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'

const databaseUrl = 'postgres://feed:secret@localhost:5432/indexer'

describe('loadConfig', () => {
  it('loads defaults and deduplicates trusted labelers', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      TRUSTED_QUALITY_LABELER_DIDS:
        'did:plc:ar7c4by46qjdydhdevvrndac,did:plc:ar7c4by46qjdydhdevvrndac',
    })

    expect(config.databaseMaxConnections).toBe(5)
    expect(config.databaseIdleTimeoutMs).toBe(60_000)
    expect(config.corsAllowedOrigins).toEqual(['https://certified.app'])
    expect(config.corsAllowLocalhost).toBe(true)
    expect(config.trustedQualityLabelerDids).toEqual([
      'did:plc:ar7c4by46qjdydhdevvrndac',
    ])
  })

  it('loads configured CORS origins and local access policy', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      CORS_ALLOWED_ORIGINS: 'https://certified.app, https://staging.example, https://certified.app',
      CORS_ALLOW_LOCALHOST: 'false',
    })

    expect(config.corsAllowedOrigins).toEqual([
      'https://certified.app',
      'https://staging.example',
    ])
    expect(config.corsAllowLocalhost).toBe(false)
  })

  it('loads a configured database idle timeout', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      DATABASE_IDLE_TIMEOUT_MS: '120000',
    })

    expect(config.databaseIdleTimeoutMs).toBe(120_000)
  })

  it('explains how to fix malformed CORS settings', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        CORS_ALLOWED_ORIGINS: 'https://certified.app/path',
      }),
    ).toThrow('CORS_ALLOWED_ORIGINS contains invalid origin')
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        CORS_ALLOW_LOCALHOST: 'yes',
      }),
    ).toThrow('CORS_ALLOW_LOCALHOST must be either true or false')
  })

  it('explains how to fix missing and malformed values', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required')
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, PORT: '70000' }),
    ).toThrow('PORT must be an integer from 1 through 65535')
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        DATABASE_IDLE_TIMEOUT_MS: '500',
      }),
    ).toThrow(
      'DATABASE_IDLE_TIMEOUT_MS must be an integer from 1000 through 3600000',
    )
  })
})

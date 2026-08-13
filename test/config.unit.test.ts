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
    expect(config.trustedQualityLabelerDids).toEqual([
      'did:plc:ar7c4by46qjdydhdevvrndac',
    ])
  })

  it('loads a configured database idle timeout', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      DATABASE_IDLE_TIMEOUT_MS: '120000',
    })

    expect(config.databaseIdleTimeoutMs).toBe(120_000)
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

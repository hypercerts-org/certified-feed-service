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
    expect(config.trustedQualityLabelerDids).toEqual([
      'did:plc:ar7c4by46qjdydhdevvrndac',
    ])
  })

  it('explains how to fix missing and malformed values', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required')
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, PORT: '70000' }),
    ).toThrow('PORT must be an integer from 1 through 65535')
  })
})

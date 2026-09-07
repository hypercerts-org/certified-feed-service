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
    expect(config.metricsHost).toBe('0.0.0.0')
    expect(config.metricsPort).toBeUndefined()
    expect(config.trustedQualityLabelerDids).toEqual([
      'did:plc:ar7c4by46qjdydhdevvrndac',
    ])
  })

  it('loads configured metrics listener settings', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      METRICS_HOST: '127.0.0.1',
      METRICS_PORT: '3001',
    })

    expect(config.metricsHost).toBe('127.0.0.1')
    expect(config.metricsPort).toBe(3_001)
  })

  it('disables metrics when the metrics port is empty', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      METRICS_PORT: '',
    })

    expect(config.metricsPort).toBeUndefined()
  })

  it('rejects a metrics port that conflicts with the public port', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        PORT: '3001',
        METRICS_PORT: '3001',
      }),
    ).toThrow(
      'METRICS_PORT must differ from PORT; set the public and private listeners to separate ports.',
    )
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
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, METRICS_PORT: '0' }),
    ).toThrow('METRICS_PORT must be an integer from 1 through 65535')
  })
})

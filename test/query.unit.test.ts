import type { QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import { createCertifiedFeed } from '../src/feed/query.js'
import type { SqlFeedQueryExecutor } from '../src/feed/sql-feed.js'
import { FEED_COLLECTIONS } from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const feedId = 'app.certified.feed.beta.defs#certifiedFeed'
const paramsType = 'app.certified.feed.beta.defs#certifiedFeedParams'
const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const trustedLabeler = 'did:plc:ragtjsm2j2vknwkz3zp4oxrd'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

class FakeQueryExecutor implements SqlFeedQueryExecutor {
  readonly calls: Array<{
    readonly text: string
    readonly values: readonly unknown[]
  }> = []

  constructor(private readonly rows: readonly Record<string, unknown>[]) {}

  async query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly Row[] }> {
    this.calls.push({ text, values })
    return { rows: this.rows as unknown as readonly Row[] }
  }
}

const resultRow = (overrides: Record<string, unknown> = {}) => ({
  uri,
  cid,
  collection: 'org.hypercerts.claim.activity',
  actor_did: actorDid,
  kind: 'cert.create',
  sort_value: '2026-07-21T10:00:00.000000Z',
  selected_source_uri: uri,
  selected_source_cid: cid,
  selected_source_collection: 'org.hypercerts.claim.activity',
  source_json: { title: 'Source' },
  ...overrides,
})

const params = {
  $type: paramsType,
  viewerDid,
} as const

describe('Certified SQL feed definition', () => {
  it('binds the current feed contract and maps metadata rows', async () => {
    const database = new FakeQueryExecutor([
      resultRow({
        selected_source_uri: null,
        selected_source_cid: null,
        selected_source_collection: null,
        source_json: null,
      }),
    ])
    const feed = createCertifiedFeed(
      { database, metrics: new Metrics() },
      [trustedLabeler],
    )

    await expect(
      feed.loadPage(params, { limit: 2 }, 'metadata'),
    ).resolves.toEqual({
      rows: [
        {
          uri,
          cid,
          collection: 'org.hypercerts.claim.activity',
          actorDid,
          kind: 'cert.create',
          sortValue: '2026-07-21T10:00:00.000000Z',
        },
      ],
    })
    expect(feed.id).toBe(feedId)
    expect(feed.paramsType).toBe(paramsType)
    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([
      viewerDid,
      [],
      false,
      [],
      false,
      [trustedLabeler],
      [],
      null,
      null,
      3,
      FEED_COLLECTIONS,
      false,
    ])
  })

  it('rejects structural and semantic params failures before querying', async () => {
    const database = new FakeQueryExecutor([])
    const feed = createCertifiedFeed(
      { database, metrics: new Metrics() },
      [],
    )

    await expect(
      feed.loadPage({ $type: paramsType }, {}, 'metadata'),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
    await expect(
      feed.loadPage(
        {
          $type: paramsType,
          viewerDid: 'not-a-did',
        },
        {},
        'metadata',
      ),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
    expect(database.calls).toEqual([])
  })

  it('maps exact selected sources in with-source mode', async () => {
    const sourceValue = { title: 'Exact source' }
    const database = new FakeQueryExecutor([
      resultRow({ source_json: sourceValue }),
    ])
    const feed = createCertifiedFeed(
      { database, metrics: new Metrics() },
      [],
    )

    await expect(
      feed.loadPage(params, { limit: 2 }, 'with-source'),
    ).resolves.toEqual({
      rows: [
        {
          uri,
          cid,
          collection: 'org.hypercerts.claim.activity',
          actorDid,
          kind: 'cert.create',
          sortValue: '2026-07-21T10:00:00.000000Z',
          sourceValue,
        },
      ],
    })
    expect(database.calls[0]?.values[11]).toBe(true)
    expect(database.calls[0]?.text).toContain(
      'selected_source.uri = page.uri',
    )
  })

  it('fails instead of silently dropping malformed query rows', async () => {
    const feed = createCertifiedFeed(
      {
        database: new FakeQueryExecutor([
          resultRow({ actor_did: null }),
        ]),
        metrics: new Metrics(),
      },
      [],
    )

    await expect(
      feed.loadPage(params, { limit: 2 }, 'metadata'),
    ).rejects.toThrow('metadata invariant failed')
  })

  it('rejects mismatched selected sources in with-source mode', async () => {
    const feed = createCertifiedFeed(
      {
        database: new FakeQueryExecutor([
          resultRow({ selected_source_cid: 'bafyreimismatch' }),
        ]),
        metrics: new Metrics(),
      },
      [],
    )

    await expect(
      feed.loadPage(params, { limit: 2 }, 'with-source'),
    ).rejects.toThrow('source invariant failed')
  })
})

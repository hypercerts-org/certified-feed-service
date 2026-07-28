import type { QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import {
  type FeedQueryExecutor,
  FeedRepository,
} from '../src/feed/query.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actor = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actor}/org.hypercerts.claim.activity/3kpn`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

class FakeQueryExecutor implements FeedQueryExecutor {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = []

  constructor(private readonly rows: readonly Record<string, unknown>[]) {}

  async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly T[] }> {
    this.calls.push({ text, values })
    return { rows: this.rows as unknown as readonly T[] }
  }
}

const input = (includeSource: boolean) => ({
  request: {
    viewerDid: viewer,
    trustedEvaluators: [],
    limit: 2,
    kinds: [],
  },
  trustedQualityLabelerDids: [],
  includeSource,
})

const resultRow = (overrides: Record<string, unknown> = {}) => ({
  scope_count: 1,
  uri,
  cid,
  collection: 'org.hypercerts.claim.activity',
  actor_did: actor,
  kind: 'cert.create',
  sort_value: '2026-07-21T10:00:00.000000Z',
  selected_source_uri: uri,
  selected_source_cid: cid,
  selected_source_collection: 'org.hypercerts.claim.activity',
  source_json: { marker: 'source' },
  ...overrides,
})

describe('FeedRepository page modes', () => {
  it('appends includeSource=false and maps metadata without exposing source JSON', async () => {
    const database = new FakeQueryExecutor([
      resultRow({
        selected_source_uri: null,
        selected_source_cid: null,
        selected_source_collection: null,
      }),
    ])
    const repository = new FeedRepository(database)

    const result = await repository.getFeed(input(false))

    expect(result).toEqual({
      includeSource: false,
      scopeCount: 1,
      rows: [
        {
          uri,
          cid,
          actorDid: actor,
          collection: 'org.hypercerts.claim.activity',
          kind: 'cert.create',
          sortValue: '2026-07-21T10:00:00.000000Z',
        },
      ],
    })
    expect(result.rows[0]).not.toHaveProperty('sourceValue')
    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toHaveLength(13)
    expect(database.calls[0]?.values[9]).toBe(3)
    expect(database.calls[0]?.values[12]).toBe(false)
  })

  it('joins source JSON only after pagination using exact URI and CID', async () => {
    const sourceValue = { marker: 'exact-body' }
    const database = new FakeQueryExecutor([resultRow({ source_json: sourceValue })])
    const repository = new FeedRepository(database)

    await expect(repository.getFeed(input(true))).resolves.toEqual({
      includeSource: true,
      scopeCount: 1,
      rows: [
        {
          uri,
          cid,
          actorDid: actor,
          collection: 'org.hypercerts.claim.activity',
          kind: 'cert.create',
          sortValue: '2026-07-21T10:00:00.000000Z',
          sourceValue,
        },
      ],
    })

    const call = database.calls[0]
    expect(call).toBeDefined()
    if (!call) throw new Error('expected one feed query call')
    expect(call.values[12]).toBe(true)
    expect(call.text.indexOf('selected_source.json AS source_json')).toBeGreaterThan(
      call.text.indexOf('paged_events AS'),
    )
    expect(call.text).toContain('ON $13::boolean')
    expect(call.text).toContain('selected_source.uri = page.uri')
    expect(call.text).toContain('selected_source.cid = page.cid')
    const classifiedProjection = call.text.slice(
      call.text.indexOf('classified_events AS'),
      call.text.indexOf('filtered_events AS'),
    )
    expect(classifiedProjection).toContain('source.collection')
    expect(classifiedProjection).not.toContain('source.json AS source_json')
  })

  it('preserves scope metadata for an empty source-aware page', async () => {
    const repository = new FeedRepository(
      new FakeQueryExecutor([
        resultRow({
          scope_count: 0,
          uri: null,
          cid: null,
          collection: null,
          actor_did: null,
          kind: null,
          sort_value: null,
          selected_source_uri: null,
          selected_source_cid: null,
          selected_source_collection: null,
          source_json: null,
        }),
      ]),
    )

    await expect(repository.getFeed(input(true))).resolves.toEqual({
      includeSource: true,
      scopeCount: 0,
      rows: [],
    })
  })

  it.each([
    { uri: null },
    { cid: null },
    { collection: null },
    { actor_did: null },
    { kind: null },
    { sort_value: null },
  ])('rejects partially-null page metadata: %o', async (overrides) => {
    const repository = new FeedRepository(
      new FakeQueryExecutor([resultRow(overrides)]),
    )

    await expect(repository.getFeed(input(false))).rejects.toThrow(
      /metadata invariant failed.*incomplete URI, CID, collection, actor DID, kind, or sort metadata/i,
    )
  })

  it('accepts a JSON null source when the exact joined metadata is present', async () => {
    const repository = new FeedRepository(
      new FakeQueryExecutor([resultRow({ source_json: null })]),
    )

    const result = await repository.getFeed(input(true))

    expect(result.rows[0]).toHaveProperty('sourceValue', null)
  })

  it.each([
    { selected_source_uri: null },
    { selected_source_uri: `${uri}-other` },
    { selected_source_cid: null },
    { selected_source_cid: `${cid}a` },
    { selected_source_collection: null },
    { selected_source_collection: 'org.hypercerts.collection' },
  ])('rejects a missing or mismatched exact source join: %o', async (overrides) => {
    const repository = new FeedRepository(
      new FakeQueryExecutor([resultRow(overrides)]),
    )

    await expect(repository.getFeed(input(true))).rejects.toThrow(
      /source invariant failed.*post-pagination source join/i,
    )
  })
})

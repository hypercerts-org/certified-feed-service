import type { QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import type { FeedSubject } from '../src/feed/types.js'
import {
  type ExactRecordQueryExecutor,
  PostgresExactRecordReader,
} from '../src/hydration/query.js'
import { strongRefKey } from '../src/hydration/types.js'

const uriA = 'at://did:plc:alice/org.hypercerts.claim.activity/a'
const uriB = 'at://did:plc:bob/org.hypercerts.collection/b'
const cidA = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const cidB = 'bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

class FakeQueryExecutor implements ExactRecordQueryExecutor {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = []

  constructor(private readonly resultRows: readonly Record<string, unknown>[]) {}

  async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly T[] }> {
    this.calls.push({ text, values })
    return { rows: this.resultRows as unknown as readonly T[] }
  }
}

const subject = (uri: string, cid: string): FeedSubject => ({ uri, cid })

describe('strongRefKey', () => {
  it('distinguishes CIDs requested for the same URI', () => {
    expect(strongRefKey(subject(uriA, cidA))).not.toBe(
      strongRefKey(subject(uriA, cidB)),
    )
  })
})

describe('PostgresExactRecordReader', () => {
  it('avoids PostgreSQL for an empty batch', async () => {
    const database = new FakeQueryExecutor([])
    const reader = new PostgresExactRecordReader(database)

    await expect(reader.getByStrongRefs([])).resolves.toEqual(new Map())
    expect(database.calls).toEqual([])
  })

  it('deduplicates combined references, binds zipped arrays, and maps every state', async () => {
    const availableBody = { $type: 'org.hypercerts.claim.activity', name: 'A' }
    const database = new FakeQueryExecutor([
      {
        requested_uri: uriB,
        requested_cid: cidA,
        current_cid: null,
        did: null,
        collection: null,
        source_json: null,
      },
      {
        requested_uri: uriA,
        requested_cid: cidB,
        current_cid: cidA,
        did: 'did:plc:alice',
        collection: 'org.hypercerts.claim.activity',
        source_json: null,
      },
      {
        requested_uri: uriA,
        requested_cid: cidA,
        current_cid: cidA,
        did: 'did:plc:alice',
        collection: 'org.hypercerts.claim.activity',
        source_json: availableBody,
      },
    ])
    const reader = new PostgresExactRecordReader(database)

    const results = await reader.getByStrongRefs([
      subject(uriA, cidA),
      subject(uriA, cidA),
      subject(uriA, cidB),
      subject(uriB, cidA),
    ])

    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.text).toContain(
      'unnest($1::text[], $2::text[])',
    )
    expect(database.calls[0]?.values).toEqual([
      [uriA, uriA, uriB],
      [cidA, cidB, cidA],
    ])
    expect(results).toEqual(
      new Map([
        [
          strongRefKey(subject(uriB, cidA)),
          { state: 'notFound', subject: subject(uriB, cidA) },
        ],
        [
          strongRefKey(subject(uriA, cidB)),
          { state: 'cidMismatch', subject: subject(uriA, cidB) },
        ],
        [
          strongRefKey(subject(uriA, cidA)),
          {
            state: 'available',
            subject: subject(uriA, cidA),
            collection: 'org.hypercerts.claim.activity',
            did: 'did:plc:alice',
            value: availableBody,
          },
        ],
      ]),
    )
  })
})

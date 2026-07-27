import { describe, expect, it } from 'vitest'

import { decodeCursor } from '../src/feed/cursor.js'
import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import type {
  FeedQueryInput,
  FeedQueryReader,
  FeedQueryResult,
} from '../src/feed/query.js'
import { FeedService } from '../src/feed/service.js'
import { Metrics } from '../src/metrics.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actor = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const baseUri = `at://${actor}/org.hypercerts.claim.activity/`

class FakeFeedReader implements FeedQueryReader {
  lastInput: FeedQueryInput | undefined

  constructor(private readonly result: FeedQueryResult) {}

  async getFeed(input: FeedQueryInput): Promise<FeedQueryResult> {
    this.lastInput = input
    return this.result
  }
}

const row = (suffix: string, sortValue: string) => ({
  uri: `${baseUri}${suffix}`,
  cid: 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u',
  actorDid: actor,
  kind: 'cert.create' as const,
  sortValue,
})

describe('FeedService', () => {
  it('trims limit+1 and emits a cursor only when another page may exist', async () => {
    const reader = new FakeFeedReader({
      scopeCount: 1,
      rows: [
        row('3', '2026-07-21T10:00:03.000000Z'),
        row('2', '2026-07-21T10:00:02.000000Z'),
        row('1', '2026-07-21T10:00:01.000000Z'),
      ],
    })
    const service = new FeedService(reader, [viewer], new Metrics())

    const output = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [actor],
      limit: 2,
    })

    expect(output.items).toHaveLength(2)
    expect(output.items[1]?.subject.uri).toBe(`${baseUri}2`)
    expect(output.cursor).toBeDefined()
    expect(decodeCursor(output.cursor)).toMatchObject({
      version: 1,
      value: '2026-07-21T10:00:02.000000Z',
      uri: `${baseUri}2`,
    })
    expect(reader.lastInput?.trustedQualityLabelerDids).toEqual([viewer])
  })

  it('omits the cursor on a known final page', async () => {
    const service = new FeedService(
      new FakeFeedReader({
        scopeCount: 1,
        rows: [row('1', '2026-07-21T10:00:01.000000Z')],
      }),
      [],
      new Metrics(),
    )

    await expect(
      service.getFeedSkeleton({ viewerDid: viewer, authors: [actor] }),
    ).resolves.toEqual(
      expect.not.objectContaining({ cursor: expect.anything() }),
    )
  })

  it('rejects a resolved scope over 500 without truncating it', async () => {
    const service = new FeedService(
      new FakeFeedReader({ scopeCount: 501, rows: [] }),
      [],
      new Metrics(),
    )

    await expect(
      service.getFeedSkeleton({ viewerDid: viewer, authors: [] }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.FeedScopeTooLarge,
      }),
    )
  })
})

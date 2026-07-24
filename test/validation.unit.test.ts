import { describe, expect, it } from 'vitest'

import { FeedError } from '../src/feed/errors.js'
import { normalizeFeedRequest } from '../src/feed/validation.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const author = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'

describe('feed request validation', () => {
  it('preserves omitted and explicitly empty author semantics', () => {
    expect(normalizeFeedRequest({ viewerDid: viewer })).toMatchObject({
      hasExplicitAuthors: false,
      authors: [],
      limit: 20,
    })
    expect(
      normalizeFeedRequest({ viewerDid: viewer, authors: [] }),
    ).toMatchObject({
      hasExplicitAuthors: true,
      authors: [],
    })
  })

  it('deduplicates before applying list limits', () => {
    const result = normalizeFeedRequest({
      viewerDid: viewer,
      authors: Array.from({ length: 900 }, () => author),
      trustedEvaluators: [viewer, viewer],
    })

    expect(result.authors).toEqual([author])
    expect(result.trustedEvaluators).toEqual([viewer])
  })

  it('rejects an unsupported kind with the stable error name', () => {
    expect(() =>
      normalizeFeedRequest({ viewerDid: viewer, kinds: ['cert.creat'] }),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({ code: 'InvalidKind' }),
    )
  })

  it('validates organization quality values', () => {
    expect(() =>
      normalizeFeedRequest({
        viewerDid: viewer,
        organizationQuality: {
          allowed: ['excellent' as 'standard'],
          includeUnrated: false,
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({ code: 'InvalidRequest' }),
    )
  })

  it('rejects malformed viewers and page sizes', () => {
    expect(() => normalizeFeedRequest({ viewerDid: 'alice.test' })).toThrowError(
      expect.objectContaining<Partial<FeedError>>({ code: 'InvalidRequest' }),
    )
    expect(() =>
      normalizeFeedRequest({ viewerDid: viewer, limit: 51 }),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({ code: 'InvalidRequest' }),
    )
  })
})

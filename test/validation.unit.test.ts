import { describe, expect, it } from 'vitest'

import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import { normalizeFeedRequest } from '../src/feed/validation.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'

describe('feed request validation', () => {
  it('normalizes the viewer-follow request defaults', () => {
    expect(normalizeFeedRequest({ viewerDid: viewer })).toMatchObject({
      viewerDid: viewer,
      trustedEvaluators: [],
      kinds: [],
      limit: 20,
    })
  })

  it('deduplicates evaluator DIDs before applying the list limit', () => {
    const result = normalizeFeedRequest({
      viewerDid: viewer,
      trustedEvaluators: Array.from({ length: 100 }, () => viewer),
    })

    expect(result.trustedEvaluators).toEqual([viewer])
  })

  it('rejects an unsupported kind with the stable error name', () => {
    expect(() =>
      normalizeFeedRequest({ viewerDid: viewer, kinds: ['cert.creat'] }),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidKind,
      }),
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
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
  })

  it('rejects malformed viewers and page sizes', () => {
    expect(() => normalizeFeedRequest({ viewerDid: 'alice.test' })).toThrowError(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
    expect(() =>
      normalizeFeedRequest({ viewerDid: viewer, limit: 51 }),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
  })
})

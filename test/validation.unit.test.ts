import { describe, expect, it } from 'vitest'

import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import type { CertifiedFeedParams } from '../src/feed/types.js'
import { normalizeFeedRequest } from '../src/feed/validation.js'

const paramsType = 'app.certified.feed.beta.defs#certifiedFeedParams'
const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'

const feedParams = (
  params: Omit<CertifiedFeedParams, '$type'>,
): CertifiedFeedParams => ({ $type: paramsType, ...params })

describe('feed request validation', () => {
  it('normalizes the viewer-follow request defaults', () => {
    expect(
      normalizeFeedRequest(feedParams({ viewerDid: viewer })),
    ).toMatchObject({
      viewerDid: viewer,
      trustedEvaluators: [],
      kinds: [],
      limit: 20,
    })
  })

  it('deduplicates evaluator DIDs before applying the list limit', () => {
    const result = normalizeFeedRequest(
      feedParams({
        viewerDid: viewer,
        trustedEvaluators: Array.from({ length: 100 }, () => viewer),
      }),
    )

    expect(result.trustedEvaluators).toEqual([viewer])
  })

  it('rejects an unsupported kind with the stable error name', () => {
    expect(() =>
      normalizeFeedRequest(
        feedParams({ viewerDid: viewer, kinds: ['cert.creat'] }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidKind,
      }),
    )
  })

  it('validates organization quality values', () => {
    expect(() =>
      normalizeFeedRequest(
        feedParams({
          viewerDid: viewer,
          organizationQuality: {
            allowed: ['excellent' as 'standard'],
            includeUnrated: false,
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
  })

  it('rejects malformed viewers and page sizes', () => {
    expect(() =>
      normalizeFeedRequest(feedParams({ viewerDid: 'alice.test' })),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
    expect(() =>
      normalizeFeedRequest(feedParams({ viewerDid: viewer, limit: 51 })),
    ).toThrowError(
      expect.objectContaining<Partial<FeedError>>({
        code: FeedErrorCode.InvalidRequest,
      }),
    )
  })
})

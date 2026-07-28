import { jsonToLex, type BlobRef } from '@atproto/lex'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createApp, type AppFeedServices } from '../src/app.js'
import type { DatabaseCompatibilityChecker } from '../src/database.js'
import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import type { FeedSkeletonReader } from '../src/feed/service.js'
import type { GetFeedSkeletonInput } from '../src/feed/types.js'
import type { HydratedFeedReader } from '../src/hydration/service.js'
import { Metrics } from '../src/metrics.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actor = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actor}/org.hypercerts.claim.activity/3kpn`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const blobCid = 'bafkreiehxpuhtr5f6v4eu4byjo2j7kkrhjvd7psmfu4imnpdzb3bdqb7vy'
const avatarBlob = jsonToLex(
  {
    $type: 'blob',
    ref: { $link: blobCid },
    mimeType: 'image/png',
    size: 128,
  },
  { strict: true },
) as BlobRef
const feedTimestamp = '2026-07-21T10:00:00.000000Z'
const logger = pino({ enabled: false })

const skeletonPath =
  'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton'
const hydratedPath = 'http://localhost/xrpc/app.certified.feed.beta.getFeed'

const compatibleDatabase: DatabaseCompatibilityChecker = {
  checkCompatibility: vi.fn(async () => ({ compatible: true })),
}

const emptySkeleton = (): FeedSkeletonReader => ({
  getFeedSkeleton: vi.fn(async () => ({ items: [] })),
})

const emptyHydrated = (): HydratedFeedReader => ({
  getFeed: vi.fn(async () => ({ items: [] })),
})

const appServices = (
  skeleton: FeedSkeletonReader = emptySkeleton(),
  hydrated: HydratedFeedReader = emptyHydrated(),
): AppFeedServices => ({ skeleton, hydrated })

const post = (url: string, body: string): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })

describe('HTTP application', () => {
  it('serves the existing skeleton POST procedure unchanged', async () => {
    let received: GetFeedSkeletonInput | undefined
    const skeleton: FeedSkeletonReader = {
      getFeedSkeleton: vi.fn(async (input) => {
        received = input
        return {
          items: [
            {
              id: uri,
              kind: 'cert.create' as const,
              subject: { uri, cid },
              actorDid: actor,
              feedTimestamp,
            },
          ],
        }
      }),
    }
    const app = createApp(
      compatibleDatabase,
      appServices(skeleton),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(skeletonPath, JSON.stringify({ viewerDid: viewer })),
    )

    expect(response.status).toBe(200)
    expect(received).toMatchObject({ viewerDid: viewer })
    await expect(response.json()).resolves.toMatchObject({
      items: [{ id: uri, subject: { cid } }],
    })
  })

  it('serves the unauthenticated hydrated POST procedure', async () => {
    let received: GetFeedSkeletonInput | undefined
    const hydrated: HydratedFeedReader = {
      getFeed: vi.fn(async (input) => {
        received = input
        return {
          items: [
            {
              id: uri,
              kind: 'cert.create' as const,
              subject: { uri, cid },
              feedTimestamp,
              actor: {
                did: actor,
                handle: 'actor.example',
                avatar: {
                  $type: 'org.hypercerts.defs#smallImage' as const,
                  image: avatarBlob,
                },
              },
              view: {
                $type: 'app.certified.feed.beta.defs#activityView' as const,
                title: 'Restore the watershed',
                locationCount: 0,
              },
            },
          ],
        }
      }),
    }
    const app = createApp(
      compatibleDatabase,
      appServices(emptySkeleton(), hydrated),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(hydratedPath, JSON.stringify({ viewerDid: viewer })),
    )

    expect(response.status).toBe(200)
    expect(received).toMatchObject({ viewerDid: viewer })
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          id: uri,
          actor: {
            did: actor,
            avatar: {
              $type: 'org.hypercerts.defs#smallImage',
              image: {
                $type: 'blob',
                ref: { $link: blobCid },
                mimeType: 'image/png',
                size: 128,
              },
            },
          },
          view: { $type: 'app.certified.feed.beta.defs#activityView' },
        },
      ],
    })
  })

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ])('rejects malformed JSON for the %s route without invoking services', async (_label, url) => {
    const getFeedSkeleton = vi.fn()
    const getFeed = vi.fn()
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }, { getFeed }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(post(url, '{'))

    expect(response.status).toBe(400)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    expect(getFeed).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
      message: expect.stringContaining('not valid JSON'),
    })
  })

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ])('rejects an oversized declared body for the %s route', async (_label, url) => {
    const getFeedSkeleton = vi.fn()
    const getFeed = vi.fn()
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }, { getFeed }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-length': String(64 * 1024 + 1),
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    expect(response.status).toBe(413)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    expect(getFeed).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      error: 'InvalidRequest',
      message:
        'Request body exceeds the 65536-byte limit; remove unnecessary evaluators or other fields before retrying.',
    })
  })

  it('cancels and rejects an oversized streamed feed body', async () => {
    const getFeedSkeleton = vi.fn()
    const getFeed = vi.fn()
    const metrics = new Metrics()
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }, { getFeed }),
      metrics,
      logger,
    )
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1))
      },
      cancel,
    })

    const response = await app.fetch(
      new Request(hydratedPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    )

    expect(response.status).toBe(413)
    expect(cancel).toHaveBeenCalledWith('request body limit exceeded')
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    expect(getFeed).not.toHaveBeenCalled()
  })

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ])('rejects non-POST requests for the %s procedure', async (_label, url) => {
    const getFeedSkeleton = vi.fn()
    const getFeed = vi.fn()
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }, { getFeed }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(new Request(url))

    expect(response.status).toBe(405)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    expect(getFeed).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
    })
  })

  it.each([
    [
      'skeleton',
      skeletonPath,
      appServices({
        getFeedSkeleton: vi.fn(async () => ({
          items: [
            {
              id: 'not-an-at-uri',
              kind: 'cert.create' as const,
              subject: { uri: 'bad', cid: 'bad' },
              actorDid: 'not-a-did',
              feedTimestamp: 'not-a-date',
            },
          ],
        })),
      }),
    ],
    [
      'hydrated',
      hydratedPath,
      appServices(emptySkeleton(), {
        getFeed: vi.fn(async () => ({
          items: [
            {
              id: 'not-an-at-uri',
              kind: 'cert.create' as const,
              subject: { uri: 'bad', cid: 'bad' },
              feedTimestamp: 'not-a-date',
              actor: { did: 'not-a-did' },
              view: {
                $type: 'app.certified.feed.beta.defs#activityView' as const,
                title: 'Invalid response fixture',
                locationCount: 0,
              },
            },
          ],
        })),
      }),
    ],
  ])('rejects an invalid %s service response instead of violating the Lexicon', async (_label, url, services) => {
    const app = createApp(compatibleDatabase, services, new Metrics(), logger)

    const response = await app.fetch(
      post(url, JSON.stringify({ viewerDid: viewer })),
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'InternalError',
    })
  })

  it.each([
    ['app.certified.feed.beta.getFeedSkeleton', skeletonPath],
    ['app.certified.feed.beta.getFeed', hydratedPath],
  ])('normalizes Lexicon validation failures for %s', async (nsid, url) => {
    const app = createApp(
      compatibleDatabase,
      appServices(),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(post(url, '{}'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
      message: expect.stringContaining(nsid),
    })
  })

  it.each([
    ['skeleton', skeletonPath],
    ['hydrated', hydratedPath],
  ])('rejects a malformed viewer for the %s route as InvalidRequest', async (_label, url) => {
    const getFeedSkeleton = vi.fn()
    const getFeed = vi.fn()
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }, { getFeed }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(url, JSON.stringify({ viewerDid: 'alice.test' })),
    )

    expect(response.status).toBe(400)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    expect(getFeed).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
      message: expect.stringContaining('Invalid DID'),
    })
  })

  it('keeps expected skeleton FeedError translation unchanged', async () => {
    const getFeedSkeleton = vi.fn(async () => {
      throw new FeedError(
        FeedErrorCode.TrustedEvaluatorsTooLarge,
        'Reduce trustedEvaluators before retrying.',
        422,
      )
    })
    const app = createApp(
      compatibleDatabase,
      appServices({ getFeedSkeleton }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(skeletonPath, JSON.stringify({ viewerDid: viewer })),
    )

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      error: 'TrustedEvaluatorsTooLarge',
      message: 'Reduce trustedEvaluators before retrying.',
    })
  })

  it('translates expected hydrated FeedError details without leaking its cause', async () => {
    const internalCause = new Error('secret database detail')
    const getFeed = vi.fn(async () => {
      throw new FeedError(
        FeedErrorCode.TrustedEvaluatorsTooLarge,
        'Reduce trustedEvaluators before retrying.',
        422,
        { cause: internalCause },
      )
    })
    const app = createApp(
      compatibleDatabase,
      appServices(emptySkeleton(), { getFeed }),
      new Metrics(),
      logger,
    )

    const response = await app.fetch(
      post(hydratedPath, JSON.stringify({ viewerDid: viewer })),
    )
    const responseText = await response.text()

    expect(getFeed).toHaveBeenCalledOnce()
    expect(response.status).toBe(422)
    expect(JSON.parse(responseText)).toEqual({
      error: 'TrustedEvaluatorsTooLarge',
      message: 'Reduce trustedEvaluators before retrying.',
    })
    expect(responseText).not.toContain(internalCause.message)
  })

  it('redacts unknown hydrated failures and records bounded route/error metrics', async () => {
    const getFeed = vi.fn(async () => {
      throw new Error('secret hydrated failure')
    })
    const metrics = new Metrics()
    const app = createApp(
      compatibleDatabase,
      appServices(emptySkeleton(), { getFeed }),
      metrics,
      logger,
    )

    const response = await app.fetch(
      post(hydratedPath, JSON.stringify({ viewerDid: viewer })),
    )
    const responseText = await response.text()
    const metricText = await metrics.registry.metrics()

    expect(response.status).toBe(500)
    expect(responseText).not.toContain('secret hydrated failure')
    expect(JSON.parse(responseText)).toMatchObject({ error: 'InternalError' })
    expect(metricText).toContain('route="feed_hydrated"')
    expect(metricText).toContain('error="InternalError"')
    expect(metricText).not.toContain(viewer)
    expect(metricText).not.toContain(uri)
  })

  it('maps arbitrary HTTP methods to the bounded OTHER metrics label', async () => {
    const metrics = new Metrics()
    const app = createApp(
      compatibleDatabase,
      appServices(),
      metrics,
      logger,
    )

    await app.fetch(
      new Request('http://localhost/not-found', { method: 'BREW' }),
    )
    await app.fetch(
      new Request('http://localhost/not-found', { method: 'REINDEX' }),
    )
    const metricText = await metrics.registry.metrics()

    expect(metricText).toContain('method="OTHER"')
    expect(metricText).not.toContain('method="BREW"')
    expect(metricText).not.toContain('method="REINDEX"')
  })

  it('reports readiness failures without marking the process unhealthy', async () => {
    const database: DatabaseCompatibilityChecker = {
      checkCompatibility: vi.fn(async () => ({
        compatible: false,
        reason: 'database readiness capability check failed',
      })),
    }
    const app = createApp(database, appServices(), new Metrics(), logger)

    const health = await app.fetch(new Request('http://localhost/health'))
    const ready = await app.fetch(new Request('http://localhost/ready'))

    expect(health.status).toBe(200)
    expect(ready.status).toBe(503)
    await expect(ready.json()).resolves.toMatchObject({ status: 'not_ready' })
  })
})

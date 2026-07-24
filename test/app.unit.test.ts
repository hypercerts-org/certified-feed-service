import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import type { DatabaseCompatibilityChecker } from '../src/database.js'
import { FeedError, FeedErrorCode } from '../src/feed/errors.js'
import type { FeedSkeletonReader } from '../src/feed/service.js'
import type { GetFeedSkeletonInput } from '../src/feed/types.js'
import { Metrics } from '../src/metrics.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actor = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actor}/org.hypercerts.claim.activity/3kpn`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const logger = pino({ enabled: false })

const compatibleDatabase: DatabaseCompatibilityChecker = {
  checkCompatibility: vi.fn(async () => ({ compatible: true })),
}

describe('HTTP application', () => {
  it('serves the custom POST XRPC procedure', async () => {
    let received: GetFeedSkeletonInput | undefined
    const feed: FeedSkeletonReader = {
      getFeedSkeleton: vi.fn(async (input) => {
        received = input
        return {
          items: [
            {
              id: uri,
              kind: 'cert.create' as const,
              subject: { uri, cid },
              actorDid: actor,
              sortAt: '2026-07-21T10:00:00.000000Z',
            },
          ],
        }
      }),
    }
    const app = createApp(compatibleDatabase, feed, new Metrics(), logger)

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ viewerDid: viewer, authors: [actor] }),
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(received).toMatchObject({ viewerDid: viewer, authors: [actor] })
    await expect(response.json()).resolves.toMatchObject({
      items: [{ id: uri, subject: { cid } }],
    })
  })

  it('rejects malformed JSON without invoking the procedure', async () => {
    const getFeedSkeleton = vi.fn()
    const feed: FeedSkeletonReader = { getFeedSkeleton }
    const app = createApp(compatibleDatabase, feed, new Metrics(), logger)

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        },
      ),
    )

    expect(response.status).toBe(400)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
      message: expect.stringContaining('not valid JSON'),
    })
  })

  it('rejects an oversized declared body without invoking the procedure', async () => {
    const getFeedSkeleton = vi.fn()
    const feed: FeedSkeletonReader = { getFeedSkeleton }
    const app = createApp(compatibleDatabase, feed, new Metrics(), logger)

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
        {
          method: 'POST',
          headers: {
            'content-length': String(64 * 1024 + 1),
            'content-type': 'application/json',
          },
          body: '{}',
        },
      ),
    )

    expect(response.status).toBe(413)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      error: 'InvalidRequest',
      message:
        'Request body exceeds the 65536-byte limit; remove unnecessary authors, evaluators, or other fields before retrying.',
    })
  })

  it('cancels and rejects an oversized streamed body without invoking the procedure', async () => {
    const getFeedSkeleton = vi.fn()
    const feed: FeedSkeletonReader = { getFeedSkeleton }
    const metrics = new Metrics()
    const app = createApp(compatibleDatabase, feed, metrics, logger)
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1))
      },
      cancel,
    })

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' },
      ),
    )

    expect(response.status).toBe(413)
    expect(cancel).toHaveBeenCalledWith('request body limit exceeded')
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      error: 'InvalidRequest',
      message:
        'Request body exceeds the 65536-byte limit; remove unnecessary authors, evaluators, or other fields before retrying.',
    })
  })

  it('rejects non-POST requests without invoking the procedure', async () => {
    const getFeedSkeleton = vi.fn()
    const feed: FeedSkeletonReader = { getFeedSkeleton }
    const app = createApp(compatibleDatabase, feed, new Metrics(), logger)

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
      ),
    )

    expect(response.status).toBe(405)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
    })
  })

  it('rejects an invalid service response instead of violating the Lexicon', async () => {
    const feed: FeedSkeletonReader = {
      getFeedSkeleton: vi.fn(async () => ({
        items: [
          {
            id: 'not-an-at-uri',
            kind: 'cert.create' as const,
            subject: { uri: 'bad', cid: 'bad' },
            actorDid: 'not-a-did',
            sortAt: 'not-a-date',
          },
        ],
      })),
    }
    const app = createApp(compatibleDatabase, feed, new Metrics(), logger)

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ viewerDid: viewer }),
        },
      ),
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'InternalError',
    })
  })

  it('normalizes Lexicon validation failures to InvalidRequest', async () => {
    const feed: FeedSkeletonReader = {
      getFeedSkeleton: vi.fn(),
    }
    const app = createApp(compatibleDatabase, feed, new Metrics(), logger)

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      ),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
    })
  })

  it('rejects a malformed viewer as InvalidRequest before invoking the service', async () => {
    const getFeedSkeleton = vi.fn()
    const feed: FeedSkeletonReader = { getFeedSkeleton }
    const app = createApp(compatibleDatabase, feed, new Metrics(), logger)

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ viewerDid: 'alice.test' }),
        },
      ),
    )

    expect(response.status).toBe(400)
    expect(getFeedSkeleton).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: 'InvalidRequest',
      message: expect.stringContaining('Invalid DID'),
    })
  })

  it('translates expected FeedError details without leaking its internal cause', async () => {
    const internalCause = new Error('secret database detail')
    const getFeedSkeleton = vi.fn(async () => {
      throw new FeedError(
        FeedErrorCode.FeedScopeTooLarge,
        'Reduce authors or trustedEvaluators before retrying.',
        422,
        { cause: internalCause },
      )
    })
    const feed: FeedSkeletonReader = { getFeedSkeleton }
    const app = createApp(compatibleDatabase, feed, new Metrics(), logger)

    const response = await app.fetch(
      new Request(
        'http://localhost/xrpc/app.certified.feed.beta.getFeedSkeleton',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ viewerDid: viewer }),
        },
      ),
    )
    const responseText = await response.text()

    expect(getFeedSkeleton).toHaveBeenCalledOnce()
    expect(response.status).toBe(422)
    expect(JSON.parse(responseText)).toEqual({
      error: 'FeedScopeTooLarge',
      message: 'Reduce authors or trustedEvaluators before retrying.',
    })
    expect(responseText).not.toContain(internalCause.message)
  })

  it('maps arbitrary HTTP methods to the bounded OTHER metrics label', async () => {
    const feed: FeedSkeletonReader = { getFeedSkeleton: vi.fn() }
    const metrics = new Metrics()
    const app = createApp(compatibleDatabase, feed, metrics, logger)

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
    const feed: FeedSkeletonReader = { getFeedSkeleton: vi.fn() }
    const app = createApp(database, feed, new Metrics(), logger)

    const health = await app.fetch(new Request('http://localhost/health'))
    const ready = await app.fetch(new Request('http://localhost/ready'))

    expect(health.status).toBe(200)
    expect(ready.status).toBe(503)
    await expect(ready.json()).resolves.toMatchObject({ status: 'not_ready' })
  })
})

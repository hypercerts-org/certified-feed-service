import { performance } from 'node:perf_hooks'

import { LexRouter, LexServerError } from '@atproto/lex-server'
import type { Logger } from 'pino'

import { registerGetFeedSkeleton } from './api/get-feed-skeleton.js'
import { registerGetFeed } from './api/get-feed.js'
import type { DatabaseCompatibilityChecker } from './database.js'
import { FeedErrorCode } from './feed/errors.js'
import type { FeedSkeletonReader } from './feed/service.js'
import type { HydratedFeedReader } from './hydration/service.js'
import type { Metrics } from './metrics.js'

const MAX_REQUEST_BODY_BYTES = 64 * 1024

const FEED_ROUTES = [
  {
    path: '/xrpc/app.certified.feed.beta.getFeedSkeleton',
    nsid: 'app.certified.feed.beta.getFeedSkeleton',
    label: 'feed_skeleton',
  },
  {
    path: '/xrpc/app.certified.feed.beta.getFeed',
    nsid: 'app.certified.feed.beta.getFeed',
    label: 'feed_hydrated',
  },
] as const

type FeedRoute = (typeof FEED_ROUTES)[number]
type FetchHandler = (request: Request) => Promise<Response>

const feedRoute = (pathname: string): FeedRoute | undefined =>
  FEED_ROUTES.find((route) => route.path === pathname)

const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })

const requestTooLargeResponse = (): Response =>
  jsonResponse(
    {
      error: FeedErrorCode.InvalidRequest,
      message: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit; remove unnecessary authors, evaluators, or other fields before retrying.`,
    },
    413,
  )

const methodNotAllowed = (expected: 'GET' | 'POST'): Response =>
  jsonResponse(
    {
      error: FeedErrorCode.InvalidRequest,
      message: `This endpoint requires ${expected}; change the HTTP method and retry.`,
    },
    405,
  )

const routeLabel = (pathname: string): string => {
  if (pathname === '/health') return 'health'
  if (pathname === '/ready') return 'ready'
  if (pathname === '/metrics') return 'metrics'
  return feedRoute(pathname)?.label ?? 'other'
}

const readBoundedRequest = async (
  request: Request,
): Promise<Request | Response> => {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
    return requestTooLargeResponse()
  }
  if (request.body === null) return request

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel('request body limit exceeded')
      return requestTooLargeResponse()
    }
    chunks.push(value)
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  const headers = new Headers(request.headers)
  headers.set('content-length', String(size))
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  })
}

const rejectMalformedJson = async (
  request: Request,
): Promise<Response | undefined> => {
  try {
    await request.clone().json()
    return undefined
  } catch {
    return jsonResponse(
      {
        error: FeedErrorCode.InvalidRequest,
        message:
          'Request body is not valid JSON; correct the JSON syntax and retry.',
      },
      400,
    )
  }
}

const normalizeLexiconValidationError = async (
  response: Response,
  metrics: Metrics,
  nsid: string | undefined,
): Promise<Response> => {
  if (nsid === undefined) return response
  if (response.status !== 400) return response
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return response

  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return response
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('error' in body) ||
    body.error !== FeedErrorCode.InvalidRequest
  ) {
    return response
  }
  const detail =
    'message' in body && typeof body.message === 'string'
      ? ` Details: ${body.message}`
      : ''
  metrics.observeError(FeedErrorCode.InvalidRequest)
  return jsonResponse(
    {
      error: FeedErrorCode.InvalidRequest,
      message: `Request body does not match ${nsid}; correct the missing or invalid field and retry.${detail}`,
    },
    400,
  )
}

/** Public feed services registered at the HTTP composition boundary. */
export interface AppFeedServices {
  readonly skeleton: FeedSkeletonReader
  readonly hydrated: HydratedFeedReader
}

/** Builds the fetch-style HTTP application containing XRPC and operational endpoints. */
export const createApp = (
  database: DatabaseCompatibilityChecker,
  services: AppFeedServices,
  metrics: Metrics,
  logger: Logger,
): { fetch: FetchHandler } => {
  const router = new LexRouter({
    onHandlerError: ({ error, method }) => {
      if (error instanceof LexServerError) return
      logger.error({ err: error, nsid: method.nsid }, 'unexpected XRPC handler error')
    },
  })
  registerGetFeedSkeleton(router, services.skeleton, metrics, logger)
  registerGetFeed(router, services.hydrated, metrics, logger)

  return {
    fetch: async (originalRequest: Request): Promise<Response> => {
      const startedAt = performance.now()
      const url = new URL(originalRequest.url)
      const matchedFeedRoute = feedRoute(url.pathname)
      const route = routeLabel(url.pathname)
      let status = 500
      try {
        let response: Response
        if (url.pathname === '/health') {
          response =
            originalRequest.method === 'GET'
              ? jsonResponse({ status: 'ok' })
              : methodNotAllowed('GET')
        } else if (url.pathname === '/ready' && originalRequest.method !== 'GET') {
          response = methodNotAllowed('GET')
        } else if (url.pathname === '/ready') {
          const readyStartedAt = performance.now()
          const compatibility = await database.checkCompatibility()
          metrics.observeDatabase(
            'readiness',
            (performance.now() - readyStartedAt) / 1_000,
          )
          metrics.setReady(compatibility.compatible)
          response = compatibility.compatible
            ? jsonResponse({ status: 'ready' })
            : jsonResponse(
                { status: 'not_ready', reason: compatibility.reason },
                503,
              )
        } else if (url.pathname === '/metrics') {
          response =
            originalRequest.method === 'GET'
              ? new Response(await metrics.registry.metrics(), {
                  status: 200,
                  headers: { 'content-type': metrics.registry.contentType },
                })
              : methodNotAllowed('GET')
        } else if (matchedFeedRoute && originalRequest.method !== 'POST') {
          metrics.observeError(FeedErrorCode.InvalidRequest)
          response = methodNotAllowed('POST')
        } else {
          let request = originalRequest
          if (matchedFeedRoute && originalRequest.method === 'POST') {
            const bounded = await readBoundedRequest(originalRequest)
            if (bounded instanceof Response) {
              metrics.observeError(FeedErrorCode.InvalidRequest)
              response = bounded
              status = response.status
              return response
            }
            request = bounded
            const malformedJson = await rejectMalformedJson(request)
            if (malformedJson) {
              metrics.observeError(FeedErrorCode.InvalidRequest)
              response = malformedJson
              status = response.status
              return response
            }
          }
          response = await router.fetch(request)
          response = await normalizeLexiconValidationError(
            response,
            metrics,
            matchedFeedRoute?.nsid,
          )
        }
        status = response.status
        return response
      } finally {
        metrics.observeRequest(
          route,
          originalRequest.method,
          status,
          (performance.now() - startedAt) / 1_000,
        )
      }
    },
  }
}

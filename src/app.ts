import { performance } from 'node:perf_hooks'

import { LexRouter, LexServerError } from '@atproto/lex-server'
import type { Logger } from 'pino'

import { registerGetFeedSkeleton } from './api/get-feed-skeleton.js'
import { registerGetFeed } from './api/get-feed.js'
import type { DatabaseCompatibilityChecker } from './database.js'
import { DEFAULT_CORS_ALLOWED_ORIGINS } from './config.js'
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

export interface AppCorsOptions {
  /** Exact origins allowed to receive CORS response headers. */
  readonly allowedOrigins: readonly string[]
  /** Allows HTTP localhost, loopback, and IPv6 loopback origins on any port. */
  readonly allowLocalhost: boolean
}

const DEFAULT_CORS_OPTIONS: AppCorsOptions = {
  allowedOrigins: DEFAULT_CORS_ALLOWED_ORIGINS,
  allowLocalhost: true,
}

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
      message: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit; remove unnecessary feed parameters or other fields before retrying.`,
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

const isLocalhostOrigin = (origin: string): boolean => {
  try {
    const parsed = new URL(origin)
    const isCanonicalOrigin = parsed.origin === origin
    const isExplicitHttpDefaultPort =
      parsed.protocol === 'http:' &&
      parsed.port === '' &&
      origin === `http://${parsed.hostname}:80`
    return (
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
      (isCanonicalOrigin || isExplicitHttpDefaultPort)
    )
  } catch {
    return false
  }
}

const allowedCorsOrigin = (
  origin: string | null,
  options: AppCorsOptions,
): string | undefined => {
  if (origin === null) return undefined
  if (options.allowedOrigins.includes(origin)) return origin
  return options.allowLocalhost && isLocalhostOrigin(origin)
    ? origin
    : undefined
}

const setVaryOrigin = (headers: Headers): void => {
  const values = new Set(
    (headers.get('vary') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )
  if (!values.has('origin')) {
    const current = headers.get('vary')
    headers.set('vary', current ? `${current}, Origin` : 'Origin')
  }
}

const withCorsHeaders = (
  response: Response,
  origin: string | undefined,
): Response => {
  if (origin === undefined) return response
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  setVaryOrigin(headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const corsPreflightResponse = (
  origin: string | undefined,
  request: Request,
): Response => {
  if (origin === undefined) {
    return jsonResponse(
      {
        error: FeedErrorCode.InvalidRequest,
        message:
          'This browser origin is not allowed; use a configured feed client origin and retry.',
      },
      403,
    )
  }

  const requestedMethod = request.headers.get('access-control-request-method')
  if (requestedMethod !== 'POST') {
    return jsonResponse(
      {
        error: FeedErrorCode.InvalidRequest,
        message:
          'This feed preflight must request POST; retry with the feed procedure method.',
      },
      400,
    )
  }

  const requestedHeaders = request.headers.get('access-control-request-headers')
  const unsupportedHeader = requestedHeaders
    ?.split(',')
    .map((value) => value.trim().toLowerCase())
    .find((value) => value !== '' && value !== 'content-type')
  if (unsupportedHeader !== undefined) {
    return jsonResponse(
      {
        error: FeedErrorCode.InvalidRequest,
        message: `This feed preflight requests unsupported header ${JSON.stringify(unsupportedHeader)}; retry with content-type only.`,
      },
      400,
    )
  }

  const headers = new Headers({
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  })
  setVaryOrigin(headers)
  return new Response(null, { status: 204, headers })
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

const handleHealthRequest = (request: Request): Response =>
  request.method === 'GET'
    ? jsonResponse({ status: 'ok' })
    : methodNotAllowed('GET')

const handleReadyRequest = async (
  request: Request,
  database: DatabaseCompatibilityChecker,
  metrics: Metrics,
): Promise<Response> => {
  if (request.method !== 'GET') return methodNotAllowed('GET')

  const startedAt = performance.now()
  const compatibility = await database.checkCompatibility()
  metrics.observeDatabase(
    'readiness',
    (performance.now() - startedAt) / 1_000,
  )
  metrics.setReady(compatibility.compatible)
  return compatibility.compatible
    ? jsonResponse({ status: 'ready' })
    : jsonResponse(
        { status: 'not_ready', reason: compatibility.reason },
        503,
      )
}

const handleMetricsRequest = async (
  request: Request,
  metrics: Metrics,
): Promise<Response> =>
  request.method === 'GET'
    ? new Response(await metrics.registry.metrics(), {
        status: 200,
        headers: { 'content-type': metrics.registry.contentType },
      })
    : methodNotAllowed('GET')

const handleFeedRequest = async (
  originalRequest: Request,
  matchedRoute: FeedRoute | undefined,
  router: LexRouter,
  metrics: Metrics,
): Promise<Response> => {
  if (matchedRoute && originalRequest.method !== 'POST') {
    metrics.observeError(FeedErrorCode.InvalidRequest)
    return methodNotAllowed('POST')
  }

  let request = originalRequest
  if (matchedRoute) {
    const bounded = await readBoundedRequest(originalRequest)
    if (bounded instanceof Response) {
      metrics.observeError(FeedErrorCode.InvalidRequest)
      return bounded
    }
    request = bounded

    const malformedJson = await rejectMalformedJson(request)
    if (malformedJson) {
      metrics.observeError(FeedErrorCode.InvalidRequest)
      return malformedJson
    }
  }

  const response = await router.fetch(request)
  return normalizeLexiconValidationError(
    response,
    metrics,
    matchedRoute?.nsid,
  )
}

const handleRequest = async (
  request: Request,
  pathname: string,
  database: DatabaseCompatibilityChecker,
  router: LexRouter,
  metrics: Metrics,
  corsOptions: AppCorsOptions,
): Promise<Response> => {
  const matchedFeedRoute = feedRoute(pathname)
  const corsOrigin =
    matchedFeedRoute === undefined
      ? undefined
      : allowedCorsOrigin(request.headers.get('origin'), corsOptions)

  let response: Response
  if (matchedFeedRoute && request.method === 'OPTIONS') {
    response = corsPreflightResponse(corsOrigin, request)
    if (response.status >= 400) {
      metrics.observeError(FeedErrorCode.InvalidRequest)
    }
  } else if (pathname === '/health') {
    response = handleHealthRequest(request)
  } else if (pathname === '/ready') {
    response = await handleReadyRequest(request, database, metrics)
  } else if (pathname === '/metrics') {
    response = await handleMetricsRequest(request, metrics)
  } else {
    response = await handleFeedRequest(request, matchedFeedRoute, router, metrics)
  }

  return withCorsHeaders(response, corsOrigin)
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
  corsOptions: AppCorsOptions = DEFAULT_CORS_OPTIONS,
): { fetch: FetchHandler } => {
  const router = new LexRouter({
    onHandlerError: ({ error, method }) => {
      if (error instanceof LexServerError) return
      logger.error({ err: error, nsid: method.nsid }, 'unexpected XRPC handler error')
    },
  })
  registerGetFeedSkeleton(router, services.skeleton, metrics, logger)
  registerGetFeed(router, services.hydrated, metrics, logger)

  const fetch: FetchHandler = async (request) => {
    const startedAt = performance.now()
    const pathname = new URL(request.url).pathname
    const route = routeLabel(pathname)
    let status = 500
    try {
      const response = await handleRequest(
        request,
        pathname,
        database,
        router,
        metrics,
        corsOptions,
      )
      status = response.status
      return response
    } finally {
      metrics.observeRequest(
        route,
        request.method,
        status,
        (performance.now() - startedAt) / 1_000,
      )
    }
  }

  return { fetch }
}

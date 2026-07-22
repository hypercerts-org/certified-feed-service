import { isDatetimeString, isValidAtUri } from '@atproto/syntax'

import { FeedError } from './errors.js'
const CURSOR_VERSION = 2
const MAX_CURSOR_LENGTH = 4096
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/** Decoded keyset position carried between feed pages. */
export interface FeedCursor {
  /** Cursor contract version. */
  readonly version: 2
  /** Effective RFC3339 timestamp of the last returned item. */
  readonly value: string
  /** AT-URI tie-breaker of the last returned item. */
  readonly uri: string
}

/** Encodes one deterministic feed position as unpadded base64url JSON. */
export const encodeCursor = (value: string, uri: string): string =>
  Buffer.from(JSON.stringify({ version: CURSOR_VERSION, value, uri }), 'utf8').toString(
    'base64url',
  )

/** Decodes and validates an opaque cursor for descending createdAt pagination. */
export const decodeCursor = (cursor: string | undefined): FeedCursor | undefined => {
  if (cursor === undefined || cursor === '') return undefined
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new FeedError(
      'INVALID_CURSOR',
      `cursor exceeds the maximum encoded length of ${MAX_CURSOR_LENGTH} characters; discard it and request the first page again.`,
    )
  }
  if (!BASE64URL_PATTERN.test(cursor)) {
    throw new FeedError(
      'INVALID_CURSOR',
      'cursor is not valid unpadded base64url; use the cursor exactly as returned by the previous page.',
    )
  }

  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (cause) {
    throw new FeedError(
      'INVALID_CURSOR',
      'cursor does not contain valid JSON; discard it and request the first page again.',
      400,
      { cause },
    )
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3
  ) {
    throw new FeedError(
      'INVALID_CURSOR',
      'cursor payload has the wrong shape; use the cursor exactly as returned by the previous page.',
    )
  }

  const payload = value as Record<string, unknown>
  if (payload.version !== CURSOR_VERSION) {
    throw new FeedError(
      'INVALID_CURSOR',
      `cursor version must be ${CURSOR_VERSION}; discard this unsupported cursor and request the first page again.`,
    )
  }
  if (typeof payload.value !== 'string' || !isDatetimeString(payload.value)) {
    throw new FeedError(
      'INVALID_CURSOR',
      'cursor value must be a valid RFC3339 timestamp; use the cursor exactly as returned by the previous page.',
    )
  }
  if (typeof payload.uri !== 'string' || !isValidAtUri(payload.uri)) {
    throw new FeedError(
      'INVALID_CURSOR',
      'cursor uri must be a valid AT-URI; use the cursor exactly as returned by the previous page.',
    )
  }

  return {
    version: CURSOR_VERSION,
    value: payload.value,
    uri: payload.uri,
  }
}

import { describe, expect, it } from 'vitest'

import { decodeCursor, encodeCursor } from '../src/feed/cursor.js'
import { FeedError } from '../src/feed/errors.js'

const uri =
  'at://did:plc:ar7c4by46qjdydhdevvrndac/org.hypercerts.claim.activity/3kpn'

describe('feed cursor', () => {
  it('round-trips a versioned keyset position', () => {
    const encoded = encodeCursor('2026-07-21T10:00:00.123456Z', uri)

    expect(decodeCursor(encoded)).toEqual({
      version: 2,
      value: '2026-07-21T10:00:00.123456Z',
      uri,
    })
  })

  it('rejects a cursor from the previous sorting contract', () => {
    const encoded = Buffer.from(
      JSON.stringify({
        version: 1,
        sortBy: 'sortAt',
        value: '2026-07-21T10:00:00.000000Z',
        uri,
      }),
    ).toString('base64url')

    expect(() => decodeCursor(encoded)).toThrowError(
      expect.objectContaining<Partial<FeedError>>({ code: 'InvalidCursor' }),
    )
  })

  it.each([
    'not base64url!',
    Buffer.from('not-json').toString('base64url'),
    Buffer.from(
      JSON.stringify({ version: 3, value: 'x', uri }),
    ).toString('base64url'),
    Buffer.from(
      JSON.stringify({ version: 2, value: 'not-a-time', uri }),
    ).toString('base64url'),
  ])('rejects malformed cursor %s', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrowError(
      expect.objectContaining<Partial<FeedError>>({ code: 'InvalidCursor' }),
    )
  })
})

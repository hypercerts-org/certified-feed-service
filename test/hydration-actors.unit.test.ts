import { jsonToLex } from '@atproto/lex'
import type { QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import {
  type IdentityQueryExecutor,
  PostgresIdentityReader,
} from '../src/hydration/identity.js'
import type { ActorRow } from '../src/hydration/types.js'
import {
  isMeaningfulCertifiedProfile,
  sanitizeActorRow,
  validateBlueskyProfile,
  validateCertifiedProfile,
} from '../src/hydration/validation.js'
import { buildActorSummary } from '../src/hydration/views.js'

const didA = 'did:plc:abcdefghijklmnopqrstuvwx'
const didB = 'did:plc:zyxwvutsrqponmlkjihgfedc'
const didC = 'did:plc:bcdefghijklmnopqrstuvwxy'
const didD = 'did:plc:cdefghijklmnopqrstuvwxyz'
const blobCid = 'bafkreiehxpuhtr5f6v4eu4byjo2j7kkrhjvd7psmfu4imnpdzb3bdqb7vy'
const createdAt = '2026-07-20T00:00:00.000Z'

class FakeQueryExecutor implements IdentityQueryExecutor {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = []

  constructor(
    private readonly resultRows: readonly Record<string, unknown>[],
    private readonly failure?: Error,
  ) {}

  async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly T[] }> {
    this.calls.push({ text, values })
    if (this.failure) throw this.failure
    return { rows: this.resultRows as unknown as readonly T[] }
  }
}

const actorRow = (overrides: Partial<ActorRow> = {}): ActorRow => ({
  did: didA,
  handle: 'alice.example',
  ...overrides,
})

const profile = (overrides: Record<string, unknown> = {}): unknown => ({
  $type: 'app.certified.actor.profile',
  createdAt,
  ...overrides,
})

const blueskyProfile = (overrides: Record<string, unknown> = {}): unknown => ({
  $type: 'app.bsky.actor.profile',
  ...overrides,
})

const blueskyAvatarBlob = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  $type: 'blob',
  ref: { $link: blobCid },
  mimeType: 'image/png',
  size: 128,
  ...overrides,
})

const blobImage = (
  overrides: Record<string, unknown> = {},
  variant: 'smallImage' | 'largeImage' = 'smallImage',
): unknown => ({
  $type: `org.hypercerts.defs#${variant}`,
  image: {
    $type: 'blob',
    ref: { $link: blobCid },
    mimeType: 'image/png',
    size: 128,
    ...overrides,
  },
})

const protocolValue = (value: unknown): unknown =>
  jsonToLex(value as Parameters<typeof jsonToLex>[0], { strict: true })

const identityResultRow = (
  requestedDid: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  requested_did: requestedDid,
  actor_did: requestedDid,
  handle: null,
  certified_profile_json: null,
  bluesky_profile_json: null,
  ...overrides,
})

describe('PostgresIdentityReader', () => {
  it('avoids PostgreSQL for an empty batch', async () => {
    const database = new FakeQueryExecutor([])
    const reader = new PostgresIdentityReader(database)

    await expect(reader.getByDids([])).resolves.toEqual(new Map())
    expect(database.calls).toEqual([])
  })

  it('returns a DID-only context for every requested DID when storage rows are absent', async () => {
    const database = new FakeQueryExecutor([])
    const reader = new PostgresIdentityReader(database)

    await expect(reader.getByDids([didA, didB])).resolves.toEqual(
      new Map([
        [didA, { did: didA }],
        [didB, { did: didB }],
      ]),
    )
    expect(database.calls).toHaveLength(1)
  })

  it('deduplicates one batch and restores complete contexts in requested DID order', async () => {
    const rawCertifiedA = profile({ displayName: 'Certified Alice' })
    const rawCertifiedC = profile({ description: 'Certified profile only' })
    const rawBlueskyB = blueskyProfile({ displayName: 'Bluesky Bob' })
    const rawBlueskyC = blueskyProfile({ displayName: 'Bluesky Carol' })
    const database = new FakeQueryExecutor([
      {
        requested_did: didD,
        actor_did: null,
        handle: null,
        certified_profile_json: null,
        bluesky_profile_json: null,
      },
      {
        requested_did: didC,
        actor_did: null,
        handle: null,
        certified_profile_json: rawCertifiedC,
        bluesky_profile_json: rawBlueskyC,
      },
      {
        requested_did: didB,
        actor_did: didB,
        handle: null,
        certified_profile_json: null,
        bluesky_profile_json: rawBlueskyB,
      },
      {
        requested_did: didA,
        actor_did: didA,
        handle: 'alice.example',
        certified_profile_json: rawCertifiedA,
        bluesky_profile_json: null,
      },
    ])
    const reader = new PostgresIdentityReader(database)

    await expect(
      reader.getByDids([didA, didB, didC, didD, didA]),
    ).resolves.toEqual(
      new Map([
        [
          didA,
          {
            did: didA,
            actor: {
              did: didA,
              handle: 'alice.example',
            },
            certifiedProfile: rawCertifiedA,
          },
        ],
        [
          didB,
          {
            did: didB,
            actor: {
              did: didB,
              handle: null,
            },
            blueskyProfile: rawBlueskyB,
          },
        ],
        [
          didC,
          {
            did: didC,
            certifiedProfile: rawCertifiedC,
            blueskyProfile: rawBlueskyC,
          },
        ],
        [didD, { did: didD }],
      ]),
    )

    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([[didA, didB, didC, didD]])
    const sql = database.calls[0]?.text ?? ''
    expect(sql).toContain('unnest($1::text[])')
    expect(sql).toContain('LEFT JOIN actor')
    expect(sql).toContain('actor.did')
    expect(sql).toContain('actor.handle')
    expect(sql).not.toContain('actor.display_name')
    expect(sql).not.toContain('actor.avatar_cid')
    expect(sql).toContain('app.certified.actor.profile/self')
    expect(sql).toContain(
      "certified_profile.collection = 'app.certified.actor.profile'",
    )
    expect(sql).toContain('app.bsky.actor.profile/self')
    expect(sql).toContain(
      "bluesky_profile.collection = 'app.bsky.actor.profile'",
    )
    expect(sql).not.toContain('is_active')
    expect(sql).not.toContain('certified_profile.did =')
    expect(sql).not.toContain('bluesky_profile.did =')
    expect(sql).not.toContain('certified_profile.cid')
    expect(sql).not.toContain('bluesky_profile.cid')
  })

  it('rejects duplicate result rows for the same requested DID', async () => {
    const reader = new PostgresIdentityReader(
      new FakeQueryExecutor([
        identityResultRow(didA),
        identityResultRow(didA, { handle: 'conflicting.example' }),
      ]),
    )

    await expect(reader.getByDids([didA])).rejects.toThrow(
      /duplicate result rows.*same requested DID.*identity joins/i,
    )
  })

  it('rejects a result row for an unrequested DID', async () => {
    const reader = new PostgresIdentityReader(
      new FakeQueryExecutor([identityResultRow(didB)]),
    )

    await expect(reader.getByDids([didA])).rejects.toThrow(
      /unrequested DID.*requested-DID projection and bind order/i,
    )
  })

  it('rejects actor data joined to a different requested DID', async () => {
    const reader = new PostgresIdentityReader(
      new FakeQueryExecutor([
        identityResultRow(didA, { actor_did: didB }),
      ]),
    )

    await expect(reader.getByDids([didA])).rejects.toThrow(
      /actor data for a different DID.*actor join/i,
    )
  })

  it('propagates PostgreSQL rejection without returning partial contexts', async () => {
    const database = new FakeQueryExecutor([], new Error('identity query failed'))
    const reader = new PostgresIdentityReader(database)

    await expect(reader.getByDids([didA, didB])).rejects.toThrow(
      'identity query failed',
    )
    expect(database.calls).toHaveLength(1)
  })
})

describe('Certified profile validation', () => {
  it('accepts valid v1.0.0 profiles and rejects malformed or wrong-type records', () => {
    expect(validateCertifiedProfile(profile({ displayName: 'Alice' }))).toMatchObject({
      $type: 'app.certified.actor.profile',
      displayName: 'Alice',
    })
    expect(validateCertifiedProfile(null)).toBeUndefined()
    expect(
      validateCertifiedProfile({ createdAt, displayName: 'Alice' }),
    ).toBeUndefined()
    expect(
      validateCertifiedProfile({
        $type: 'app.certified.actor.profile',
        displayName: 'Alice',
      }),
    ).toBeUndefined()
    expect(
      validateCertifiedProfile(
        profile({ $type: 'app.bsky.actor.profile', displayName: 'Alice' }),
      ),
    ).toBeUndefined()
  })

  it('rejects invalid image variants before profile fields are exposed', () => {
    expect(
      validateCertifiedProfile(
        profile({
          displayName: 'Untrusted',
          avatar: {
            $type: 'org.hypercerts.defs#uri',
            uri: 'not a URI',
          },
        }),
      ),
    ).toBeUndefined()
    expect(
      validateCertifiedProfile(
        profile({
          displayName: 'Untrusted',
          avatar: blobImage({ ref: { $link: 'not-a-cid' } }),
        }),
      ),
    ).toBeUndefined()
  })

  it('enforces v1.0.0 constraints for supported profile blobs', () => {
    const invalidProfiles = [
      profile({ avatar: blobImage({ size: -1 }) }),
      profile({ avatar: blobImage({ size: 1.5 }) }),
      profile({ avatar: blobImage({ mimeType: 'application/pdf' }) }),
      profile({ avatar: blobImage({ size: 5_242_881 }) }),
      profile({ banner: blobImage({ size: 10_485_761 }, 'largeImage') }),
      JSON.parse(
        JSON.stringify(profile({ avatar: blobImage({ size: undefined }) })),
      ),
    ]

    for (const invalid of invalidProfiles) {
      expect(validateCertifiedProfile(invalid)).toBeUndefined()
    }
  })

  it('preserves validator-accepted unknown image unions without projecting them', () => {
    const validated = validateCertifiedProfile(
      profile({
        avatar: {
          $type: 'example.feed.futureImage',
          value: 'future',
        },
      }),
    )

    expect(validated).toBeDefined()
    expect(
      buildActorSummary(
        sanitizeActorRow(didA, actorRow()),
        validated,
        undefined,
      ),
    ).toEqual({
      did: didA,
      handle: 'alice.example',
    })
  })

  it('treats all six supported fields as meaningful only after validation', () => {
    const empty = validateCertifiedProfile(profile())
    const meaningfulProfiles = [
      profile({ displayName: 'Alice' }),
      profile({ description: 'Certified bio' }),
      profile({
        avatar: {
          $type: 'org.hypercerts.defs#uri',
          uri: 'https://example.com/avatar.png',
        },
      }),
      profile({
        banner: {
          $type: 'org.hypercerts.defs#uri',
          uri: 'https://example.com/banner.png',
        },
      }),
      profile({ pronouns: 'they/them' }),
      profile({ website: 'https://example.com' }),
    ]

    expect(empty && isMeaningfulCertifiedProfile(empty)).toBe(false)
    for (const raw of meaningfulProfiles) {
      const validated = validateCertifiedProfile(raw)
      expect(validated && isMeaningfulCertifiedProfile(validated)).toBe(true)
    }
  })
})

describe('Bluesky profile validation', () => {
  it('accepts the installed published profile shape with a native avatar blob', () => {
    expect(
      validateBlueskyProfile(
        blueskyProfile({
          displayName: 'Bluesky Alice',
          avatar: blueskyAvatarBlob(),
        }),
      ),
    ).toMatchObject({
      $type: 'app.bsky.actor.profile',
      displayName: 'Bluesky Alice',
      avatar: {
        $type: 'blob',
        mimeType: 'image/png',
        size: 128,
      },
    })
  })

  it('rejects malformed records and invalid avatar blobs', () => {
    const invalidProfiles = [
      { displayName: 'Missing type' },
      blueskyProfile({ $type: 'app.certified.actor.profile' }),
      blueskyProfile({ avatar: blueskyAvatarBlob({ size: -1 }) }),
      blueskyProfile({ avatar: blueskyAvatarBlob({ size: 1.5 }) }),
      blueskyProfile({ avatar: blueskyAvatarBlob({ size: 1_000_001 }) }),
      blueskyProfile({ avatar: blueskyAvatarBlob({ mimeType: 'image/webp' }) }),
      blueskyProfile({ avatar: blueskyAvatarBlob({ ref: { $link: 'bad' } }) }),
    ]

    for (const invalid of invalidProfiles) {
      expect(validateBlueskyProfile(invalid)).toBeUndefined()
    }
  })
})

describe('sanitizeActorRow', () => {
  it('preserves a valid handle with the requested DID', () => {
    expect(sanitizeActorRow(didB, actorRow())).toEqual({
      did: didB,
      handle: 'alice.example',
    })
  })

  it('omits malformed or oversized handles', () => {
    expect(
      sanitizeActorRow(didA, actorRow({ handle: 'not a handle' })),
    ).toEqual({ did: didA })
    expect(
      sanitizeActorRow(
        didA,
        actorRow({ handle: `${'a'.repeat(250)}.example` }),
      ),
    ).toEqual({ did: didA })
  })
})

describe('buildActorSummary', () => {
  it('uses a meaningful Certified profile wholesale while preserving the stored handle', () => {
    const certified = validateCertifiedProfile(
      profile({ displayName: 'Certified Alice' }),
    )
    const bluesky = validateBlueskyProfile(
      blueskyProfile({ displayName: 'Bluesky Alice' }),
    )

    expect(
      buildActorSummary(
        sanitizeActorRow(didA, actorRow()),
        certified,
        bluesky,
      ),
    ).toEqual({
      did: didA,
      handle: 'alice.example',
      displayName: 'Certified Alice',
    })
  })

  it('does not backfill Bluesky or stored fields for website-only and description-only Certified profiles', () => {
    const bluesky = validateBlueskyProfile(
      blueskyProfile({
        displayName: 'Bluesky Alice',
        avatar: blueskyAvatarBlob(),
      }),
    )
    for (const raw of [
      profile({ website: 'https://example.com' }),
      profile({ description: 'Certified bio' }),
    ]) {
      const certified = validateCertifiedProfile(raw)
      expect(
        buildActorSummary(
          sanitizeActorRow(didA, actorRow()),
          certified,
          bluesky,
        ),
      ).toEqual({
        did: didA,
        handle: 'alice.example',
      })
    }
  })

  it('falls back through a valid Bluesky profile when Certified is absent, invalid, or empty', () => {
    const bluesky = validateBlueskyProfile(
      blueskyProfile({
        displayName: 'Bluesky Alice',
        avatar: blueskyAvatarBlob(),
      }),
    )
    const expected = {
      did: didA,
      handle: 'alice.example',
      displayName: 'Bluesky Alice',
      avatar: protocolValue({
        $type: 'org.hypercerts.defs#smallImage',
        image: blueskyAvatarBlob(),
      }),
    }

    for (const certified of [
      undefined,
      validateCertifiedProfile(profile()),
      validateCertifiedProfile(
        profile({ $type: 'app.bsky.actor.profile', displayName: 'Untrusted' }),
      ),
      validateCertifiedProfile(profile({ avatar: blobImage({ size: -1 }) })),
    ]) {
      expect(
        buildActorSummary(
          sanitizeActorRow(didA, actorRow()),
          certified,
          bluesky,
        ),
      ).toEqual(expected)
    }
  })

  it('uses a valid Bluesky profile wholesale without fabricating missing fields', () => {
    const bluesky = validateBlueskyProfile(blueskyProfile())

    expect(
      buildActorSummary(
        sanitizeActorRow(didA, actorRow()),
        undefined,
        bluesky,
      ),
    ).toEqual({ did: didA, handle: 'alice.example' })
  })

  it('falls back to the sanitized stored handle when both profiles are unavailable or invalid', () => {
    const expected = {
      did: didA,
      handle: 'alice.example',
    }

    expect(
      buildActorSummary(
        sanitizeActorRow(didA, actorRow()),
        undefined,
        undefined,
      ),
    ).toEqual(expected)
    expect(
      buildActorSummary(
        sanitizeActorRow(didA, actorRow()),
        undefined,
        validateBlueskyProfile({ displayName: 'invalid' }),
      ),
    ).toEqual(expected)
  })

  it('uses DID-only fallback when no valid identity fields exist', () => {
    expect(
      buildActorSummary(
        sanitizeActorRow(didA, undefined),
        undefined,
        undefined,
      ),
    ).toEqual({ did: didA })
  })

  it('preserves Certified URI and small-image avatar variants', () => {
    const uriProfile = validateCertifiedProfile(
      profile({
        avatar: {
          $type: 'org.hypercerts.defs#uri',
          uri: 'https://example.com/avatar.png',
        },
      }),
    )
    const blobProfile = validateCertifiedProfile(
      JSON.parse(JSON.stringify(profile({ avatar: blobImage() }))),
    )

    expect(
      buildActorSummary(
        sanitizeActorRow(didA, actorRow()),
        uriProfile,
        undefined,
      ).avatar,
    ).toEqual({
      $type: 'org.hypercerts.defs#uri',
      uri: 'https://example.com/avatar.png',
    })
    expect(
      buildActorSummary(
        sanitizeActorRow(didA, actorRow()),
        blobProfile,
        undefined,
      ).avatar,
    ).toEqual(protocolValue(blobImage()))
  })
})

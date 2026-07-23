import type { QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import {
  type ActorQueryExecutor,
  PostgresActorReader,
} from '../src/hydration/actors.js'
import {
  type CertifiedProfileQueryExecutor,
  PostgresCertifiedProfileReader,
} from '../src/hydration/profiles.js'
import type { ActorRow } from '../src/hydration/types.js'
import {
  isMeaningfulCertifiedProfile,
  sanitizeActorRow,
  validateCertifiedProfile,
} from '../src/hydration/validation.js'
import { buildActorSummary } from '../src/hydration/views.js'

const didA = 'did:plc:abcdefghijklmnopqrstuvwx'
const didB = 'did:plc:zyxwvutsrqponmlkjihgfedc'
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const createdAt = '2026-07-20T00:00:00.000Z'

class FakeQueryExecutor implements ActorQueryExecutor, CertifiedProfileQueryExecutor {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = []

  constructor(private readonly resultRows: readonly Record<string, unknown>[]) {}

  async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly T[] }> {
    this.calls.push({ text, values })
    return { rows: this.resultRows as unknown as readonly T[] }
  }
}

const actorRow = (overrides: Partial<ActorRow> = {}): ActorRow => ({
  did: didA,
  handle: 'alice.example',
  displayName: 'Alice',
  avatarCid: cid,
  ...overrides,
})

const profile = (overrides: Record<string, unknown> = {}): unknown => ({
  $type: 'app.certified.actor.profile',
  createdAt,
  ...overrides,
})

const blobImage = (
  overrides: Record<string, unknown> = {},
  variant: 'smallImage' | 'largeImage' = 'smallImage',
): unknown => ({
  $type: `org.hypercerts.defs#${variant}`,
  image: {
    $type: 'blob',
    ref: { $link: cid },
    mimeType: 'image/png',
    size: 128,
    ...overrides,
  },
})

describe('PostgresActorReader', () => {
  it('avoids PostgreSQL for an empty batch', async () => {
    const database = new FakeQueryExecutor([])
    const reader = new PostgresActorReader(database)

    await expect(reader.getByDids([])).resolves.toEqual(new Map())
    expect(database.calls).toEqual([])
  })

  it('deduplicates DIDs, performs one batch, maps rows, and omits missing actors', async () => {
    const database = new FakeQueryExecutor([
      {
        did: didB,
        handle: null,
        display_name: 'Bob',
        avatar_cid: null,
      },
      {
        did: didA,
        handle: 'alice.example',
        display_name: 'Alice',
        avatar_cid: cid,
      },
    ])
    const reader = new PostgresActorReader(database)

    await expect(reader.getByDids([didA, didB, didA])).resolves.toEqual(
      new Map([
        [
          didB,
          { did: didB, handle: null, displayName: 'Bob', avatarCid: null },
        ],
        [
          didA,
          {
            did: didA,
            handle: 'alice.example',
            displayName: 'Alice',
            avatarCid: cid,
          },
        ],
      ]),
    )
    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([[didA, didB]])
    expect(database.calls[0]?.text).toContain('actor.display_name')
    expect(database.calls[0]?.text).not.toContain('is_active')
  })
})

describe('PostgresCertifiedProfileReader', () => {
  it('avoids PostgreSQL for an empty batch', async () => {
    const database = new FakeQueryExecutor([])
    const reader = new PostgresCertifiedProfileReader(database)

    await expect(reader.getByDids([])).resolves.toEqual(new Map())
    expect(database.calls).toEqual([])
  })

  it('deduplicates DIDs and reads one current deterministic self-record batch', async () => {
    const rawProfile = profile({ displayName: 'Alice' })
    const database = new FakeQueryExecutor([
      { did: didA, source_json: rawProfile },
    ])
    const reader = new PostgresCertifiedProfileReader(database)

    await expect(reader.getByDids([didA, didB, didA])).resolves.toEqual(
      new Map([[didA, { did: didA, value: rawProfile }]]),
    )
    expect(database.calls).toHaveLength(1)
    expect(database.calls[0]?.values).toEqual([[didA, didB]])
    expect(database.calls[0]?.text).toContain('app.certified.actor.profile/self')
    expect(database.calls[0]?.text).toContain("source.collection = 'app.certified.actor.profile'")
    expect(database.calls[0]?.text).not.toContain('source.did =')
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
    expect(buildActorSummary(sanitizeActorRow(didA, actorRow()), validated)).toEqual({
      did: didA,
      handle: 'alice.example',
      profileSource: 'certified',
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

describe('sanitizeActorRow', () => {
  it('preserves valid fields and the requested DID', () => {
    expect(sanitizeActorRow(didB, actorRow())).toEqual({
      did: didB,
      handle: 'alice.example',
      displayName: 'Alice',
      avatarCid: cid,
    })
  })

  it('omits malformed optional fields independently', () => {
    expect(
      sanitizeActorRow(
        didA,
        actorRow({ handle: 'not a handle', displayName: 'Alice', avatarCid: 'bad' }),
      ),
    ).toEqual({ did: didA, displayName: 'Alice' })
    expect(
      sanitizeActorRow(
        didA,
        actorRow({ handle: 'alice.example', displayName: null, avatarCid: cid }),
      ),
    ).toEqual({ did: didA, handle: 'alice.example', avatarCid: cid })
  })

  it('omits oversized handles and display names by grapheme and UTF-8 byte limits', () => {
    expect(
      sanitizeActorRow(
        didA,
        actorRow({
          handle: `${'a'.repeat(250)}.example`,
          displayName: 'a'.repeat(65),
          avatarCid: cid,
        }),
      ),
    ).toEqual({ did: didA, avatarCid: cid })

    expect(
      sanitizeActorRow(
        didA,
        actorRow({ displayName: '👨‍👩‍👧‍👦'.repeat(64) }),
      ),
    ).not.toHaveProperty('displayName')
  })
})

describe('buildActorSummary', () => {
  it('uses a meaningful Certified profile wholesale while preserving the stored handle', () => {
    const certified = validateCertifiedProfile(profile({ displayName: 'Certified Alice' }))

    expect(buildActorSummary(sanitizeActorRow(didA, actorRow()), certified)).toEqual({
      did: didA,
      handle: 'alice.example',
      displayName: 'Certified Alice',
      profileSource: 'certified',
    })
  })

  it('does not backfill stored display name or avatar for website-only and description-only profiles', () => {
    for (const raw of [
      profile({ website: 'https://example.com' }),
      profile({ description: 'Certified bio' }),
    ]) {
      const certified = validateCertifiedProfile(raw)
      expect(buildActorSummary(sanitizeActorRow(didA, actorRow()), certified)).toEqual({
        did: didA,
        handle: 'alice.example',
        profileSource: 'certified',
      })
    }
  })

  it('falls back to sanitized stored fields for absent, invalid, or content-empty profiles', () => {
    const empty = validateCertifiedProfile(profile())
    const invalidProfiles = [
      validateCertifiedProfile(null),
      validateCertifiedProfile(
        profile({ $type: 'app.bsky.actor.profile', displayName: 'Untrusted' }),
      ),
      validateCertifiedProfile(
        profile({
          displayName: 'Untrusted',
          avatar: {
            $type: 'org.hypercerts.defs#uri',
            uri: 'not a URI',
          },
        }),
      ),
      validateCertifiedProfile(
        profile({
          displayName: 'Untrusted',
          avatar: blobImage({ size: -1 }),
        }),
      ),
    ]
    const expected = {
      did: didA,
      handle: 'alice.example',
      displayName: 'Alice',
      avatar: {
        $type: 'app.certified.feed.beta.defs#blobImage',
        did: didA,
        cid,
      },
      profileSource: 'bluesky',
    }

    expect(buildActorSummary(sanitizeActorRow(didA, actorRow()), undefined)).toEqual(expected)
    for (const invalid of invalidProfiles) {
      expect(buildActorSummary(sanitizeActorRow(didA, actorRow()), invalid)).toEqual(
        expected,
      )
    }
    expect(buildActorSummary(sanitizeActorRow(didA, actorRow()), empty)).toEqual(expected)
  })

  it('uses DID-only fallback when no valid profile fields exist', () => {
    expect(buildActorSummary(sanitizeActorRow(didA, undefined), undefined)).toEqual({
      did: didA,
      profileSource: 'did',
    })
  })

  it('converts Certified URI and blob avatars to descriptors without bytes or invented URLs', () => {
    const uriProfile = validateCertifiedProfile(
      profile({
        avatar: {
          $type: 'org.hypercerts.defs#uri',
          uri: 'https://example.com/avatar.png',
        },
      }),
    )
    const serializedBlobProfile = validateCertifiedProfile(
      JSON.parse(JSON.stringify(profile({ avatar: blobImage() }))),
    )

    expect(buildActorSummary(sanitizeActorRow(didA, actorRow()), uriProfile).avatar).toEqual({
      $type: 'app.certified.feed.beta.defs#uriImage',
      uri: 'https://example.com/avatar.png',
    })
    expect(
      buildActorSummary(
        sanitizeActorRow(didA, actorRow()),
        serializedBlobProfile,
      ).avatar,
    ).toEqual({
      $type: 'app.certified.feed.beta.defs#blobImage',
      did: didA,
      cid,
      mimeType: 'image/png',
      size: 128,
    })
  })
})

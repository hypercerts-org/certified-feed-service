import { graphemeLen, isCidString, utf8Len } from '@atproto/lex'
import { jsonToLex } from '@atproto/lexicon'
import { isValidHandle } from '@atproto/syntax'
import { AppCertifiedActorProfile } from '@hypercerts-org/lexicon'

import type { ActorRow, SanitizedActorRow } from './types.js'

const DISPLAY_NAME_MAX_GRAPHEMES = 64
const DISPLAY_NAME_MAX_BYTES = 640
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
])
const SMALL_IMAGE_MAX_BYTES = 5_242_880
const LARGE_IMAGE_MAX_BYTES = 10_485_760

/** Certified profile shape accepted by the authoritative v1.0.0 validator. */
export type ValidatedCertifiedProfile = AppCertifiedActorProfile.Record

const hasValidKnownBlob = (
  value: unknown,
  type: 'org.hypercerts.defs#smallImage' | 'org.hypercerts.defs#largeImage',
  maxSize: number,
): boolean => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('$type' in value) ||
    value.$type !== type
  ) {
    return true
  }
  if (!('image' in value) || typeof value.image !== 'object' || value.image === null) {
    return false
  }

  const blob = value.image
  if (!('mimeType' in blob) || !('size' in blob)) return false
  return (
    typeof blob.mimeType === 'string' &&
    ALLOWED_IMAGE_MIME_TYPES.has(blob.mimeType) &&
    typeof blob.size === 'number' &&
    Number.isInteger(blob.size) &&
    blob.size >= 0 &&
    blob.size <= maxSize
  )
}

const hasValidKnownProfileBlobs = (
  profile: ValidatedCertifiedProfile,
): boolean =>
  hasValidKnownBlob(
    profile.avatar,
    'org.hypercerts.defs#smallImage',
    SMALL_IMAGE_MAX_BYTES,
  ) &&
  hasValidKnownBlob(
    profile.banner,
    'org.hypercerts.defs#largeImage',
    LARGE_IMAGE_MAX_BYTES,
  )

/** Validates an indexed Certified profile before any field reaches a public summary. */
export const validateCertifiedProfile = (
  value: unknown,
): ValidatedCertifiedProfile | undefined => {
  try {
    // The generated validator requires its own BlobRef class, so the parser and
    // @hypercerts-org/lexicon must resolve the same @atproto/lexicon version.
    const indexedJson = value as Parameters<typeof jsonToLex>[0]
    const result = AppCertifiedActorProfile.validateRecord(jsonToLex(indexedJson))
    if (!result.success || !hasValidKnownProfileBlobs(result.value)) {
      return undefined
    }
    return result.value
  } catch {
    return undefined
  }
}

/** Whether a validated Certified profile contains any user-authored profile content. */
export const isMeaningfulCertifiedProfile = (
  profile: ValidatedCertifiedProfile,
): boolean =>
  Boolean(
    profile.displayName ||
      profile.description ||
      profile.avatar ||
      profile.banner ||
      profile.pronouns ||
      profile.website,
  )

/** Validates each optional stored actor field independently. */
export const sanitizeActorRow = (
  did: string,
  row: ActorRow | undefined,
): SanitizedActorRow => {
  if (!row) return { did }

  const handle =
    row.handle !== null && isValidHandle(row.handle) ? row.handle : undefined
  const displayName =
    row.displayName !== null &&
    graphemeLen(row.displayName) <= DISPLAY_NAME_MAX_GRAPHEMES &&
    utf8Len(row.displayName) <= DISPLAY_NAME_MAX_BYTES
      ? row.displayName
      : undefined
  const avatarCid =
    row.avatarCid !== null && isCidString(row.avatarCid)
      ? row.avatarCid
      : undefined

  return {
    did,
    ...(handle === undefined ? {} : { handle }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(avatarCid === undefined ? {} : { avatarCid }),
  }
}

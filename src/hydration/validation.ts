import { graphemeLen, isCidString, utf8Len } from '@atproto/lex'
import { jsonToLex } from '@atproto/lexicon'
import { isValidHandle } from '@atproto/syntax'
import {
  AppCertifiedActorProfile,
  AppCertifiedBadgeAward,
  OrgHyperboardsBoard,
  OrgHypercertsClaimActivity,
  OrgHypercertsCollection,
  OrgHypercertsContextAttachment,
  OrgHypercertsContextEvaluation,
  OrgHypercertsContextMeasurement,
} from '@hypercerts-org/lexicon'

import type { FeedKind } from '../feed/types.js'
import type { ActorRow, SanitizedActorRow } from './types.js'

const DISPLAY_NAME_MAX_GRAPHEMES = 64
const DISPLAY_NAME_MAX_BYTES = 640
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
])
const ALLOWED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm'])
const SMALL_IMAGE_MAX_BYTES = 5_242_880
const LARGE_IMAGE_MAX_BYTES = 10_485_760
const SMALL_BLOB_MAX_BYTES = 10_485_760
const SMALL_VIDEO_MAX_BYTES = 20_971_520

/** Certified profile shape accepted by the authoritative v1.0.0 validator. */
export type ValidatedCertifiedProfile = AppCertifiedActorProfile.Record

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasValidBlobRef = (
  blob: unknown,
  maxSize: number,
  allowedMimeTypes?: ReadonlySet<string>,
): boolean =>
  isObject(blob) &&
  typeof blob.mimeType === 'string' &&
  (allowedMimeTypes === undefined || allowedMimeTypes.has(blob.mimeType)) &&
  typeof blob.size === 'number' &&
  Number.isInteger(blob.size) &&
  blob.size >= 0 &&
  blob.size <= maxSize

const hasValidKnownBlob = (
  value: unknown,
  type: 'org.hypercerts.defs#smallImage' | 'org.hypercerts.defs#largeImage',
  maxSize: number,
): boolean => {
  if (!isObject(value) || value.$type !== type) return true
  return hasValidBlobRef(value.image, maxSize, ALLOWED_IMAGE_MIME_TYPES)
}

const hasValidKnownSmallBlob = (value: unknown): boolean => {
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallBlob') {
    return true
  }
  return hasValidBlobRef(value.blob, SMALL_BLOB_MAX_BYTES)
}

const hasValidKnownSmallVideo = (value: unknown): boolean => {
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallVideo') {
    return true
  }
  return hasValidBlobRef(
    value.video,
    SMALL_VIDEO_MAX_BYTES,
    ALLOWED_VIDEO_MIME_TYPES,
  )
}

const hasValidKnownHyperboardBlobs = (
  board: OrgHyperboardsBoard.Record,
): boolean =>
  hasValidKnownBlob(
    board.config?.backgroundImage,
    'org.hypercerts.defs#smallImage',
    SMALL_IMAGE_MAX_BYTES,
  ) &&
  (board.contributorConfigs?.every(
    (contributor) =>
      hasValidKnownBlob(
        contributor.image,
        'org.hypercerts.defs#smallImage',
        SMALL_IMAGE_MAX_BYTES,
      ) &&
      hasValidKnownBlob(
        contributor.hoverImage,
        'org.hypercerts.defs#smallImage',
        SMALL_IMAGE_MAX_BYTES,
      ) &&
      hasValidKnownSmallVideo(contributor.video),
  ) ?? true)

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

export type ValidatedFeedRecord =
  | {
      readonly kind: 'cert.create'
      readonly collection: 'org.hypercerts.claim.activity'
      readonly rawValue: unknown
      readonly value: OrgHypercertsClaimActivity.Record
    }
  | {
      readonly kind: 'collection.create' | 'project.created_with_cert'
      readonly collection: 'org.hypercerts.collection'
      readonly rawValue: unknown
      readonly value: OrgHypercertsCollection.Record
    }
  | {
      readonly kind: 'evaluation.create'
      readonly collection: 'org.hypercerts.context.evaluation'
      readonly rawValue: unknown
      readonly value: OrgHypercertsContextEvaluation.Record
    }
  | {
      readonly kind: 'measurement.create'
      readonly collection: 'org.hypercerts.context.measurement'
      readonly rawValue: unknown
      readonly value: OrgHypercertsContextMeasurement.Record
    }
  | {
      readonly kind: 'hyperboard.create'
      readonly collection: 'org.hyperboards.board'
      readonly rawValue: unknown
      readonly value: OrgHyperboardsBoard.Record
    }
  | {
      readonly kind: 'update.create'
      readonly collection: 'org.hypercerts.context.attachment'
      readonly rawValue: unknown
      readonly value: OrgHypercertsContextAttachment.Record
    }
  | {
      readonly kind: 'endorsement.award'
      readonly collection: 'app.certified.badge.award'
      readonly rawValue: unknown
      readonly value: AppCertifiedBadgeAward.Record
    }

const hasRecordType = (value: unknown, type: string): boolean =>
  isObject(value) && value.$type === type

const hasAccountSubject = (value: AppCertifiedBadgeAward.Record): boolean =>
  isObject(value.subject) &&
  value.subject.$type === 'app.certified.defs#did' &&
  typeof value.subject.did === 'string'

/** Validates one raw indexed record using only its trusted collection and skeleton kind. */
export const validateFeedRecord = (
  kind: FeedKind,
  collection: string,
  value: unknown,
): ValidatedFeedRecord | undefined => {
  if (!hasRecordType(value, collection)) return undefined

  try {
    const parsed = jsonToLex(value as Parameters<typeof jsonToLex>[0])
    switch (collection) {
      case 'org.hypercerts.claim.activity': {
        if (kind !== 'cert.create') return undefined
        const result = OrgHypercertsClaimActivity.validateRecord(parsed)
        if (
          !result.success ||
          !hasValidKnownBlob(
            result.value.image,
            'org.hypercerts.defs#smallImage',
            SMALL_IMAGE_MAX_BYTES,
          )
        ) {
          return undefined
        }
        return { kind, collection, rawValue: value, value: result.value }
      }
      case 'org.hypercerts.collection': {
        if (
          kind !== 'collection.create' &&
          kind !== 'project.created_with_cert'
        ) {
          return undefined
        }
        const result = OrgHypercertsCollection.validateRecord(parsed)
        if (
          !result.success ||
          !hasValidKnownBlob(
            result.value.avatar,
            'org.hypercerts.defs#smallImage',
            SMALL_IMAGE_MAX_BYTES,
          ) ||
          !hasValidKnownBlob(
            result.value.banner,
            'org.hypercerts.defs#largeImage',
            LARGE_IMAGE_MAX_BYTES,
          )
        ) {
          return undefined
        }
        return { kind, collection, rawValue: value, value: result.value }
      }
      case 'org.hypercerts.context.evaluation': {
        if (kind !== 'evaluation.create') return undefined
        const result = OrgHypercertsContextEvaluation.validateRecord(parsed)
        if (
          !result.success ||
          (result.value.content !== undefined &&
            !result.value.content.every(hasValidKnownSmallBlob))
        ) {
          return undefined
        }
        return { kind, collection, rawValue: value, value: result.value }
      }
      case 'org.hypercerts.context.measurement': {
        if (kind !== 'measurement.create') return undefined
        const result = OrgHypercertsContextMeasurement.validateRecord(parsed)
        if (!result.success) return undefined
        return { kind, collection, rawValue: value, value: result.value }
      }
      case 'org.hyperboards.board': {
        if (kind !== 'hyperboard.create') return undefined
        const result = OrgHyperboardsBoard.validateRecord(parsed)
        if (!result.success || !hasValidKnownHyperboardBlobs(result.value)) {
          return undefined
        }
        return { kind, collection, rawValue: value, value: result.value }
      }
      case 'org.hypercerts.context.attachment': {
        if (kind !== 'update.create') return undefined
        const result = OrgHypercertsContextAttachment.validateRecord(parsed)
        if (
          !result.success ||
          (result.value.content !== undefined &&
            !result.value.content.every(hasValidKnownSmallBlob))
        ) {
          return undefined
        }
        return { kind, collection, rawValue: value, value: result.value }
      }
      case 'app.certified.badge.award': {
        if (kind !== 'endorsement.award') return undefined
        const result = AppCertifiedBadgeAward.validateRecord(parsed)
        if (!result.success || !hasAccountSubject(result.value)) return undefined
        return { kind, collection, rawValue: value, value: result.value }
      }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/** Returns the account subject for a validated endorsement award. */
export const getEndorsedActorDid = (
  record: ValidatedFeedRecord,
): string | undefined => {
  if (record.kind !== 'endorsement.award') return undefined
  return isObject(record.value.subject) &&
    record.value.subject.$type === 'app.certified.defs#did' &&
    typeof record.value.subject.did === 'string'
    ? record.value.subject.did
    : undefined
}

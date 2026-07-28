import { isValidDid } from '@atproto/syntax'

import { FeedError, FeedErrorCode } from './errors.js'
import {
  FEED_KINDS,
  ORGANIZATION_QUALITIES,
  type FeedKind,
  type GetFeedSkeletonInput,
  type NormalizedFeedRequest,
  type OrganizationQuality,
} from './types.js'

const MAX_EVALUATORS = 64
const MAX_KINDS = 16
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const FEED_KIND_SET = new Set<string>(FEED_KINDS)
const QUALITY_SET = new Set<string>(ORGANIZATION_QUALITIES)

const dedupe = <T>(values: readonly T[] | undefined): T[] => [
  ...new Set(values ?? []),
]

const validateEvaluatorDids = (values: readonly string[]): void => {
  const invalidIndex = values.findIndex((did) => !isValidDid(did))
  if (invalidIndex !== -1) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      `trustedEvaluators[${invalidIndex}] is not a valid DID; replace it with a valid did:plc, did:web, or other syntactically valid DID.`,
    )
  }
}

/** Applies semantic limits and normalizes one public feed request. */
export const normalizeFeedRequest = (
  input: GetFeedSkeletonInput,
): NormalizedFeedRequest => {
  if (!isValidDid(input.viewerDid)) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      'viewerDid is not a valid DID; provide the viewer account as a syntactically valid DID.',
    )
  }

  const trustedEvaluators = dedupe(input.trustedEvaluators)
  validateEvaluatorDids(trustedEvaluators)
  if (trustedEvaluators.length > MAX_EVALUATORS) {
    throw new FeedError(
      FeedErrorCode.TrustedEvaluatorsTooLarge,
      `trustedEvaluators contains ${trustedEvaluators.length} unique DIDs, exceeding the maximum of ${MAX_EVALUATORS}; remove evaluators before retrying.`,
    )
  }

  const rawKinds = dedupe(input.kinds)
  if (rawKinds.length > MAX_KINDS) {
    throw new FeedError(
      FeedErrorCode.InvalidKind,
      `kinds contains ${rawKinds.length} unique values, exceeding the maximum of ${MAX_KINDS}; request at most ${MAX_KINDS} supported kinds.`,
    )
  }
  const unknownKind = rawKinds.find((kind) => !FEED_KIND_SET.has(kind))
  if (unknownKind) {
    throw new FeedError(
      FeedErrorCode.InvalidKind,
      `kinds contains unsupported value ${JSON.stringify(unknownKind)}; use one of: ${FEED_KINDS.join(', ')}.`,
    )
  }

  const rawQuality = input.organizationQuality
  let organizationQuality: NormalizedFeedRequest['organizationQuality']
  if (rawQuality) {
    const allowed = dedupe(rawQuality.allowed)
    const invalidQuality = allowed.find((quality) => !QUALITY_SET.has(quality))
    if (invalidQuality) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `organizationQuality.allowed contains unsupported value ${JSON.stringify(invalidQuality)}; use one of: ${ORGANIZATION_QUALITIES.join(', ')}.`,
      )
    }
    organizationQuality = {
      allowed: allowed as OrganizationQuality[],
      includeUnrated: rawQuality.includeUnrated,
    }
  }

  const limit = input.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      `limit must be an integer from 1 through ${MAX_LIMIT}; change limit to a value in that range.`,
    )
  }

  return {
    viewerDid: input.viewerDid,
    trustedEvaluators,
    ...(organizationQuality ? { organizationQuality } : {}),
    limit,
    kinds: rawKinds as FeedKind[],
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  }
}

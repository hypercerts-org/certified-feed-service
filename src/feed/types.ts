/** Organization quality categories understood by the Certified Orglabeler policy. */
export const ORGANIZATION_QUALITIES = [
  'high-quality',
  'standard',
  'draft',
  'likely-test',
] as const

/** A quality category that a trusted Orglabeler can assign to an organization. */
export type OrganizationQuality = (typeof ORGANIZATION_QUALITIES)[number]

/** Collections that can produce events in the feed skeleton. */
export const FEED_COLLECTIONS = [
  'org.hypercerts.claim.activity',
  'org.hypercerts.collection',
  'org.hypercerts.context.evaluation',
  'org.hypercerts.context.measurement',
  'org.hypercerts.context.attachment',
  'org.hyperboards.board',
  'app.certified.badge.award',
] as const

/** Final feed-event classifications returned by the skeleton endpoint. */
export const FEED_KINDS = [
  'cert.create',
  'collection.create',
  'project.created_with_cert',
  'evaluation.create',
  'measurement.create',
  'hyperboard.create',
  'update.create',
  'endorsement.award',
] as const

/** A supported interpretation of an indexed source record. */
export type FeedKind = (typeof FEED_KINDS)[number]

/** Account-quality rules applied to known organizations before selecting events. */
export interface OrganizationQualityPolicy {
  /** Quality categories that are allowed to remain in the author scope. */
  readonly allowed: readonly OrganizationQuality[]
  /** Whether a known organization without an active trusted label qualifies. */
  readonly includeUnrated: boolean
}

/** Raw request body accepted by app.certified.feed.beta.getFeedSkeleton. */
export interface GetFeedSkeletonInput {
  /** Viewer whose current Certified outbound follows supply the base scope. */
  readonly viewerDid: string
  /** Evaluators whose active endorsement subjects are added to the base scope. */
  readonly trustedEvaluators?: readonly string[]
  /** Optional organization-quality membership policy. */
  readonly organizationQuality?: OrganizationQualityPolicy
  /** Requested page size, defaulting to 20 and capped at 50. */
  readonly limit?: number
  /** Opaque cursor returned by an earlier descending effective-timestamp page. */
  readonly cursor?: string
  /** Final event-kind filter; omitted or empty means every supported kind. */
  readonly kinds?: readonly string[]
}

/** Exact indexed record version that a downstream data plane should hydrate. */
export interface FeedSubject {
  /** AT-URI of the current indexed record. */
  readonly uri: string
  /** CID of the exact record version selected for this page. */
  readonly cid: string
}

/** One classified, ordered event in the feed skeleton. */
export interface FeedSkeletonItem {
  /** Stable event identifier, currently the source record AT-URI. */
  readonly id: string
  /** Interpretation the hydrator and UI should apply to the source record. */
  readonly kind: FeedKind
  /** Strong reference to the exact indexed source record. */
  readonly subject: FeedSubject
  /** DID that owns and published the source record. */
  readonly actorDid: string
  /** Effective timestamp used to order this item. */
  readonly sortAt: string
}

/** Public response body from app.certified.feed.beta.getFeedSkeleton. */
export interface GetFeedSkeletonOutput {
  /** Ordered skeleton records for the current page. */
  readonly items: readonly FeedSkeletonItem[]
  /** Opaque cursor for a possible later page; absent at the known end. */
  readonly cursor?: string
}

/** Fully validated and deduplicated request passed to the SQL adapter. */
export interface NormalizedFeedRequest {
  /** Validated viewer DID whose current Certified follows supply the base scope. */
  readonly viewerDid: string
  /** Deduplicated evaluator DIDs. */
  readonly trustedEvaluators: readonly string[]
  /** Optional validated account-quality policy. */
  readonly organizationQuality?: OrganizationQualityPolicy
  /** Page size in the inclusive range 1..50. */
  readonly limit: number
  /** Deduplicated final event kinds, empty to select every supported kind. */
  readonly kinds: readonly FeedKind[]
  /** Raw cursor supplied by the caller, if any. */
  readonly cursor?: string
}

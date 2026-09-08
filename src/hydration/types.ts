import type { BlobRef } from '@atproto/lex'

import type { FeedKind } from '../feed/types.js'

/** Hyperindex actor fields used to build a feed-card identity summary. */
export interface ActorRow {
  readonly did: string
  readonly handle: string | null
}

/** Current stored identity data for one requested DID. */
export interface ActorContext {
  readonly did: string
  readonly actor?: ActorRow
  readonly certifiedProfile?: unknown
  readonly blueskyProfile?: unknown
}

/** Batch seam for reading current actor, Certified-profile, and Bluesky-profile identity data. */
export interface IdentityReader {
  getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorContext>>
}

/** Protocol-native external image URI. */
export interface UriImageReference {
  readonly $type: 'org.hypercerts.defs#uri'
  readonly uri: string
}

/** Protocol-native Hypercerts small-image wrapper. */
export interface SmallImageReference {
  readonly $type: 'org.hypercerts.defs#smallImage'
  readonly image: BlobRef
}

/** Protocol-native Hypercerts large-image wrapper. */
export interface LargeImageReference {
  readonly $type: 'org.hypercerts.defs#largeImage'
  readonly image: BlobRef
}

/** Protocol-native Hypercerts attachment wrapper containing an image blob. */
export interface SmallBlobImageReference {
  readonly $type: 'org.hypercerts.defs#smallBlob'
  readonly blob: BlobRef
}

export type ActorImageReference = UriImageReference | SmallImageReference
export type CollectionImageReference =
  | ActorImageReference
  | LargeImageReference
export type UpdateImageReference =
  | UriImageReference
  | SmallBlobImageReference

/** Stable actor identity projected into hydrated feed items. */
export interface ActorSummary {
  readonly did: string
  readonly handle?: string
  readonly displayName?: string
  readonly avatar?: ActorImageReference
}

/** Validated fields from one Hyperindex actor row. */
export interface SanitizedActorRow {
  readonly did: string
  readonly handle?: string
}

/** First-render fields for an activity feed card. */
export interface ActivityFeedView {
  readonly $type: 'org.hypercerts.feed.defs#activityView'
  readonly title: string
  readonly shortDescription?: string
  readonly image?: ActorImageReference
  readonly createdAt?: string
  readonly startDate?: string
  readonly endDate?: string
  readonly locationCount: number
}

/** First-render fields shared by collection and project-with-cert cards. */
export interface CollectionFeedView {
  readonly $type: 'org.hypercerts.feed.defs#collectionView'
  readonly collectionType?: string
  readonly title: string
  readonly shortDescription?: string
  readonly image?: CollectionImageReference
  readonly createdAt?: string
  readonly itemCount: number
}

/** First-render fields for an account endorsement card. */
export interface EndorsementFeedView {
  readonly $type: 'org.hypercerts.feed.defs#endorsementView'
  readonly subject: ActorSummary
  readonly createdAt?: string
}

/** Exact record reference used by hydrated content that targets another record. */
export interface FeedTargetReference {
  readonly uri: string
  readonly cid: string
}

/** Lean first-render fields for an evaluation card. */
export interface EvaluationFeedView {
  readonly $type: 'org.hypercerts.feed.defs#evaluationView'
  readonly summary?: string
  readonly createdAt?: string
  readonly target?: FeedTargetReference
}

/** Lean first-render fields for a measurement card. */
export interface MeasurementFeedView {
  readonly $type: 'org.hypercerts.feed.defs#measurementView'
  readonly metric?: string
  readonly createdAt?: string
  readonly target?: FeedTargetReference
}

/** Verb-only first-render fields for a Hyperboard card. */
export interface HyperboardFeedView {
  readonly $type: 'org.hypercerts.feed.defs#hyperboardView'
  readonly createdAt?: string
}

/** First-render fields for an attachment/update card. */
export interface UpdateFeedView {
  readonly $type: 'org.hypercerts.feed.defs#updateView'
  readonly title?: string
  readonly shortDescription?: string
  readonly image?: UpdateImageReference
  readonly createdAt?: string
  readonly target?: FeedTargetReference
}

/** Stable kind-specific card data built from one validated source record. */
export type FeedItemView =
  | ActivityFeedView
  | CollectionFeedView
  | EndorsementFeedView
  | EvaluationFeedView
  | MeasurementFeedView
  | HyperboardFeedView
  | UpdateFeedView

/** Hypercerts feed-specific representation attached to one generic feed item. */
export interface HypercertsFeedView {
  readonly $type: 'org.hypercerts.feed.defs#hypercertsFeedView'
  readonly kind: FeedKind
  readonly actor: ActorSummary
  readonly content: FeedItemView
}

/** Generic hydrated item built from one validated source record. */
export interface HydratedFeedItem {
  readonly subject: string
  readonly view: HypercertsFeedView
}

/** Public response body projected by the hydrated feed service. */
export interface GetHydratedFeedOutput {
  readonly feed: readonly HydratedFeedItem[]
  readonly cursor?: string
}

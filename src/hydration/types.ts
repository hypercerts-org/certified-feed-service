import type { BlobRef } from '@atproto/lex'

import type { FeedKind, FeedSubject } from '../feed/types.js'

/** Stored actor fields used to build a feed-card identity summary. */
export interface ActorRow {
  readonly did: string
  readonly handle: string | null
  readonly displayName: string | null
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

/** Independently validated optional fields from one stored actor row. */
export interface SanitizedActorRow {
  readonly did: string
  readonly handle?: string
  readonly displayName?: string
}

/** First-render fields for an activity feed card. */
export interface ActivityFeedView {
  readonly $type: 'app.certified.feed.beta.defs#activityView'
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
  readonly $type: 'app.certified.feed.beta.defs#collectionView'
  readonly collectionType?: string
  readonly title: string
  readonly shortDescription?: string
  readonly image?: CollectionImageReference
  readonly createdAt?: string
  readonly itemCount: number
}

/** First-render fields for an account endorsement card. */
export interface EndorsementFeedView {
  readonly $type: 'app.certified.feed.beta.defs#endorsementView'
  readonly subject: ActorSummary
  readonly createdAt?: string
}

/** Lean first-render fields for an evaluation card. */
export interface EvaluationFeedView {
  readonly $type: 'app.certified.feed.beta.defs#evaluationView'
  readonly summary?: string
  readonly createdAt?: string
  readonly target?: FeedSubject
}

/** Lean first-render fields for a measurement card. */
export interface MeasurementFeedView {
  readonly $type: 'app.certified.feed.beta.defs#measurementView'
  readonly metric?: string
  readonly createdAt?: string
  readonly target?: FeedSubject
}

/** Verb-only first-render fields for a Hyperboard card. */
export interface HyperboardFeedView {
  readonly $type: 'app.certified.feed.beta.defs#hyperboardView'
  readonly createdAt?: string
}

/** First-render fields for an attachment/update card. */
export interface UpdateFeedView {
  readonly $type: 'app.certified.feed.beta.defs#updateView'
  readonly title?: string
  readonly shortDescription?: string
  readonly image?: UpdateImageReference
  readonly createdAt?: string
  readonly target?: FeedSubject
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

/** View-only hydrated item built from one validated source record. */
export interface HydratedFeedItem {
  readonly id: string
  readonly kind: FeedKind
  readonly subject: FeedSubject
  readonly sortAt: string
  readonly actor: ActorSummary
  readonly view: FeedItemView
}

/** Public response body projected by the hydrated feed service. */
export interface GetHydratedFeedOutput {
  readonly items: readonly HydratedFeedItem[]
  readonly cursor?: string
}

import type { FeedKind, FeedSubject } from '../feed/types.js'

/** Stored actor fields used to build a feed-card identity summary. */
export interface ActorRow {
  readonly did: string
  readonly handle: string | null
  readonly displayName: string | null
  readonly avatarCid: string | null
}

/** Current stored identity data for one requested DID. */
export interface ActorContext {
  readonly did: string
  readonly actor?: ActorRow
  readonly certifiedProfile?: unknown
}

/** Batch seam for reading current actor and Certified-profile identity data. */
export interface IdentityReader {
  getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorContext>>
}

/** Public-safe image metadata; hydration never fetches or proxies blob bytes. */
export type ImageReference =
  | {
      readonly $type: 'app.certified.feed.beta.defs#uriImage'
      readonly uri: string
    }
  | {
      readonly $type: 'app.certified.feed.beta.defs#blobImage'
      readonly did: string
      readonly cid: string
      readonly mimeType?: string
      readonly size?: number
    }

/** Stable actor identity projected into hydrated feed items. */
export interface ActorSummary {
  readonly did: string
  readonly handle?: string
  readonly displayName?: string
  readonly avatar?: ImageReference
}

/** Independently validated optional fields from one stored actor row. */
export interface SanitizedActorRow {
  readonly did: string
  readonly handle?: string
  readonly displayName?: string
  readonly avatarCid?: string
}

/** First-render fields for an activity feed card. */
export interface ActivityFeedView {
  readonly $type: 'app.certified.feed.beta.defs#activityView'
  readonly title: string
  readonly shortDescription?: string
  readonly image?: ImageReference
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
  readonly image?: ImageReference
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
  readonly image?: ImageReference
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

/** Availability of the validated source view for one hydrated item. */
export type RecordState = 'available' | 'invalid'

/** Metadata and event-author identity shared by every hydrated feed item. */
export interface HydratedFeedItemBase {
  readonly id: string
  readonly kind: FeedKind
  readonly subject: FeedSubject
  readonly sortAt: string
  readonly actor: ActorSummary
}

/** View-only hydrated item; valid sources always carry a view. */
export type HydratedFeedItem =
  | (HydratedFeedItemBase & {
      readonly $type: 'app.certified.feed.beta.defs#availableFeedItem'
      readonly recordState: 'available'
      readonly view: FeedItemView
    })
  | (HydratedFeedItemBase & {
      readonly $type: 'app.certified.feed.beta.defs#invalidFeedItem'
      readonly recordState: 'invalid'
      readonly view?: never
    })

/** Public response body projected by the hydrated feed service. */
export interface GetHydratedFeedOutput {
  readonly items: readonly HydratedFeedItem[]
  readonly cursor?: string
}

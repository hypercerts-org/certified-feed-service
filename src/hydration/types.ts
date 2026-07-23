import type { FeedSubject } from '../feed/types.js'

/** Canonical lookup key for one exact AT Protocol strong reference. */
export type StrongRefKey = string

/** Encodes a strong reference without ambiguity because AT-URIs and CIDs cannot contain NUL. */
export const strongRefKey = (subject: FeedSubject): StrongRefKey =>
  `${subject.uri}\u0000${subject.cid}`

/** Current-state lookup result for one requested exact record version. */
export type ExactRecordResult =
  | {
      readonly state: 'available'
      readonly subject: FeedSubject
      readonly collection: string
      readonly did: string
      readonly value: unknown
    }
  | { readonly state: 'notFound'; readonly subject: FeedSubject }
  | { readonly state: 'cidMismatch'; readonly subject: FeedSubject }

/** Batch seam for resolving exact source records selected by a skeleton page. */
export interface ExactRecordReader {
  getByStrongRefs(
    subjects: readonly FeedSubject[],
  ): Promise<ReadonlyMap<StrongRefKey, ExactRecordResult>>
}

/** Stored actor fields used to build a feed-card identity summary. */
export interface ActorRow {
  readonly did: string
  readonly handle: string | null
  readonly displayName: string | null
  readonly avatarCid: string | null
}

/** Batch seam for reading current stored actor summaries. */
export interface ActorReader {
  getByDids(dids: readonly string[]): Promise<ReadonlyMap<string, ActorRow>>
}

/** Raw current Certified profile read from its deterministic self URI. */
export interface IndexedCertifiedProfile {
  readonly did: string
  readonly value: unknown
}

/** Batch seam for reading deterministic current Certified profiles. */
export interface CertifiedProfileReader {
  getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, IndexedCertifiedProfile>>
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
  readonly profileSource: 'certified' | 'bluesky' | 'did'
}

/** Independently validated optional fields from one stored actor row. */
export interface SanitizedActorRow {
  readonly did: string
  readonly handle?: string
  readonly displayName?: string
  readonly avatarCid?: string
}

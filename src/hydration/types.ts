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

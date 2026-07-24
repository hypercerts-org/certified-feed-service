/** Stable public error names returned by the Certified feed XRPC endpoint. */
export type FeedErrorCode =
  | 'InvalidRequest'
  | 'AuthorsFilterTooLarge'
  | 'TrustedEvaluatorsTooLarge'
  | 'FeedScopeTooLarge'
  | 'InvalidKind'
  | 'InvalidCursor'
  | 'InternalError'

/** Expected feed failure that can be safely translated into a public XRPC response. */
export class FeedError extends Error {
  /** Creates a public error with an actionable message and HTTP status. */
  constructor(
    readonly code: FeedErrorCode,
    message: string,
    readonly status = 400,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'FeedError'
  }
}

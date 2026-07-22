/** Stable public error names returned by the Certified feed XRPC endpoint. */
export type FeedErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_VIEWER'
  | 'AUTHORS_FILTER_TOO_LARGE'
  | 'TRUSTED_EVALUATORS_TOO_LARGE'
  | 'FEED_SCOPE_TOO_LARGE'
  | 'INVALID_KIND'
  | 'INVALID_CURSOR'
  | 'INTERNAL_ERROR'

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

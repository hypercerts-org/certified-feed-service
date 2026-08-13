import { LexRouter, LexServerError } from '@atproto/lex-server'
import type { Logger } from 'pino'

import { FeedError, FeedErrorCode } from '../feed/errors.js'
import type { FeedSkeletonReader } from '../feed/service.js'
import type { GetFeedSkeletonInput } from '../feed/types.js'
import getFeedSkeleton, {
  $output,
} from '../lexicons/app/certified/feed/beta/getFeedSkeleton.js'
import type { Metrics } from '../metrics.js'

/** Registers the public generic feed-skeleton procedure on a LexRouter instance. */
export const registerGetFeedSkeleton = (
  router: LexRouter,
  feedService: FeedSkeletonReader,
  metrics: Metrics,
  logger: Logger,
): void => {
  router.add(getFeedSkeleton, async ({ input }) => {
    try {
      const output = await feedService.getFeedSkeleton(
        input.body as GetFeedSkeletonInput,
      )
      return { body: $output.schema.$parse(output) }
    } catch (cause) {
      if (cause instanceof FeedError) {
        metrics.observeError(cause.code)
        throw new LexServerError(
          cause.status,
          { error: cause.code, message: cause.message },
          undefined,
          { cause },
        )
      }

      metrics.observeError(FeedErrorCode.InternalError)
      logger.error({ err: cause }, 'feed skeleton generation failed')
      throw new LexServerError(
        500,
        {
          error: FeedErrorCode.InternalError,
          message:
            'Feed generation failed because of an internal service error; retry the request, then contact the operator if it continues.',
        },
        undefined,
        { cause },
      )
    }
  })
}

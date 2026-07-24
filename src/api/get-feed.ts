import { LexRouter, LexServerError } from '@atproto/lex-server'
import type { Logger } from 'pino'

import { FeedError } from '../feed/errors.js'
import type { GetFeedSkeletonInput } from '../feed/types.js'
import type { HydratedFeedReader } from '../hydration/service.js'
import getFeed, {
  $output,
} from '../lexicons/app/certified/feed/beta/getFeed.js'
import type { Metrics } from '../metrics.js'

/** Registers the public view-only hydrated feed procedure on a LexRouter instance. */
export const registerGetFeed = (
  router: LexRouter,
  feedService: HydratedFeedReader,
  metrics: Metrics,
  logger: Logger,
): void => {
  router.add(getFeed, async ({ input }) => {
    try {
      const output = await feedService.getFeed(
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

      metrics.observeError('INTERNAL_ERROR')
      logger.error({ err: cause }, 'hydrated feed generation failed')
      throw new LexServerError(
        500,
        {
          error: 'INTERNAL_ERROR',
          message:
            'Feed generation failed because of an internal service error; retry the request, then contact the operator if it continues.',
        },
        undefined,
        { cause },
      )
    }
  })
}

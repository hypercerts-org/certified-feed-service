import { LexRouter, LexServerError } from '@atproto/lex-server'
import type { Logger } from 'pino'

import { applyAuthenticatedViewer } from '../auth/input.js'
import type { OptionalServiceAuth, ServiceAuthCredentials } from '../auth/service-auth.js'
import { FeedError, FeedErrorCode } from '../feed/errors.js'
import type { FeedSkeletonReader } from '../feed/service.js'
import type { GetFeedSkeletonInput } from '../feed/types.js'
import getFeedSkeleton, {
  $output,
} from '../lexicons/org/hypercerts/feed/getFeedSkeleton.js'

/** Registers the public generic feed-skeleton procedure on a LexRouter instance. */
export const registerGetFeedSkeleton = (
  router: LexRouter,
  feedService: FeedSkeletonReader,
  logger: Logger,
  auth?: OptionalServiceAuth,
): void => {
  const handler = async (
    input: GetFeedSkeletonInput,
    credentials: ServiceAuthCredentials | undefined,
  ) => {
    try {
      const output = await feedService.getFeedSkeleton(
        applyAuthenticatedViewer(input, credentials),
      )
      return { body: $output.schema.$parse(output) }
    } catch (cause) {
      if (cause instanceof FeedError) {
        throw new LexServerError(
          cause.status,
          { error: cause.code, message: cause.message },
          undefined,
          { cause },
        )
      }

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
  }

  if (auth === undefined) {
    router.add(getFeedSkeleton, async ({ input }) =>
      handler(input.body as GetFeedSkeletonInput, undefined),
    )
  } else {
    router.add(getFeedSkeleton, {
      auth,
      handler: async ({ input, credentials }) =>
        handler(input.body as GetFeedSkeletonInput, credentials),
    })
  }
}

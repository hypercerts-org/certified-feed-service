import { createServer } from '@atproto/lex-server/nodejs'
import pino from 'pino'

import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { Database } from './database.js'
import { createCertifiedFeed } from './feed/query.js'
import { FeedRegistry } from './feed/registry.js'
import { FeedService } from './feed/service.js'
import { loadLocalEnvironment } from './environment.js'
import { PostgresIdentityReader } from './hydration/identity.js'
import { HydratedFeedService } from './hydration/service.js'
import { Metrics } from './metrics.js'

loadLocalEnvironment()
const config = loadConfig()
const logger = pino({ level: config.logLevel })
const metrics = new Metrics()
const database = new Database(config, logger)
const certifiedFeed = createCertifiedFeed(
  { database, metrics },
  config.trustedQualityLabelerDids,
)
const feeds = new FeedRegistry([certifiedFeed])
const feedService = new FeedService(feeds)
const identities = new PostgresIdentityReader(database)
const hydratedFeed = new HydratedFeedService(feeds, identities)
const app = createApp(
  database,
  { skeleton: feedService, hydrated: hydratedFeed },
  metrics,
  logger,
)

metrics.setReady(false)

const server = createServer(app, {
  gracefulTerminationTimeout: config.gracefulShutdownMs,
})
// Node's request timeout bounds receiving the request, not handler or database work.
server.requestTimeout = config.requestTimeoutMs
server.headersTimeout = config.requestTimeoutMs + 1_000
server.keepAliveTimeout = 5_000

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => resolve())
  })
} catch (cause) {
  await database.close()
  throw cause
}
logger.info(
  { host: config.host, port: config.port },
  'Certified feed service is listening',
)

try {
  const compatibility = await database.checkCompatibility()
  metrics.setReady(compatibility.compatible)
  if (!compatibility.compatible) {
    logger.warn(
      { reason: compatibility.reason },
      'database compatibility check failed; service is listening but not ready',
    )
  }
} catch (error) {
  metrics.setReady(false)
  logger.error(
    { err: error },
    'initial database compatibility check failed; service is listening but not ready',
  )
}

let shutdownPromise: Promise<void> | undefined
const shutdown = (signal: NodeJS.Signals): Promise<void> => {
  shutdownPromise ??= (async () => {
    logger.info({ signal }, 'graceful shutdown started')
    let failed = false
    try {
      await server.terminate()
    } catch (error) {
      failed = true
      logger.error({ err: error }, 'HTTP server termination failed')
    }
    try {
      await database.close()
    } catch (error) {
      failed = true
      logger.error({ err: error }, 'database pool shutdown failed')
    }
    if (failed) {
      process.exitCode = 1
      return
    }
    logger.info('graceful shutdown completed')
  })()
  return shutdownPromise
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

import { isValidDid } from '@atproto/syntax'

/** Runtime settings for the standalone feed service and its read-only database pool. */
export interface Config {
  /** TCP interface used by the HTTP server. */
  readonly host: string
  /** TCP port used by the HTTP server. */
  readonly port: number
  /** Postgres connection URL for the indexer's existing database. */
  readonly databaseUrl: string
  /** Maximum number of Postgres sessions held by this sidecar. */
  readonly databaseMaxConnections: number
  /** Time an excess Postgres session may remain idle before the pool closes it. */
  readonly databaseIdleTimeoutMs: number
  /** Maximum time to wait for a database connection. */
  readonly databaseConnectionTimeoutMs: number
  /** Per-statement Postgres timeout. */
  readonly databaseStatementTimeoutMs: number
  /** Maximum time allowed to receive a complete HTTP request. */
  readonly requestTimeoutMs: number
  /** Maximum time graceful shutdown waits for active requests. */
  readonly gracefulShutdownMs: number
  /** Orglabeler DIDs trusted to provide account-quality labels. */
  readonly trustedQualityLabelerDids: readonly string[]
  /** Pino logging threshold. */
  readonly logLevel: string
}

const integerEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}; change ${name} from ${JSON.stringify(raw)} to a value in that range.`,
    )
  }
  return parsed
}

/** Loads and validates process environment values before any listener or pool is started. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required; set it to the dedicated read-only Postgres connection URL for the indexer database.',
    )
  }
  let parsedDatabaseUrl: URL
  try {
    parsedDatabaseUrl = new URL(databaseUrl)
  } catch (cause) {
    throw new Error(
      'DATABASE_URL is not a valid URL; set a postgres:// or postgresql:// connection URL.',
      { cause },
    )
  }
  if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
    throw new Error(
      `DATABASE_URL uses ${parsedDatabaseUrl.protocol}; use a postgres:// or postgresql:// connection URL.`,
    )
  }

  const trustedQualityLabelerDids = [
    ...new Set(
      (env.TRUSTED_QUALITY_LABELER_DIDS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
  const invalidLabeler = trustedQualityLabelerDids.find((did) => !isValidDid(did))
  if (invalidLabeler) {
    throw new Error(
      `TRUSTED_QUALITY_LABELER_DIDS contains invalid DID ${JSON.stringify(invalidLabeler)}; use a comma-separated list of valid DIDs.`,
    )
  }

  return {
    host: env.HOST || '0.0.0.0',
    port: integerEnv(env, 'PORT', 3000, 1, 65_535),
    databaseUrl,
    databaseMaxConnections: integerEnv(
      env,
      'DATABASE_MAX_CONNECTIONS',
      5,
      1,
      20,
    ),
    databaseIdleTimeoutMs: integerEnv(
      env,
      'DATABASE_IDLE_TIMEOUT_MS',
      60_000,
      1_000,
      3_600_000,
    ),
    databaseConnectionTimeoutMs: integerEnv(
      env,
      'DATABASE_CONNECTION_TIMEOUT_MS',
      2_000,
      100,
      60_000,
    ),
    databaseStatementTimeoutMs: integerEnv(
      env,
      'DATABASE_STATEMENT_TIMEOUT_MS',
      5_000,
      100,
      60_000,
    ),
    requestTimeoutMs: integerEnv(
      env,
      'REQUEST_TIMEOUT_MS',
      10_000,
      100,
      120_000,
    ),
    gracefulShutdownMs: integerEnv(
      env,
      'GRACEFUL_SHUTDOWN_MS',
      10_000,
      100,
      120_000,
    ),
    trustedQualityLabelerDids,
    logLevel: env.LOG_LEVEL || 'info',
  }
}

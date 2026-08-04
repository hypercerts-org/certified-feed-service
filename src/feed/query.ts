import { readFileSync } from 'node:fs'

import type { QueryResultRow } from 'pg'

import { FeedError, FeedErrorCode } from './errors.js'
import type {
  InternalFeedRow,
  InternalSourceFeedRow,
  RegisteredFeed,
} from './registry.js'
import {
  defineSqlFeed,
  type FeedRowMapper,
  type SqlFeedRuntime,
} from './sql-feed.js'
import {
  CERTIFIED_FEED_ID,
  CERTIFIED_FEED_PARAMS_TYPE,
  FEED_COLLECTIONS,
  FEED_KINDS,
  type CertifiedFeedParams,
  type FeedKind,
  type OrganizationQuality,
} from './types.js'
import { normalizeFeedRequest } from './validation.js'
import { timestampUriCursor } from './cursor.js'
import { certifiedFeedParams as certifiedFeedParamsSchema } from '../lexicons/app/certified/feed/beta/defs.js'

const CERTIFIED_FEED_QUERY = readFileSync(
  new URL('./feed-query.sql', import.meta.url),
  'utf8',
)
const FEED_KIND_SET = new Set<string>(FEED_KINDS)

interface CertifiedFeedQueryRow extends QueryResultRow {
  readonly uri: string | null
  readonly cid: string | null
  readonly collection: string | null
  readonly actor_did: string | null
  readonly kind: string | null
  readonly sort_value: string | null
  readonly selected_source_uri: string | null
  readonly selected_source_cid: string | null
  readonly selected_source_collection: string | null
  readonly source_json: unknown
}

const metadataInvariantError = (): Error =>
  new Error(
    'Certified feed query metadata invariant failed: a selected row omitted URI, CID, collection, actor DID, kind, or sort value; verify the SQL projection before serving feed requests.',
  )

const sourceInvariantError = (): Error =>
  new Error(
    'Certified feed query source invariant failed: a selected source did not match the exact URI, CID, and collection of its feed row; verify the post-pagination source join before serving hydrated requests.',
  )

const parseCertifiedFeedParams = (
  input: { readonly $type: string },
): CertifiedFeedParams => {
  let parsed: ReturnType<typeof certifiedFeedParamsSchema.schema.$parse>
  try {
    parsed = certifiedFeedParamsSchema.schema.$parse(input)
  } catch (cause) {
    throw new FeedError(
      FeedErrorCode.InvalidRequest,
      `params does not match ${CERTIFIED_FEED_PARAMS_TYPE}; correct the feed parameters and retry.`,
      400,
      { cause },
    )
  }

  return {
    $type: CERTIFIED_FEED_PARAMS_TYPE,
    viewerDid: parsed.viewerDid,
    ...(parsed.trustedEvaluators === undefined
      ? {}
      : { trustedEvaluators: parsed.trustedEvaluators }),
    ...(parsed.organizationQuality === undefined
      ? {}
      : {
          organizationQuality: {
            allowed: parsed.organizationQuality.allowed,
            includeUnrated: parsed.organizationQuality.includeUnrated,
          },
        }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    ...(parsed.kinds === undefined ? {} : { kinds: parsed.kinds }),
  }
}

const mapCertifiedFeedRow: FeedRowMapper<
  CertifiedFeedQueryRow,
  InternalFeedRow
> = (row, mode): InternalFeedRow | InternalSourceFeedRow => {
  if (
    typeof row.uri !== 'string' ||
    typeof row.cid !== 'string' ||
    typeof row.collection !== 'string' ||
    typeof row.actor_did !== 'string' ||
    typeof row.kind !== 'string' ||
    !FEED_KIND_SET.has(row.kind) ||
    typeof row.sort_value !== 'string'
  ) {
    throw metadataInvariantError()
  }

  const metadata: InternalFeedRow = {
    uri: row.uri,
    cid: row.cid,
    collection: row.collection,
    actorDid: row.actor_did,
    kind: row.kind as FeedKind,
    sortValue: row.sort_value,
  }
  if (mode === 'metadata') return metadata

  if (
    row.selected_source_uri !== row.uri ||
    row.selected_source_cid !== row.cid ||
    row.selected_source_collection !== row.collection
  ) {
    throw sourceInvariantError()
  }

  return { ...metadata, sourceValue: row.source_json }
}

/** Builds the current Certified feed definition over one read-only SQL runtime. */
export const createCertifiedFeed = (
  runtime: SqlFeedRuntime,
  trustedQualityLabelerDids: readonly string[],
): RegisteredFeed =>
  defineSqlFeed(runtime, {
    id: CERTIFIED_FEED_ID,
    params: {
      type: CERTIFIED_FEED_PARAMS_TYPE,
      parse: parseCertifiedFeedParams,
      normalize: normalizeFeedRequest,
    },
    sql: CERTIFIED_FEED_QUERY,
    bind: ({ params, cursor, mode, fetchLimit }) => {
      const policy = params.organizationQuality
      return [
        params.viewerDid,
        params.trustedEvaluators,
        policy !== undefined,
        (policy?.allowed ?? []) satisfies readonly OrganizationQuality[],
        policy?.includeUnrated ?? false,
        trustedQualityLabelerDids,
        params.kinds,
        cursor?.value ?? null,
        cursor?.uri ?? null,
        fetchLimit,
        FEED_COLLECTIONS,
        mode === 'with-source',
      ]
    },
    cursor: timestampUriCursor,
    mapRow: mapCertifiedFeedRow,
  })

import type { Database } from '../database.js'
import type { FeedCursor } from './cursor.js'
import { FEED_COLLECTIONS } from './types.js'
import type {
  FeedKind,
  NormalizedFeedRequest,
  OrganizationQuality,
} from './types.js'

/** Maximum resolved author scope permitted before event expansion is suppressed. */
export const MAX_RESOLVED_AUTHOR_COUNT = 500

const FEED_QUERY = `
WITH
base_authors AS (
  SELECT explicit.did
  FROM unnest($2::text[]) AS explicit(did)
  WHERE $3::boolean

  UNION ALL

  SELECT follow.json->>'subject' AS did
  FROM record AS follow
  WHERE NOT $3::boolean
    AND follow.collection = 'app.certified.graph.follow'
    AND follow.did = $1
    AND jsonb_typeof(follow.json->'subject') = 'string'
    AND char_length(follow.json->>'subject') <= 2048
    AND follow.json->>'subject' ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'
),
evaluator_endorsements AS (
  SELECT award.subject_did AS did
  FROM record AS award
  JOIN record AS definition
    ON definition.uri = award.json->'badge'->>'uri'
   AND definition.cid = award.json->'badge'->>'cid'
   AND definition.collection = 'app.certified.badge.definition'
   AND definition.json->>'badgeType' = 'endorsement'
   AND (
     NOT (definition.json ? 'allowedIssuers')
     OR (
       jsonb_typeof(definition.json->'allowedIssuers') = 'array'
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(
           CASE
             WHEN jsonb_typeof(definition.json->'allowedIssuers') = 'array'
               THEN definition.json->'allowedIssuers'
             ELSE '[]'::jsonb
           END
         ) AS issuer(did)
         WHERE issuer.did = award.did
       )
     )
   )
  WHERE award.collection = 'app.certified.badge.award'
    AND award.did = ANY($4::text[])
    AND jsonb_typeof(award.json->'subject') = 'object'
    AND award.json->'subject'->>'$type' = 'app.certified.defs#did'
    AND jsonb_typeof(award.json->'subject'->'did') = 'string'
    AND award.subject_did IS NOT NULL
    AND char_length(award.subject_did) <= 2048
    AND award.subject_did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'
    AND award.did <> award.subject_did
    AND COALESCE(
      (
        SELECT response.json->>'response'
        FROM record AS response
        WHERE response.collection = 'app.certified.badge.response'
          AND response.did = award.subject_did
          AND response.json->'badgeAward'->>'uri' = award.uri
          AND response.json->'badgeAward'->>'cid' = award.cid
          AND response.json->>'response' IS NOT NULL
          AND response.json->>'response' <> ''
        ORDER BY
          response.sort_at DESC NULLS LAST,
          response.indexed_at DESC,
          response.uri DESC
        LIMIT 1
      ),
      ''
    ) <> 'rejected'
),
requested_scope AS (
  SELECT DISTINCT candidate.did
  FROM (
    SELECT did FROM base_authors
    UNION ALL
    SELECT did FROM evaluator_endorsements
  ) AS candidate
  WHERE candidate.did IS NOT NULL
    AND candidate.did <> $1
),
active_scope AS (
  SELECT requested.did
  FROM requested_scope AS requested
  LEFT JOIN actor ON actor.did = requested.did
  WHERE actor.did IS NULL OR actor.is_active <> false
),
active_quality_labels AS (
  SELECT scoped.did, asserted.val
  FROM active_scope AS scoped
  JOIN label AS asserted
    ON asserted.uri = 'at://' || scoped.did || '/app.certified.actor.organization/self'
   AND asserted.src = ANY($8::text[])
   AND asserted.val = ANY(ARRAY['high-quality', 'standard', 'draft', 'likely-test']::text[])
   AND asserted.neg = false
   AND (asserted.exp IS NULL OR asserted.exp > NOW())
   AND NOT EXISTS (
     SELECT 1
     FROM label AS negation
     WHERE negation.uri = asserted.uri
       AND negation.src = asserted.src
       AND negation.val = asserted.val
       AND negation.neg = true
       AND (negation.exp IS NULL OR negation.exp > NOW())
       AND negation.cts >= asserted.cts
   )
),
quality_summary AS (
  SELECT
    quality.did,
    bool_or(quality.val = ANY($6::text[])) AS has_allowed
  FROM active_quality_labels AS quality
  GROUP BY quality.did
),
final_scope AS (
  SELECT scoped.did
  FROM active_scope AS scoped
  LEFT JOIN actor ON actor.did = scoped.did
  LEFT JOIN quality_summary AS quality ON quality.did = scoped.did
  WHERE NOT $5::boolean
     OR COALESCE(actor.is_certified_organization, false) = false
     OR COALESCE(quality.has_allowed, false)
     OR (quality.did IS NULL AND $7::boolean)
),
scope_meta AS (
  SELECT COUNT(*)::integer AS scope_count
  FROM final_scope
),
project_pairs AS (
  SELECT DISTINCT collection_record.uri AS collection_uri, activity.uri AS activity_uri
  FROM final_scope AS scoped
  JOIN scope_meta AS meta ON meta.scope_count <= $13::integer
  JOIN record AS collection_record
    ON collection_record.did = scoped.did
   AND collection_record.collection = 'org.hypercerts.collection'
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(collection_record.json->'items') = 'array'
        THEN collection_record.json->'items'
      ELSE '[]'::jsonb
    END
  ) AS item
  JOIN record AS activity
    ON activity.uri = item->'itemIdentifier'->>'uri'
   AND activity.cid = item->'itemIdentifier'->>'cid'
   AND activity.collection = 'org.hypercerts.claim.activity'
   AND activity.did = collection_record.did
   AND ABS(EXTRACT(EPOCH FROM (activity.sort_at - collection_record.sort_at))) < 60
),
paired_collections AS (
  SELECT DISTINCT collection_uri AS uri FROM project_pairs
),
paired_activities AS (
  SELECT DISTINCT activity_uri AS uri FROM project_pairs
),
eligible_records AS (
  SELECT source.*
  FROM final_scope AS scoped
  JOIN scope_meta AS meta ON meta.scope_count <= $13::integer
  JOIN record AS source ON source.did = scoped.did
  WHERE source.collection = ANY($14::text[])
    AND (
      source.collection <> 'org.hypercerts.claim.activity'
      OR NOT EXISTS (
        SELECT 1 FROM paired_activities WHERE paired_activities.uri = source.uri
      )
    )
    AND (
      source.collection <> 'org.hypercerts.context.attachment'
      OR source.json->>'contentType' = 'update'
    )
    AND (
      source.collection <> 'app.certified.badge.award'
      OR (
        jsonb_typeof(source.json->'subject') = 'object'
        AND source.json->'subject'->>'$type' = 'app.certified.defs#did'
        AND jsonb_typeof(source.json->'subject'->'did') = 'string'
        AND source.subject_did IS NOT NULL
        AND char_length(source.subject_did) <= 2048
        AND source.subject_did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'
        AND source.did <> source.subject_did
        AND EXISTS (
          SELECT 1
          FROM record AS definition
          WHERE definition.uri = source.json->'badge'->>'uri'
            AND definition.cid = source.json->'badge'->>'cid'
            AND definition.collection = 'app.certified.badge.definition'
            AND definition.json->>'badgeType' = 'endorsement'
            AND (
              NOT (definition.json ? 'allowedIssuers')
              OR (
                jsonb_typeof(definition.json->'allowedIssuers') = 'array'
                AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(
                    CASE
                      WHEN jsonb_typeof(definition.json->'allowedIssuers') = 'array'
                        THEN definition.json->'allowedIssuers'
                      ELSE '[]'::jsonb
                    END
                  ) AS issuer(did)
                  WHERE issuer.did = source.did
                )
              )
            )
        )
        AND COALESCE(
          (
            SELECT response.json->>'response'
            FROM record AS response
            WHERE response.collection = 'app.certified.badge.response'
              AND response.did = source.subject_did
              AND response.json->'badgeAward'->>'uri' = source.uri
              AND response.json->'badgeAward'->>'cid' = source.cid
              AND response.json->>'response' IS NOT NULL
              AND response.json->>'response' <> ''
            ORDER BY
              response.sort_at DESC NULLS LAST,
              response.indexed_at DESC,
              response.uri DESC
            LIMIT 1
          ),
          ''
        ) <> 'rejected'
      )
    )
),
classified_events AS (
  SELECT
    source.uri,
    source.cid,
    source.did AS actor_did,
    CASE source.collection
      WHEN 'org.hypercerts.claim.activity' THEN 'cert.create'
      WHEN 'org.hypercerts.collection' THEN
        CASE
          WHEN EXISTS (
            SELECT 1 FROM paired_collections WHERE paired_collections.uri = source.uri
          ) THEN 'project.created_with_cert'
          ELSE 'collection.create'
        END
      WHEN 'org.hypercerts.context.evaluation' THEN 'evaluation.create'
      WHEN 'org.hypercerts.context.measurement' THEN 'measurement.create'
      WHEN 'org.hyperboards.board' THEN 'hyperboard.create'
      WHEN 'org.hypercerts.context.attachment' THEN 'update.create'
      WHEN 'app.certified.badge.award' THEN 'endorsement.award'
    END AS kind,
    CASE
      WHEN jsonb_typeof(source.json->'createdAt') = 'string'
        AND source.json->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
        AND pg_input_is_valid(source.json->>'createdAt', 'timestamp with time zone')
      THEN (source.json->>'createdAt')::timestamptz
      ELSE source.sort_at
    END AS effective_at
  FROM eligible_records AS source
),
filtered_events AS (
  SELECT event.*
  FROM classified_events AS event
  WHERE (cardinality($9::text[]) = 0 OR event.kind = ANY($9::text[]))
    AND (
      $10::timestamptz IS NULL
      OR event.effective_at < $10::timestamptz
      OR (event.effective_at = $10::timestamptz AND event.uri < $11::text)
    )
),
paged_events AS (
  SELECT *
  FROM filtered_events
  ORDER BY effective_at DESC, uri DESC
  LIMIT $12::integer
)
SELECT
  meta.scope_count,
  page.uri,
  page.cid,
  page.actor_did,
  page.kind,
  to_char(
    page.effective_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS sort_value
FROM scope_meta AS meta
LEFT JOIN paged_events AS page ON true
ORDER BY page.effective_at DESC NULLS LAST, page.uri DESC NULLS LAST
`

interface FeedQueryRow {
  scope_count: number
  uri: string | null
  cid: string | null
  actor_did: string | null
  kind: FeedKind | null
  sort_value: string | null
}

/** Parameters consumed by the standalone SQL adapter. */
export interface FeedQueryInput {
  /** Validated and normalized public request. */
  readonly request: NormalizedFeedRequest
  /** Validated keyset cursor, if this is not the first page. */
  readonly cursor?: FeedCursor
  /** Trusted service-configured Orglabeler DIDs. */
  readonly trustedQualityLabelerDids: readonly string[]
}

/** One database result before the service trims the limit+1 sentinel row. */
export interface FeedQueryResult {
  /** Number of accounts remaining after all scope membership rules. */
  readonly scopeCount: number
  /** Fully classified rows in deterministic descending order. */
  readonly rows: readonly {
    readonly uri: string
    readonly cid: string
    readonly actorDid: string
    readonly kind: FeedKind
    readonly sortValue: string
  }[]
}

/** Seam used by FeedService to execute the database-owned feed pipeline. */
export interface FeedQueryReader {
  /** Resolves a feed request into a scope count and limit+1 classified rows. */
  getFeed(input: FeedQueryInput): Promise<FeedQueryResult>
}

/** Read-only adapter that owns the complete current-state feed query. */
export class FeedRepository implements FeedQueryReader {
  /** Creates the adapter over the service's bounded read-only pool. */
  constructor(private readonly database: Database) {}

  /** Resolves scope, classifies records, folds pairs, and fetches limit+1 events in one statement. */
  async getFeed(input: FeedQueryInput): Promise<FeedQueryResult> {
    const { request, cursor, trustedQualityLabelerDids } = input
    const policy = request.organizationQuality
    const result = await this.database.query<FeedQueryRow>(FEED_QUERY, [
      request.viewerDid,
      request.authors,
      request.hasExplicitAuthors,
      request.trustedEvaluators,
      policy !== undefined,
      (policy?.allowed ?? []) satisfies readonly OrganizationQuality[],
      policy?.includeUnrated ?? false,
      trustedQualityLabelerDids,
      request.kinds,
      cursor?.value ?? null,
      cursor?.uri ?? null,
      request.limit + 1,
      MAX_RESOLVED_AUTHOR_COUNT,
      FEED_COLLECTIONS,
    ])

    const first = result.rows[0]
    const scopeCount = first?.scope_count ?? 0
    const rows = result.rows.flatMap((row) => {
      if (
        row.uri === null ||
        row.cid === null ||
        row.actor_did === null ||
        row.kind === null ||
        row.sort_value === null
      ) {
        return []
      }
      return [
        {
          uri: row.uri,
          cid: row.cid,
          actorDid: row.actor_did,
          kind: row.kind,
          sortValue: row.sort_value,
        },
      ]
    })

    return { scopeCount, rows }
  }
}

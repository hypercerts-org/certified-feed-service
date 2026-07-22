WITH
-- =============================================================================
-- Scope resolution
-- Combine explicit/followed authors with valid DID endorsements from trusted
-- evaluators, then apply actor status and organization-quality policy.
-- =============================================================================
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
    -- Bound untrusted values and require the conservative DID shape accepted by
    -- this service before allowing them to expand the feed scope.
    AND char_length(follow.json->>'subject') <= 2048
    AND follow.json->>'subject' ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'
),
-- This rule is shared by evaluator scope expansion and visible award events.
-- NOT MATERIALIZED lets PostgreSQL push each consumer's DID/URI filters into it.
valid_endorsement_awards AS NOT MATERIALIZED (
  SELECT award.*
  FROM record AS award
  JOIN record AS definition
    -- Match the exact definition version referenced by the award.
    ON definition.uri = award.json->'badge'->>'uri'
   AND definition.cid = award.json->'badge'->>'cid'
   AND definition.collection = 'app.certified.badge.definition'
   AND definition.json->>'badgeType' = 'endorsement'
   AND (
     -- Omitting allowedIssuers permits any issuer. When present, it must be an
     -- array containing this issuer; malformed values deliberately match none.
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
    -- Only account-target endorsements affect scope or appear as feed events.
    AND jsonb_typeof(award.json->'subject') = 'object'
    AND award.json->'subject'->>'$type' = 'app.certified.defs#did'
    AND jsonb_typeof(award.json->'subject'->'did') = 'string'
    AND award.subject_did IS NOT NULL
    AND char_length(award.subject_did) <= 2048
    AND award.subject_did ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'
    -- Self-endorsements neither expand scope nor produce feed events.
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
        -- Responses are mutable current state; the latest non-empty response wins.
        ORDER BY
          response.sort_at DESC NULLS LAST,
          response.indexed_at DESC,
          response.uri DESC
        LIMIT 1
      ),
      ''
    ) <> 'rejected'
),
evaluator_endorsements AS (
  SELECT award.subject_did AS did
  FROM valid_endorsement_awards AS award
  WHERE award.did = ANY($4::text[])
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
-- =============================================================================
-- Project pairing
-- A collection and its referenced activity become one project-created event
-- when the records belong to the same actor and their sort times are close.
-- =============================================================================
-- The scope-size gate is intentionally repeated here and in eligible_records:
-- oversized requests still return scope_count but never expand into record scans.
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
-- =============================================================================
-- Record eligibility
-- Select supported records, suppress paired activity duplicates, admit only
-- update attachments, and enforce the shared endorsement policy.
-- =============================================================================
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
      OR EXISTS (
        SELECT 1
        FROM valid_endorsement_awards AS award
        WHERE award.uri = source.uri
          AND award.cid = source.cid
      )
    )
),
-- =============================================================================
-- Event classification and pagination
-- Convert eligible records into public event kinds, derive their stable sort
-- timestamp, apply keyset pagination, and return one limit-plus-one page.
-- =============================================================================
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
    -- Prefer a valid record-authored timestamp; fall back to the indexer's
    -- sort_at value when createdAt is absent or malformed.
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
      -- URI is the deterministic tie-breaker for equal timestamps.
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

WITH
-- =============================================================================
-- Scope resolution
-- Combine explicit/followed authors with valid DID endorsements from trusted
-- evaluators, then apply Hyperindex organization-quality policy.
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
  SELECT
    award.*,
    award.json->'subject'->>'did' AS endorsement_subject_did
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
    AND char_length(award.json->'subject'->>'did') <= 2048
    AND award.json->'subject'->>'did' ~ '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'
    -- Self-endorsements neither expand scope nor produce feed events.
    AND award.did <> award.json->'subject'->>'did'
    AND COALESCE(
      (
        SELECT response.json->>'response'
        FROM record AS response
        WHERE response.collection = 'app.certified.badge.response'
          AND response.did = award.json->'subject'->>'did'
          AND response.json->'badgeAward'->>'uri' = award.uri
          AND response.json->'badgeAward'->>'cid' = award.cid
          AND response.json->>'response' IS NOT NULL
          AND response.json->>'response' <> ''
        -- Responses are mutable current state; the latest non-empty response wins.
        ORDER BY
          COALESCE(response.record_created_at, response.indexed_at) DESC,
          response.indexed_at DESC,
          response.uri DESC
        LIMIT 1
      ),
      ''
    ) <> 'rejected'
),
evaluator_endorsements AS (
  SELECT award.endorsement_subject_did AS did
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
-- Hyperindex stores external label timestamps as text. Every cast remains inside
-- a CASE guard so malformed rows are ignored instead of failing the feed query.
parsed_quality_labels AS MATERIALIZED (
  SELECT
    scoped.did,
    label.src,
    label.uri,
    label.val,
    label.neg,
    label.exp,
    CASE
      WHEN pg_input_is_valid(label.cts, 'timestamp with time zone')
        THEN label.cts::timestamptz
      ELSE NULL
    END AS cts_at,
    CASE
      WHEN label.exp IS NULL THEN NULL
      WHEN pg_input_is_valid(label.exp, 'timestamp with time zone')
        THEN label.exp::timestamptz
      ELSE NULL
    END AS exp_at,
    pg_input_is_valid(label.cts, 'timestamp with time zone')
      AND (
        label.exp IS NULL
        OR pg_input_is_valid(label.exp, 'timestamp with time zone')
      ) AS timestamps_valid
  FROM requested_scope AS scoped
  JOIN external_label AS label
    ON label.uri = scoped.did
   AND label.cid IS NULL
   AND label.src = ANY($8::text[])
   AND label.val = ANY(ARRAY['high-quality', 'standard', 'draft', 'likely-test']::text[])
),
active_quality_labels AS (
  SELECT asserted.did, asserted.val
  FROM parsed_quality_labels AS asserted
  WHERE asserted.timestamps_valid
    AND asserted.neg = false
    AND (asserted.exp IS NULL OR asserted.exp_at > NOW())
    AND NOT EXISTS (
      SELECT 1
      FROM parsed_quality_labels AS negation
      WHERE negation.uri = asserted.uri
        AND negation.src = asserted.src
        AND negation.val = asserted.val
        AND negation.timestamps_valid
        AND negation.neg = true
        AND (negation.exp IS NULL OR negation.exp_at > NOW())
        AND negation.cts_at >= asserted.cts_at
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
  FROM requested_scope AS scoped
  LEFT JOIN quality_summary AS quality ON quality.did = scoped.did
  WHERE NOT $5::boolean
     OR NOT EXISTS (
       SELECT 1
       FROM record AS organization
       WHERE organization.uri =
         'at://' || scoped.did || '/app.certified.actor.organization/self'
         AND organization.collection = 'app.certified.actor.organization'
     )
     OR COALESCE(quality.has_allowed, false)
     OR (quality.did IS NULL AND $7::boolean)
),
scope_meta AS (
  SELECT COUNT(*)::integer AS scope_count
  FROM final_scope
),
-- Materializing the bounded scope prevents oversized requests from probing
-- project or eligible-event records while preserving the exact scope count.
bounded_scope AS MATERIALIZED (
  SELECT scoped.did
  FROM final_scope AS scoped
  CROSS JOIN scope_meta AS meta
  WHERE meta.scope_count <= $13::integer
),
-- =============================================================================
-- Project pairing
-- A collection and its referenced activity become one project-created event
-- when the records belong to the same actor and effective times are close.
-- =============================================================================
project_pairs AS (
  SELECT DISTINCT collection_record.uri AS collection_uri, activity.uri AS activity_uri
  FROM bounded_scope AS scoped
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
   AND ABS(EXTRACT(EPOCH FROM (
     COALESCE(activity.record_created_at, activity.indexed_at)
       - COALESCE(
         collection_record.record_created_at,
         collection_record.indexed_at
       )
   ))) < 60
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
  FROM bounded_scope AS scoped
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
-- Convert eligible records into public event kinds, apply keyset pagination,
-- and return one limit-plus-one page.
-- =============================================================================
classified_events AS (
  SELECT
    source.uri,
    source.cid,
    source.collection,
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
    COALESCE(source.record_created_at, source.indexed_at) AS effective_at
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
  page.collection,
  page.actor_did,
  page.kind,
  to_char(
    page.effective_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS sort_value,
  selected_source.uri AS selected_source_uri,
  selected_source.cid AS selected_source_cid,
  selected_source.collection AS selected_source_collection,
  selected_source.json AS source_json
FROM scope_meta AS meta
LEFT JOIN paged_events AS page ON true
LEFT JOIN record AS selected_source
  ON $15::boolean
 AND selected_source.uri = page.uri
 AND selected_source.cid = page.cid
ORDER BY page.effective_at DESC NULLS LAST, page.uri DESC NULLS LAST

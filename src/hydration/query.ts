import type { QueryResultRow } from 'pg'

import type { FeedSubject } from '../feed/types.js'
import {
  strongRefKey,
  type ExactRecordReader,
  type ExactRecordResult,
  type StrongRefKey,
} from './types.js'

const EXACT_RECORD_QUERY = `
  WITH requested(uri, cid) AS (
    SELECT DISTINCT uri, cid
    FROM unnest($1::text[], $2::text[]) AS input(uri, cid)
  )
  SELECT
    requested.uri AS requested_uri,
    requested.cid AS requested_cid,
    source.cid AS current_cid,
    source.did,
    source.collection,
    CASE
      WHEN source.cid = requested.cid THEN source.json
      ELSE NULL
    END AS source_json
  FROM requested
  LEFT JOIN record AS source
    ON source.uri = requested.uri
`

interface ExactRecordRow extends QueryResultRow {
  requested_uri: string
  requested_cid: string
  current_cid: string | null
  did: string | null
  collection: string | null
  source_json: unknown
}

/** Narrow structural query capability used by the exact-record adapter. */
export interface ExactRecordQueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>
}

/** Read-only PostgreSQL adapter for exact current record versions. */
export class PostgresExactRecordReader implements ExactRecordReader {
  constructor(private readonly database: ExactRecordQueryExecutor) {}

  async getByStrongRefs(
    subjects: readonly FeedSubject[],
  ): Promise<ReadonlyMap<StrongRefKey, ExactRecordResult>> {
    const uniqueSubjects = new Map<StrongRefKey, FeedSubject>()
    for (const subject of subjects) {
      const key = strongRefKey(subject)
      if (!uniqueSubjects.has(key)) uniqueSubjects.set(key, subject)
    }
    if (uniqueSubjects.size === 0) return new Map()

    const requested = [...uniqueSubjects.values()]
    const result = await this.database.query<ExactRecordRow>(
      EXACT_RECORD_QUERY,
      [
        requested.map((subject) => subject.uri),
        requested.map((subject) => subject.cid),
      ],
    )

    const records = new Map<StrongRefKey, ExactRecordResult>()
    for (const row of result.rows) {
      const rowSubject = {
        uri: row.requested_uri,
        cid: row.requested_cid,
      }
      const key = strongRefKey(rowSubject)
      const subject = uniqueSubjects.get(key)
      if (!subject) {
        throw new Error(
          'Exact-record query returned an unrequested strong reference; verify the hydration query result columns and bind order.',
        )
      }

      if (row.current_cid === null) {
        records.set(key, { state: 'notFound', subject })
        continue
      }
      if (row.current_cid !== subject.cid) {
        records.set(key, { state: 'cidMismatch', subject })
        continue
      }
      if (row.did === null || row.collection === null) {
        throw new Error(
          'Exact-record query returned incomplete metadata for an available record; verify the record table contract before serving hydration requests.',
        )
      }
      records.set(key, {
        state: 'available',
        subject,
        collection: row.collection,
        did: row.did,
        value: row.source_json,
      })
    }

    if (records.size !== uniqueSubjects.size) {
      throw new Error(
        'Exact-record query omitted requested strong references; verify the hydration query keeps the requested left join intact.',
      )
    }
    return records
  }
}

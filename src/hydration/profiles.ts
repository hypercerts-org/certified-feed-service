import type { QueryResultRow } from 'pg'

import type {
  CertifiedProfileReader,
  IndexedCertifiedProfile,
} from './types.js'

const CERTIFIED_PROFILE_QUERY = `
  WITH requested(did) AS (
    SELECT DISTINCT did
    FROM unnest($1::text[]) AS input(did)
  )
  SELECT
    requested.did,
    source.json AS source_json
  FROM requested
  JOIN record AS source
    ON source.uri = 'at://' || requested.did || '/app.certified.actor.profile/self'
   AND source.collection = 'app.certified.actor.profile'
`

interface CertifiedProfileQueryRow extends QueryResultRow {
  did: string
  source_json: unknown
}

/** Narrow structural query capability used by the Certified-profile adapter. */
export interface CertifiedProfileQueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>
}

/** Read-only PostgreSQL adapter for deterministic current Certified profiles. */
export class PostgresCertifiedProfileReader implements CertifiedProfileReader {
  constructor(private readonly database: CertifiedProfileQueryExecutor) {}

  async getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, IndexedCertifiedProfile>> {
    const uniqueDids = [...new Set(dids)]
    if (uniqueDids.length === 0) return new Map()

    const result = await this.database.query<CertifiedProfileQueryRow>(
      CERTIFIED_PROFILE_QUERY,
      [uniqueDids],
    )
    const profiles = new Map<string, IndexedCertifiedProfile>()
    for (const row of result.rows) {
      profiles.set(row.did, { did: row.did, value: row.source_json })
    }
    return profiles
  }
}

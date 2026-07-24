import type { QueryResultRow } from 'pg'

import type { ActorContext, IdentityReader } from './types.js'

const IDENTITY_QUERY = `
  WITH requested(did) AS (
    SELECT DISTINCT did
    FROM unnest($1::text[]) AS input(did)
  )
  SELECT
    requested.did AS requested_did,
    actor.did AS actor_did,
    actor.handle,
    actor.display_name,
    actor.avatar_cid,
    profile.json AS certified_profile_json
  FROM requested
  LEFT JOIN actor
    ON actor.did = requested.did
  LEFT JOIN record AS profile
    ON profile.uri = 'at://' || requested.did || '/app.certified.actor.profile/self'
   AND profile.collection = 'app.certified.actor.profile'
`

interface IdentityQueryRow extends QueryResultRow {
  requested_did: string
  actor_did: string | null
  handle: string | null
  display_name: string | null
  avatar_cid: string | null
  certified_profile_json: unknown
}

/** Narrow structural query capability used by the identity adapter. */
export interface IdentityQueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>
}

/** Read-only PostgreSQL adapter for current actor and Certified-profile identity data. */
export class PostgresIdentityReader implements IdentityReader {
  constructor(private readonly database: IdentityQueryExecutor) {}

  async getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorContext>> {
    const uniqueDids = [...new Set(dids)]
    if (uniqueDids.length === 0) return new Map()

    const contexts = new Map<string, ActorContext>(
      uniqueDids.map((did) => [did, { did }]),
    )
    const result = await this.database.query<IdentityQueryRow>(IDENTITY_QUERY, [
      uniqueDids,
    ])
    const seenDids = new Set<string>()

    for (const row of result.rows) {
      if (!contexts.has(row.requested_did)) {
        throw new Error(
          'Identity query returned an unrequested DID; verify the requested-DID projection and bind order before serving hydrated pages.',
        )
      }
      if (seenDids.has(row.requested_did)) {
        throw new Error(
          'Identity query returned duplicate result rows for the same requested DID; verify the identity joins preserve one row per DID before serving hydrated pages.',
        )
      }
      seenDids.add(row.requested_did)
      if (row.actor_did !== null && row.actor_did !== row.requested_did) {
        throw new Error(
          'Identity query returned actor data for a different DID; verify the actor join before serving hydrated pages.',
        )
      }

      contexts.set(row.requested_did, {
        did: row.requested_did,
        ...(row.actor_did === null
          ? {}
          : {
              actor: {
                did: row.actor_did,
                handle: row.handle,
                displayName: row.display_name,
                avatarCid: row.avatar_cid,
              },
            }),
        ...(row.certified_profile_json === null
          ? {}
          : { certifiedProfile: row.certified_profile_json }),
      })
    }

    return contexts
  }
}

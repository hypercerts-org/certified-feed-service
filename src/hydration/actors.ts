import type { QueryResultRow } from 'pg'

import type { ActorReader, ActorRow } from './types.js'

const ACTOR_QUERY = `
  SELECT
    actor.did,
    actor.handle,
    actor.display_name,
    actor.avatar_cid
  FROM actor
  WHERE actor.did = ANY($1::text[])
`

interface ActorQueryRow extends QueryResultRow {
  did: string
  handle: string | null
  display_name: string | null
  avatar_cid: string | null
}

/** Narrow structural query capability used by the actor adapter. */
export interface ActorQueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>
}

/** Read-only PostgreSQL adapter for stored actor summary fields. */
export class PostgresActorReader implements ActorReader {
  constructor(private readonly database: ActorQueryExecutor) {}

  async getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorRow>> {
    const uniqueDids = [...new Set(dids)]
    if (uniqueDids.length === 0) return new Map()

    const result = await this.database.query<ActorQueryRow>(ACTOR_QUERY, [
      uniqueDids,
    ])
    const actors = new Map<string, ActorRow>()
    for (const row of result.rows) {
      actors.set(row.did, {
        did: row.did,
        handle: row.handle,
        displayName: row.display_name,
        avatarCid: row.avatar_cid,
      })
    }
    return actors
  }
}

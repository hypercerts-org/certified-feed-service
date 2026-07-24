import type { FeedPageLoader } from '../feed/page-loader.js'
import type { GetFeedSkeletonInput } from '../feed/types.js'
import type {
  ActorContext,
  ActorSummary,
  GetHydratedFeedOutput,
  HydratedFeedItem,
  IdentityReader,
} from './types.js'
import {
  getEndorsedActorDid,
  sanitizeActorRow,
  validateCertifiedProfile,
  validateFeedRecord,
  type ValidatedFeedRecord,
} from './validation.js'
import { buildActorSummary, buildFeedItemView } from './views.js'

const identityInvariantError = (): Error =>
  new Error(
    'Hydrated feed identity invariant failed: the identity batch omitted or mismatched a context for a requested DID; verify IdentityReader returns one exact context per requested DID before serving hydrated pages.',
  )

const requireActorSummary = (
  did: string,
  contexts: ReadonlyMap<string, ActorContext>,
): ActorSummary => {
  const context = contexts.get(did)
  if (
    context === undefined ||
    context.did !== did ||
    (context.actor !== undefined && context.actor.did !== did)
  ) {
    throw identityInvariantError()
  }

  return buildActorSummary(
    sanitizeActorRow(did, context.actor),
    validateCertifiedProfile(context.certifiedProfile),
  )
}

/** Application seam consumed by the hydrated XRPC transport. */
export interface HydratedFeedReader {
  getFeed(input: GetFeedSkeletonInput): Promise<GetHydratedFeedOutput>
}

/** Coordinates one same-statement source page and one bounded identity batch. */
export class HydratedFeedService implements HydratedFeedReader {
  constructor(
    private readonly pages: FeedPageLoader,
    private readonly identities: IdentityReader,
  ) {}

  /** Builds one ordered, view-only hydrated feed page. */
  async getFeed(
    input: GetFeedSkeletonInput,
  ): Promise<GetHydratedFeedOutput> {
    const page = await this.pages.loadPage(input, 'with-source')
    if (page.rows.length === 0) {
      return {
        items: [],
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      }
    }

    const records: (ValidatedFeedRecord | undefined)[] = []
    const requestedDids = new Set<string>()
    for (const row of page.rows) {
      requestedDids.add(row.actorDid)
      const record = validateFeedRecord(
        row.kind,
        row.collection,
        row.sourceValue,
      )
      records.push(record)
      if (record !== undefined) {
        const endorsedDid = getEndorsedActorDid(record)
        if (endorsedDid !== undefined) requestedDids.add(endorsedDid)
      }
    }

    const contexts = await this.identities.getByDids([...requestedDids])
    const summaries = new Map<string, ActorSummary>()
    for (const did of requestedDids) {
      summaries.set(did, requireActorSummary(did, contexts))
    }

    const items: HydratedFeedItem[] = page.rows.map((row, index) => {
      const actor = summaries.get(row.actorDid)
      if (actor === undefined || actor.did !== row.actorDid) {
        throw identityInvariantError()
      }
      const base = {
        id: row.uri,
        kind: row.kind,
        subject: { uri: row.uri, cid: row.cid },
        sortAt: row.sortValue,
        actor,
      }
      const record = records[index]
      if (record === undefined) {
        return { ...base, recordState: 'invalid' }
      }

      const endorsedDid = getEndorsedActorDid(record)
      const endorsedActor =
        endorsedDid === undefined ? undefined : summaries.get(endorsedDid)
      return {
        ...base,
        recordState: 'available',
        view: buildFeedItemView(record, {
          sourceDid: row.actorDid,
          ...(endorsedActor === undefined ? {} : { endorsedActor }),
        }),
      }
    })

    return {
      items,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    }
  }
}

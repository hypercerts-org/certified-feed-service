import type {
  FeedPageLoader,
  InternalSourceFeedRow,
} from '../feed/page-loader.js'
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
  validateBlueskyProfile,
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
    validateBlueskyProfile(context.blueskyProfile),
  )
}

interface ValidatedFeedRow {
  readonly row: InternalSourceFeedRow
  readonly record: ValidatedFeedRecord
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
    const validatedRows: ValidatedFeedRow[] = []
    const requestedDids = new Set<string>()
    for (const row of page.rows) {
      const record = validateFeedRecord(
        row.kind,
        row.collection,
        row.sourceValue,
      )
      if (record === undefined) continue

      validatedRows.push({ row, record })
      requestedDids.add(row.actorDid)
      const endorsedDid = getEndorsedActorDid(record)
      if (endorsedDid !== undefined) requestedDids.add(endorsedDid)
    }

    if (validatedRows.length === 0) {
      return {
        items: [],
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      }
    }

    const contexts = await this.identities.getByDids([...requestedDids])
    const summaries = new Map<string, ActorSummary>()
    for (const did of requestedDids) {
      summaries.set(did, requireActorSummary(did, contexts))
    }

    const items: HydratedFeedItem[] = validatedRows.map(({ row, record }) => {
      const actor = summaries.get(row.actorDid)
      if (actor === undefined || actor.did !== row.actorDid) {
        throw identityInvariantError()
      }
      const endorsedDid = getEndorsedActorDid(record)
      const endorsedActor =
        endorsedDid === undefined ? undefined : summaries.get(endorsedDid)
      return {
        id: row.uri,
        kind: row.kind,
        subject: { uri: row.uri, cid: row.cid },
        feedTimestamp: row.sortValue,
        actor,
        view: buildFeedItemView(record, {
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

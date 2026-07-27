import type { FeedSubject } from '../feed/types.js'
import type {
  ActorSummary,
  FeedItemView,
  ImageReference,
  SanitizedActorRow,
} from './types.js'
import {
  getEndorsedActorDid,
  isMeaningfulCertifiedProfile,
  type ValidatedCertifiedProfile,
  type ValidatedFeedRecord,
} from './validation.js'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const blobImageReference = (
  did: string,
  blob: unknown,
): ImageReference | undefined => {
  if (!isObject(blob) || !('ref' in blob)) return undefined
  const mimeType =
    typeof blob.mimeType === 'string' ? blob.mimeType : undefined
  const size = typeof blob.size === 'number' ? blob.size : undefined
  return {
    $type: 'app.certified.feed.beta.defs#blobImage',
    did,
    cid: String(blob.ref),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(size === undefined ? {} : { size }),
  }
}

const imageReference = (
  did: string,
  value: unknown,
  blobType: 'org.hypercerts.defs#smallImage' | 'org.hypercerts.defs#largeImage',
): ImageReference | undefined => {
  if (!isObject(value)) return undefined
  if (value.$type === 'org.hypercerts.defs#uri' && typeof value.uri === 'string') {
    return {
      $type: 'org.hypercerts.defs#uri',
      uri: value.uri,
    }
  }
  if (value.$type !== blobType) return undefined
  return blobImageReference(did, value.image)
}

const certifiedAvatar = (
  did: string,
  avatar: ValidatedCertifiedProfile['avatar'],
): ImageReference | undefined =>
  imageReference(did, avatar, 'org.hypercerts.defs#smallImage')

/** Applies Certified-profile precedence and builds a public-safe actor summary. */
export const buildActorSummary = (
  actor: SanitizedActorRow,
  profile: ValidatedCertifiedProfile | undefined,
): ActorSummary => {
  if (profile && isMeaningfulCertifiedProfile(profile)) {
    const avatar = certifiedAvatar(actor.did, profile.avatar)
    return {
      did: actor.did,
      ...(actor.handle === undefined ? {} : { handle: actor.handle }),
      ...(profile.displayName === undefined
        ? {}
        : { displayName: profile.displayName }),
      ...(avatar === undefined ? {} : { avatar }),
    }
  }

  const avatar =
    actor.avatarCid === undefined
      ? undefined
      : {
          $type: 'app.certified.feed.beta.defs#blobImage' as const,
          did: actor.did,
          cid: actor.avatarCid,
        }
  return {
    did: actor.did,
    ...(actor.handle === undefined ? {} : { handle: actor.handle }),
    ...(actor.displayName === undefined
      ? {}
      : { displayName: actor.displayName }),
    ...(avatar === undefined ? {} : { avatar }),
  }
}

export interface FeedViewContext {
  readonly sourceDid: string
  readonly endorsedActor?: ActorSummary
}

const targetReference = (
  target: { readonly uri: string; readonly cid: string } | undefined,
): FeedSubject | undefined =>
  target === undefined ? undefined : { uri: target.uri, cid: target.cid }

const endorsementViewInvariantError = (): Error =>
  new Error(
    'Endorsement view invariant failed: the validated account subject did not have its exact discovered subject summary; verify endorsement DID discovery and identity mapping before serving hydrated pages.',
  )

/** Builds one stable feed-card view without performing hydration or other I/O. */
export const buildFeedItemView = (
  record: ValidatedFeedRecord,
  context: FeedViewContext,
): FeedItemView => {
  switch (record.kind) {
    case 'cert.create': {
      const value = record.value
      const image = imageReference(
        context.sourceDid,
        value.image,
        'org.hypercerts.defs#smallImage',
      )
      return {
        $type: 'app.certified.feed.beta.defs#activityView',
        title: value.title,
        shortDescription: value.shortDescription,
        ...(image === undefined ? {} : { image }),
        createdAt: value.createdAt,
        ...(value.startDate === undefined ? {} : { startDate: value.startDate }),
        ...(value.endDate === undefined ? {} : { endDate: value.endDate }),
        locationCount: value.locations?.length ?? 0,
      }
    }
    case 'collection.create':
    case 'project.created_with_cert': {
      const value = record.value
      const image =
        imageReference(
          context.sourceDid,
          value.avatar,
          'org.hypercerts.defs#smallImage',
        ) ??
        imageReference(
          context.sourceDid,
          value.banner,
          'org.hypercerts.defs#largeImage',
        )
      return {
        $type: 'app.certified.feed.beta.defs#collectionView',
        ...(value.type === undefined ? {} : { collectionType: value.type }),
        title: value.title,
        ...(value.shortDescription === undefined
          ? {}
          : { shortDescription: value.shortDescription }),
        ...(image === undefined ? {} : { image }),
        createdAt: value.createdAt,
        itemCount: value.items?.length ?? 0,
      }
    }
    case 'endorsement.award': {
      const subjectDid = getEndorsedActorDid(record)
      if (
        subjectDid === undefined ||
        context.endorsedActor === undefined ||
        context.endorsedActor.did !== subjectDid
      ) {
        throw endorsementViewInvariantError()
      }
      return {
        $type: 'app.certified.feed.beta.defs#endorsementView',
        subject: context.endorsedActor,
        createdAt: record.value.createdAt,
      }
    }
    case 'evaluation.create': {
      const target = targetReference(record.value.subject)
      return {
        $type: 'app.certified.feed.beta.defs#evaluationView',
        summary: record.value.summary,
        createdAt: record.value.createdAt,
        ...(target === undefined ? {} : { target }),
      }
    }
    case 'measurement.create': {
      const target = targetReference(record.value.subjects?.[0])
      return {
        $type: 'app.certified.feed.beta.defs#measurementView',
        metric: record.value.metric,
        createdAt: record.value.createdAt,
        ...(target === undefined ? {} : { target }),
      }
    }
    case 'hyperboard.create':
      return {
        $type: 'app.certified.feed.beta.defs#hyperboardView',
        createdAt: record.value.createdAt,
      }
    case 'update.create': {
      const imageBlob = record.value.content?.find(
        (entry) =>
          isObject(entry) &&
          entry.$type === 'org.hypercerts.defs#smallBlob' &&
          isObject(entry.blob) &&
          typeof entry.blob.mimeType === 'string' &&
          entry.blob.mimeType.startsWith('image/'),
      )
      const image =
        isObject(imageBlob) && imageBlob.$type === 'org.hypercerts.defs#smallBlob'
          ? blobImageReference(context.sourceDid, imageBlob.blob)
          : undefined
      const target = targetReference(record.value.subjects?.[0])
      return {
        $type: 'app.certified.feed.beta.defs#updateView',
        title: record.value.title,
        ...(record.value.shortDescription === undefined
          ? {}
          : { shortDescription: record.value.shortDescription }),
        ...(image === undefined ? {} : { image }),
        createdAt: record.value.createdAt,
        ...(target === undefined ? {} : { target }),
      }
    }
  }
}

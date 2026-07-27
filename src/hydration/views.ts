import type { FeedSubject } from '../feed/types.js'
import type {
  ActorImageReference,
  ActorSummary,
  CollectionImageReference,
  FeedItemView,
  LargeImageReference,
  SanitizedActorRow,
  SmallBlobImageReference,
  UriImageReference,
} from './types.js'
import {
  getEndorsedActorDid,
  isMeaningfulCertifiedProfile,
  toProtocolBlobRef,
  type ValidatedBlueskyProfile,
  type ValidatedCertifiedProfile,
  type ValidatedFeedRecord,
} from './validation.js'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const uriImageReference = (value: unknown): UriImageReference | undefined =>
  isObject(value) &&
  value.$type === 'org.hypercerts.defs#uri' &&
  typeof value.uri === 'string'
    ? { $type: 'org.hypercerts.defs#uri', uri: value.uri }
    : undefined

const smallImageReference = (
  value: unknown,
): ActorImageReference | undefined => {
  const uri = uriImageReference(value)
  if (uri !== undefined) return uri
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallImage') {
    return undefined
  }
  const image = toProtocolBlobRef(value.image)
  return image === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#smallImage', image }
}

const largeImageReference = (
  value: unknown,
): UriImageReference | LargeImageReference | undefined => {
  const uri = uriImageReference(value)
  if (uri !== undefined) return uri
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#largeImage') {
    return undefined
  }
  const image = toProtocolBlobRef(value.image)
  return image === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#largeImage', image }
}

const smallBlobImageReference = (
  value: unknown,
): SmallBlobImageReference | undefined => {
  if (!isObject(value) || value.$type !== 'org.hypercerts.defs#smallBlob') {
    return undefined
  }
  const blob = toProtocolBlobRef(value.blob)
  return blob === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#smallBlob', blob }
}

const blueskyAvatar = (
  profile: ValidatedBlueskyProfile,
): ActorImageReference | undefined =>
  profile.avatar === undefined
    ? undefined
    : { $type: 'org.hypercerts.defs#smallImage', image: profile.avatar }

/** Applies Certified, Bluesky, and stored identity precedence. */
export const buildActorSummary = (
  actor: SanitizedActorRow,
  certifiedProfile: ValidatedCertifiedProfile | undefined,
  blueskyProfile: ValidatedBlueskyProfile | undefined,
): ActorSummary => {
  if (
    certifiedProfile &&
    isMeaningfulCertifiedProfile(certifiedProfile)
  ) {
    const avatar = smallImageReference(certifiedProfile.avatar)
    return {
      did: actor.did,
      ...(actor.handle === undefined ? {} : { handle: actor.handle }),
      ...(certifiedProfile.displayName === undefined
        ? {}
        : { displayName: certifiedProfile.displayName }),
      ...(avatar === undefined ? {} : { avatar }),
    }
  }

  if (blueskyProfile !== undefined) {
    const avatar = blueskyAvatar(blueskyProfile)
    return {
      did: actor.did,
      ...(actor.handle === undefined ? {} : { handle: actor.handle }),
      ...(blueskyProfile.displayName === undefined
        ? {}
        : { displayName: blueskyProfile.displayName }),
      ...(avatar === undefined ? {} : { avatar }),
    }
  }

  return {
    did: actor.did,
    ...(actor.handle === undefined ? {} : { handle: actor.handle }),
    ...(actor.displayName === undefined
      ? {}
      : { displayName: actor.displayName }),
  }
}

export interface FeedViewContext {
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
  context: FeedViewContext = {},
): FeedItemView => {
  switch (record.kind) {
    case 'cert.create': {
      const value = record.value
      const image = smallImageReference(value.image)
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
      const image: CollectionImageReference | undefined =
        smallImageReference(value.avatar) ?? largeImageReference(value.banner)
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
      const image = smallBlobImageReference(imageBlob)
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

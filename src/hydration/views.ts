import type { FeedSubject } from '../feed/types.js'
import type {
  ActivityFeedView,
  ActorImageReference,
  ActorSummary,
  CollectionFeedView,
  CollectionImageReference,
  EndorsementFeedView,
  EvaluationFeedView,
  FeedItemView,
  HyperboardFeedView,
  LargeImageReference,
  MeasurementFeedView,
  SanitizedActorRow,
  SmallBlobImageReference,
  UpdateFeedView,
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

type FeedRecordValue<
  Collection extends ValidatedFeedRecord['collection'],
> = Extract<
  ValidatedFeedRecord,
  { readonly collection: Collection }
>['value']

type EndorsementRecord = Extract<
  ValidatedFeedRecord,
  { readonly collection: 'app.certified.badge.award' }
>

const buildActivityView = (
  value: FeedRecordValue<'org.hypercerts.claim.activity'>,
): ActivityFeedView => {
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

const buildCollectionView = (
  value: FeedRecordValue<'org.hypercerts.collection'>,
): CollectionFeedView => {
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

const buildEndorsementView = (
  record: EndorsementRecord,
  context: FeedViewContext,
): EndorsementFeedView => {
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

const buildEvaluationView = (
  value: FeedRecordValue<'org.hypercerts.context.evaluation'>,
): EvaluationFeedView => {
  const target = targetReference(value.subject)
  return {
    $type: 'app.certified.feed.beta.defs#evaluationView',
    summary: value.summary,
    createdAt: value.createdAt,
    ...(target === undefined ? {} : { target }),
  }
}

const buildMeasurementView = (
  value: FeedRecordValue<'org.hypercerts.context.measurement'>,
): MeasurementFeedView => {
  const target = targetReference(value.subjects?.[0])
  return {
    $type: 'app.certified.feed.beta.defs#measurementView',
    metric: value.metric,
    createdAt: value.createdAt,
    ...(target === undefined ? {} : { target }),
  }
}

const buildHyperboardView = (
  value: FeedRecordValue<'org.hyperboards.board'>,
): HyperboardFeedView => ({
  $type: 'app.certified.feed.beta.defs#hyperboardView',
  createdAt: value.createdAt,
})

const buildUpdateView = (
  value: FeedRecordValue<'org.hypercerts.context.attachment'>,
): UpdateFeedView => {
  const imageBlob = value.content?.find(
    (entry) =>
      isObject(entry) &&
      entry.$type === 'org.hypercerts.defs#smallBlob' &&
      isObject(entry.blob) &&
      typeof entry.blob.mimeType === 'string' &&
      entry.blob.mimeType.startsWith('image/'),
  )
  const image = smallBlobImageReference(imageBlob)
  const target = targetReference(value.subjects?.[0])
  return {
    $type: 'app.certified.feed.beta.defs#updateView',
    title: value.title,
    ...(value.shortDescription === undefined
      ? {}
      : { shortDescription: value.shortDescription }),
    ...(image === undefined ? {} : { image }),
    createdAt: value.createdAt,
    ...(target === undefined ? {} : { target }),
  }
}

/** Builds one stable feed-card view without performing hydration or other I/O. */
export const buildFeedItemView = (
  record: ValidatedFeedRecord,
  context: FeedViewContext = {},
): FeedItemView => {
  switch (record.kind) {
    case 'cert.create':
      return buildActivityView(record.value)
    case 'collection.create':
    case 'project.created_with_cert':
      return buildCollectionView(record.value)
    case 'endorsement.award':
      return buildEndorsementView(record, context)
    case 'evaluation.create':
      return buildEvaluationView(record.value)
    case 'measurement.create':
      return buildMeasurementView(record.value)
    case 'hyperboard.create':
      return buildHyperboardView(record.value)
    case 'update.create':
      return buildUpdateView(record.value)
  }
}

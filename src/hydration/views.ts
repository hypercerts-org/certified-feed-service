import type {
  ActorSummary,
  ImageReference,
  SanitizedActorRow,
} from './types.js'
import {
  isMeaningfulCertifiedProfile,
  type ValidatedCertifiedProfile,
} from './validation.js'

const certifiedAvatar = (
  did: string,
  avatar: ValidatedCertifiedProfile['avatar'],
): ImageReference | undefined => {
  if (!avatar) return undefined
  if (
    avatar.$type === 'org.hypercerts.defs#uri' &&
    'uri' in avatar &&
    typeof avatar.uri === 'string'
  ) {
    return {
      $type: 'app.certified.feed.beta.defs#uriImage',
      uri: avatar.uri,
    }
  }
  if (
    avatar.$type !== 'org.hypercerts.defs#smallImage' ||
    !('image' in avatar) ||
    typeof avatar.image !== 'object' ||
    avatar.image === null ||
    !('ref' in avatar.image)
  ) {
    return undefined
  }

  const cid = String(avatar.image.ref)
  const mimeType =
    'mimeType' in avatar.image && typeof avatar.image.mimeType === 'string'
      ? avatar.image.mimeType
      : undefined
  const size =
    'size' in avatar.image && typeof avatar.image.size === 'number'
      ? avatar.image.size
      : undefined
  return {
    $type: 'app.certified.feed.beta.defs#blobImage',
    did,
    cid,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(size === undefined ? {} : { size }),
  }
}

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
      profileSource: 'certified',
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
  const hasStoredProfile =
    actor.handle !== undefined ||
    actor.displayName !== undefined ||
    avatar !== undefined
  return {
    did: actor.did,
    ...(actor.handle === undefined ? {} : { handle: actor.handle }),
    ...(actor.displayName === undefined
      ? {}
      : { displayName: actor.displayName }),
    ...(avatar === undefined ? {} : { avatar }),
    profileSource: hasStoredProfile ? 'bluesky' : 'did',
  }
}

import {
  LexServerAuthError,
  serviceAuth,
  type LexRouterAuth,
  type ServiceAuthCredentials,
  type ServiceAuthOptions,
} from '@atproto/lex-server'
import { createDidResolver } from '@atproto-labs/did-resolver'
import { safeFetchWrap } from '@atproto-labs/fetch-node'
import type { DidString } from '@atproto/syntax'

import type { Config } from '../config.js'

export type OptionalServiceAuth = LexRouterAuth<
  ServiceAuthCredentials | undefined
>

type OptionalServiceAuthOptions = Omit<ServiceAuthOptions, 'unique'>
const authChallenge = {
  Bearer: { error: 'BadJwtLexiconMethod' },
} as const

/**
 * Makes AT Protocol service authentication optional without treating malformed
 * credentials as anonymous requests. The built-in verifier handles signature,
 * audience, expiry, DID resolution, and key rotation.
 */
export const createOptionalServiceAuth = (
  options: OptionalServiceAuthOptions,
): OptionalServiceAuth => {
  // The upstream callback checks a non-canonical nonce before signature
  // verification. This public, read-only service deliberately keeps no replay
  // state; authenticated and anonymous callers can request the same feed data.
  const verify = serviceAuth({ ...options, unique: async () => true })

  return async (context) => {
    if (context.request.headers.get('authorization') === null) {
      return undefined
    }

    const credentials = await verify(context)
    if (credentials.jwt.payload.lxm !== context.method.nsid) {
      throw new LexServerAuthError(
        'AuthenticationRequired',
        'JWT lexicon method is missing or does not match this endpoint; request a token with the exact endpoint NSID in lxm.',
        authChallenge,
      )
    }
    return credentials
  }
}

/** Builds the production auth verifier and its bounded DID resolver. */
export const createConfiguredServiceAuth = (
  config: Pick<
    Config,
    'serviceDid' | 'serviceAuthMaxAgeSeconds' | 'didResolutionTimeoutMs'
  >,
): OptionalServiceAuth => {
  const didResolver = createDidResolver({
    allowHttp: false,
    fetch: safeFetchWrap({
      responseMaxSize: 128 * 1024,
      ssrfProtection: true,
      allowHttp: false,
      allowCustomPort: false,
      allowIpHost: false,
      allowPrivateIps: false,
      timeout: config.didResolutionTimeoutMs,
      allowImplicitRedirect: false,
    }),
  })

  // lex-server currently rejects Proposal 0014 did#serviceId audiences.
  // Keep the bare-DID audience until upstream can accept both forms explicitly.
  return createOptionalServiceAuth({
    audience: config.serviceDid as DidString,
    maxAge: config.serviceAuthMaxAgeSeconds,
    didResolver,
  })
}

export type { ServiceAuthCredentials }

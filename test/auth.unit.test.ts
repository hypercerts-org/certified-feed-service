import { P256Keypair, bytesToMultibase } from '@atproto/crypto'
import { LexServerAuthError } from '@atproto/lex-server'
import type { DidResolver } from '@atproto-labs/did-resolver'
import { describe, expect, it } from 'vitest'

import { createOptionalServiceAuth } from '../src/auth/service-auth.js'

const issuerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const serviceDid = 'did:web:feed.example'
const skeletonNsid = 'org.hypercerts.feed.getFeedSkeleton'
const hydratedNsid = 'org.hypercerts.feed.getFeed'

const now = (): number => Math.floor(Date.now() / 1_000)

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

const signedJwt = async (
  keypair: P256Keypair,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const payload = {
    iss: issuerDid,
    aud: serviceDid,
    iat: now(),
    exp: now() + 60,
    lxm: skeletonNsid,
    ...overrides,
  }
  const message = `${encode({ alg: keypair.jwtAlg, typ: 'JWT' })}.${encode(payload)}`
  const signature = await keypair.sign(new TextEncoder().encode(message))
  return `${message}.${Buffer.from(signature).toString('base64url')}`
}

const resolverFor = (keypair: P256Keypair): DidResolver<any> => ({
  resolve: async () => ({
    id: issuerDid,
    verificationMethod: [
      {
        id: `${issuerDid}#atproto`,
        type: 'EcdsaSecp256r1VerificationKey2019',
        controller: issuerDid,
        publicKeyMultibase: bytesToMultibase(
          keypair.publicKeyBytes(),
          'base58btc',
        ),
      },
    ],
  }),
}) as unknown as DidResolver<any>

const authRequest = (authorization: string | undefined): Request =>
  new Request('http://localhost/xrpc/test', {
    headers: authorization === undefined ? {} : { authorization },
  })

const authContext = (
  authorization: string | undefined,
  nsid = skeletonNsid,
) => ({
  request: authRequest(authorization),
  method: { nsid } as any,
  params: {},
})

describe('optional AT Protocol service authentication', () => {
  it('returns anonymous credentials only when Authorization is absent', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })

    await expect(auth(authContext(undefined))).resolves.toBeUndefined()
  })

  it('verifies a signed #atproto JWT and binds it to the endpoint', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await signedJwt(keypair)

    await expect(
      auth(authContext(`Bearer ${token}`)),
    ).resolves.toMatchObject({ did: issuerDid })
  })

  it.each([
    ['wrong signature', async () => signedJwt(await P256Keypair.create())],
    ['expired token', async (keypair: P256Keypair) => signedJwt(keypair, { exp: now() - 1 })],
    ['not-yet-valid token', async (keypair: P256Keypair) => signedJwt(keypair, { nbf: now() + 60 })],
    ['wrong audience', async (keypair: P256Keypair) => signedJwt(keypair, { aud: 'did:web:other.example' })],
    ['missing lxm', async (keypair: P256Keypair) => signedJwt(keypair, { lxm: undefined })],
    ['wrong lxm', async (keypair: P256Keypair) => signedJwt(keypair, { lxm: hydratedNsid })],
  ])('rejects %s without anonymous fallback', async (label, makeToken) => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })
    const token = await makeToken(keypair)

    await expect(auth(authContext(`Bearer ${token}`))).rejects.toBeInstanceOf(
      LexServerAuthError,
    )
  })

  it('rejects a present malformed Authorization header', async () => {
    const keypair = await P256Keypair.create()
    const auth = createOptionalServiceAuth({
      audience: serviceDid,
      didResolver: resolverFor(keypair),
    })

    await expect(auth(authContext('Basic credentials'))).rejects.toBeInstanceOf(
      LexServerAuthError,
    )
  })
})

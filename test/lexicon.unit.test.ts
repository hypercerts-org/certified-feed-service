import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import {
  $input,
  $output,
} from '../src/lexicons/app/certified/feed/beta/getFeedSkeleton.js'

const readLexicon = (relativePath: string): Record<string, any> =>
  JSON.parse(
    readFileSync(new URL(`../lexicons/${relativePath}`, import.meta.url), 'utf8'),
  ) as Record<string, any>

const skeletonLexicon = readLexicon(
  'app/certified/feed/beta/getFeedSkeleton.json',
)
const defsLexicon = readLexicon('app/certified/feed/beta/defs.json')

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

describe('feed skeleton Lexicon contract', () => {
  it('uses the shared organization-quality policy and UpperCamelCase errors', () => {
    const main = skeletonLexicon.defs.main

    expect(main.input.schema.properties.organizationQuality).toEqual({
      type: 'ref',
      ref: 'app.certified.feed.beta.defs#organizationQualityPolicy',
    })
    expect(main.input.schema.properties).not.toHaveProperty('authors')
    expect(defsLexicon.defs).toHaveProperty('organizationQualityPolicy')
    expect(skeletonLexicon.defs).not.toHaveProperty(
      'organizationQualityPolicy',
    )
    const errorNames = main.errors.map(
      (error: { name: string }) => error.name,
    )
    expect(errorNames).toEqual([
      'InvalidRequest',
      'TrustedEvaluatorsTooLarge',
      'InvalidKind',
      'InvalidCursor',
      'InternalError',
    ])
    expect(errorNames).toEqual(Object.values(FeedErrorCode))
  })

  it('accepts the shared request object without an object discriminator', () => {
    expect(() =>
      $input.schema.$parse({
        viewerDid,
        organizationQuality: {
          allowed: ['high-quality'],
          includeUnrated: false,
        },
      }),
    ).not.toThrow()
  })

  it('keeps the existing exact-reference skeleton output wire shape', () => {
    expect(() =>
      $output.schema.$parse({
        items: [
          {
            id: uri,
            kind: 'cert.create',
            subject: { uri, cid },
            actorDid,
            sortAt: '2026-07-21T10:00:00.000Z',
          },
        ],
      }),
    ).not.toThrow()
  })
})

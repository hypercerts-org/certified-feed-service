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

const feedId = 'app.certified.feed.beta.defs#certifiedFeed'
const paramsType = 'app.certified.feed.beta.defs#certifiedFeedParams'
const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

describe('feed skeleton Lexicon contract', () => {
  it('uses a feed identifier and open params union to select a feed contract', () => {
    const main = skeletonLexicon.defs.main

    expect(main.input.schema.required).toEqual(['feedId', 'params'])
    expect(main.input.schema.properties.feedId).toEqual({
      type: 'string',
      maxLength: 512,
      knownValues: [feedId],
      description: 'Identifier of the feed algorithm to execute.',
    })
    expect(main.input.schema.properties.params).toEqual({
      type: 'union',
      closed: false,
      refs: [paramsType],
      description: 'Parameters for the selected feed algorithm.',
    })
    expect(defsLexicon.defs.certifiedFeed).toMatchObject({ type: 'token' })
    expect(
      defsLexicon.defs.certifiedFeedParams.properties.organizationQuality,
    ).toEqual({
      type: 'ref',
      ref: 'app.certified.feed.beta.defs#organizationQualityPolicy',
    })
    expect(defsLexicon.defs.certifiedFeedParams.properties).not.toHaveProperty(
      'authors',
    )
    expect(skeletonLexicon.defs).not.toHaveProperty('certifiedFeedParams')
    const errorNames = main.errors.map(
      (error: { name: string }) => error.name,
    )
    expect(errorNames).toEqual([
      'InvalidRequest',
      'UnsupportedFeed',
      'TrustedEvaluatorsTooLarge',
      'InvalidKind',
      'InvalidCursor',
      'InternalError',
    ])
    expect(errorNames).toEqual(Object.values(FeedErrorCode))
  })

  it('accepts the registered feed params with their union discriminator', () => {
    expect(() =>
      $input.schema.$parse({
        feedId,
        params: {
          $type: paramsType,
          viewerDid,
          organizationQuality: {
            allowed: ['high-quality'],
            includeUnrated: false,
          },
        },
      }),
    ).not.toThrow()
  })

  it('keeps the params union open for future feed contracts', () => {
    expect(() =>
      $input.schema.$parse({
        feedId: 'app.certified.feed.beta.defs#futureFeed',
        params: {
          $type: 'app.certified.feed.beta.defs#futureFeedParams',
          topic: 'regeneration',
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
            feedTimestamp: '2026-07-21T10:00:00.000Z',
          },
        ],
      }),
    ).not.toThrow()
  })
})

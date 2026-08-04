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

describe('feed skeleton Lexicon contract', () => {
  it('uses a feed identifier and open params union to select a feed contract', () => {
    const main = skeletonLexicon.defs.main

    expect(main.input.schema.required).toEqual(['feedId'])
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
      description:
        'Algorithm-specific parameters. Omit when the selected feed accepts none.',
    })
    expect(main.input.schema.properties.limit).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description:
        'Maximum number of feed subjects to return. The selected feed determines the default and may enforce a lower maximum.',
    })
    expect(main.input.schema.properties.cursor).toEqual({
      type: 'string',
      maxLength: 4096,
      description: 'Opaque cursor returned by a previous request for this feed.',
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
    expect(defsLexicon.defs.certifiedFeedParams.properties).not.toHaveProperty(
      'limit',
    )
    expect(defsLexicon.defs.certifiedFeedParams.properties).not.toHaveProperty(
      'cursor',
    )
    expect(skeletonLexicon.defs).not.toHaveProperty('certifiedFeedParams')
    const errorNames = main.errors.map(
      (error: { name: string }) => error.name,
    )
    expect(errorNames).toEqual([
      'InvalidRequest',
      'UnsupportedFeed',
      'InvalidCursor',
      'InternalError',
    ])
    expect(errorNames).toEqual(Object.values(FeedErrorCode))
  })

  it('accepts the registered feed params with generic pagination', () => {
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
        limit: 25,
        cursor: 'next-page',
      }),
    ).not.toThrow()
  })

  it('accepts a feed request without algorithm-specific params', () => {
    expect(() =>
      $input.schema.$parse({ feedId }),
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

  it('accepts a generic URI-only feed skeleton output', () => {
    expect(() =>
      $output.schema.$parse({
        feed: [{ subject: uri }],
      }),
    ).not.toThrow()
  })
})

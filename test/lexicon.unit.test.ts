import { readFileSync } from 'node:fs'

import { jsonToLex } from '@atproto/lex'
import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import { $output as hydratedOutput } from '../src/lexicons/app/certified/feed/beta/getFeed.js'
import {
  $input as skeletonInput,
  $output as skeletonOutput,
} from '../src/lexicons/app/certified/feed/beta/getFeedSkeleton.js'

const readLexicon = (relativePath: string): Record<string, any> =>
  JSON.parse(
    readFileSync(new URL(`../lexicons/${relativePath}`, import.meta.url), 'utf8'),
  ) as Record<string, any>

const skeletonLexicon = readLexicon(
  'app/certified/feed/beta/getFeedSkeleton.json',
)
const hydratedLexicon = readLexicon('app/certified/feed/beta/getFeed.json')
const defsLexicon = readLexicon('app/certified/feed/beta/defs.json')

const skeletonMain = skeletonLexicon.defs.main
const hydratedMain = hydratedLexicon.defs.main
const defs = defsLexicon.defs

const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`
const targetUri = `at://${viewerDid}/org.hypercerts.claim.activity/target`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const blobCid = 'bafkreiehxpuhtr5f6v4eu4byjo2j7kkrhjvd7psmfu4imnpdzb3bdqb7vy'
const createdAt = '2026-07-21T10:00:00.000Z'

const uriImage = {
  $type: 'org.hypercerts.defs#uri',
  uri: 'https://example.com/image.png',
}
const blob = jsonToLex(
  {
    $type: 'blob',
    ref: { $link: blobCid },
    mimeType: 'image/png',
    size: 128,
  },
  { strict: true },
)
const blobWith = (
  overrides: Record<string, unknown>,
): Record<string, unknown> => ({
  ...(blob as Record<string, unknown>),
  ...overrides,
})
const smallImage = {
  $type: 'org.hypercerts.defs#smallImage',
  image: blob,
}
const largeImage = {
  $type: 'org.hypercerts.defs#largeImage',
  image: blob,
}
const smallBlob = {
  $type: 'org.hypercerts.defs#smallBlob',
  blob,
}
const actor = {
  did: actorDid,
  handle: 'actor.example',
  displayName: 'Actor',
  avatar: smallImage,
}
const target = { uri: targetUri, cid }

const viewsByKind = {
  'cert.create': {
    $type: 'app.certified.feed.beta.defs#activityView',
    title: 'Restore the watershed',
    image: uriImage,
    createdAt,
    locationCount: 2,
  },
  'collection.create': {
    $type: 'app.certified.feed.beta.defs#collectionView',
    title: 'Watershed projects',
    image: largeImage,
    createdAt,
    itemCount: 3,
  },
  'project.created_with_cert': {
    $type: 'app.certified.feed.beta.defs#collectionView',
    title: 'Watershed project',
    createdAt,
    itemCount: 1,
  },
  'endorsement.award': {
    $type: 'app.certified.feed.beta.defs#endorsementView',
    subject: { did: viewerDid },
    createdAt,
  },
  'evaluation.create': {
    $type: 'app.certified.feed.beta.defs#evaluationView',
    summary: 'Strong evidence',
    createdAt,
    target,
  },
  'measurement.create': {
    $type: 'app.certified.feed.beta.defs#measurementView',
    metric: 'hectares restored',
    createdAt,
    target,
  },
  'hyperboard.create': {
    $type: 'app.certified.feed.beta.defs#hyperboardView',
    createdAt,
  },
  'update.create': {
    $type: 'app.certified.feed.beta.defs#updateView',
    title: 'Field report',
    image: smallBlob,
    createdAt,
    target,
  },
} as const

const feedItem = (
  kind: keyof typeof viewsByKind = 'cert.create',
): Record<string, unknown> => ({
  id: uri,
  kind,
  subject: { uri, cid },
  sortAt: createdAt,
  actor,
  view: viewsByKind[kind],
})

describe('feed Lexicon contract', () => {
  it('keeps shared input fields and UpperCamelCase public errors identical', () => {
    expect(hydratedMain.input).toEqual(skeletonMain.input)
    expect(hydratedMain.input.schema.properties).not.toHaveProperty('authors')
    expect(
      hydratedMain.input.schema.properties.organizationQuality.ref,
    ).toBe('app.certified.feed.beta.defs#organizationQualityPolicy')
    expect(hydratedMain.errors).toEqual(skeletonMain.errors)
    const errorNames = hydratedMain.errors.map(
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

  it('keeps the original exact-reference skeleton wire shape', () => {
    expect(skeletonMain.output.schema.required).toEqual(['items'])
    expect(skeletonMain.output.schema.properties.cursor).toMatchObject({
      type: 'string',
      maxLength: 4096,
    })
    expect(skeletonLexicon.defs.feedSkeletonItem.required).toEqual([
      'id',
      'kind',
      'subject',
      'actorDid',
      'sortAt',
    ])
    expect(Object.keys(skeletonLexicon.defs.feedSkeletonItem.properties)).toEqual([
      'id',
      'kind',
      'subject',
      'actorDid',
      'sortAt',
    ])
    expect(defs).toHaveProperty('organizationQualityPolicy')
    expect(skeletonLexicon.defs).not.toHaveProperty(
      'organizationQualityPolicy',
    )
    expect(defs).not.toHaveProperty('feedSkeletonItem')

    expect(() =>
      skeletonInput.schema.$parse({
        viewerDid,
        organizationQuality: {
          allowed: ['high-quality'],
          includeUnrated: false,
        },
      }),
    ).not.toThrow()
    expect(() =>
      skeletonOutput.schema.$parse({
        items: [
          {
            id: uri,
            kind: 'cert.create',
            subject: { uri, cid },
            actorDid,
            sortAt: createdAt,
          },
        ],
      }),
    ).not.toThrow()
  })

  it('keeps every union in the public feed Lexicons open', () => {
    for (const lexicon of [skeletonLexicon, hydratedLexicon, defsLexicon]) {
      expect(JSON.stringify(lexicon)).not.toContain('"closed":true')
    }
  })

  it('defines one hydrated feed item with a required open view', () => {
    expect(hydratedMain.output.schema.properties.items.items).toEqual({
      type: 'ref',
      ref: 'app.certified.feed.beta.defs#feedItem',
    })
    expect(defs.feedItem.required).toEqual([
      'id',
      'kind',
      'subject',
      'sortAt',
      'actor',
      'view',
    ])
    expect(defs.feedItem.properties.view).not.toHaveProperty('closed')
    expect(defs.feedItem.properties.view.refs).toEqual([
      '#activityView',
      '#collectionView',
      '#endorsementView',
      '#evaluationView',
      '#measurementView',
      '#hyperboardView',
      '#updateView',
    ])
    expect(defs).not.toHaveProperty('availableFeedItem')
    expect(defs).not.toHaveProperty('invalidFeedItem')
    expect(defs).not.toHaveProperty('hydratedFeedItem')

    const serialized = JSON.stringify(defs.feedItem)
    for (const forbidden of [
      'record',
      'recordState',
      'profileSource',
      'actorDid',
      'notFound',
      'cidMismatch',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
  })

  it('uses protocol-native Hypercerts variants through open image unions', () => {
    expect(defs).not.toHaveProperty('uriImage')
    expect(defs).not.toHaveProperty('blobImage')
    expect(defs.actorSummary.properties.avatar).toEqual({
      type: 'union',
      refs: [
        'org.hypercerts.defs#uri',
        'org.hypercerts.defs#smallImage',
      ],
    })
    expect(defs.activityView.properties.image).toEqual(
      defs.actorSummary.properties.avatar,
    )
    expect(defs.collectionView.properties.image).toEqual({
      type: 'union',
      refs: [
        'org.hypercerts.defs#uri',
        'org.hypercerts.defs#smallImage',
        'org.hypercerts.defs#largeImage',
      ],
    })
    expect(defs.updateView.properties.image).toEqual({
      type: 'union',
      refs: [
        'org.hypercerts.defs#uri',
        'org.hypercerts.defs#smallBlob',
      ],
    })
  })

  it('uses strong-reference targets only on evaluation, measurement, and update views', () => {
    for (const name of ['evaluationView', 'measurementView', 'updateView']) {
      expect(defs[name].properties.target).toEqual({
        type: 'ref',
        ref: 'com.atproto.repo.strongRef',
      })
    }
    expect(defs.hyperboardView.properties).not.toHaveProperty('target')
  })

  it('accepts both image variants and all seven views across eight kinds', () => {
    const items = Object.keys(viewsByKind).map((kind) =>
      feedItem(kind as keyof typeof viewsByKind),
    )

    expect(() =>
      hydratedOutput.schema.$parse({ items, cursor: 'opaque-cursor' }),
    ).not.toThrow()
  })

  it('accepts unknown future image and view variants through open unions', () => {
    const unknownImage = {
      $type: 'example.feed#unknownImage',
      uri: 'https://example.com/future-image.png',
    }
    expect(() =>
      hydratedOutput.schema.$parse({
        items: [
          {
            ...feedItem(),
            actor: { did: actorDid, avatar: unknownImage },
          },
          {
            ...feedItem(),
            view: {
              ...viewsByKind['cert.create'],
              image: unknownImage,
            },
          },
          {
            ...feedItem(),
            view: { $type: 'example.feed#unknownView' },
          },
        ],
      }),
    ).not.toThrow()
  })

  it.each([
    [
      'missing view discriminator',
      { ...feedItem(), view: { title: 'Missing type', locationCount: 0 } },
    ],
    [
      'missing required view',
      (() => {
        const item = feedItem()
        delete item.view
        return item
      })(),
    ],
    [
      'missing image discriminator',
      {
        ...feedItem(),
        actor: {
          did: actorDid,
          avatar: { uri: 'https://example.com/image.png' },
        },
      },
    ],
    ['malformed actor DID', { ...feedItem(), actor: { did: 'not-a-did' } }],
    [
      'malformed blob CID',
      {
        ...feedItem(),
        actor: {
          did: actorDid,
          avatar: {
            $type: 'org.hypercerts.defs#smallImage',
            image: blobWith({ ref: 'not-a-cid' }),
          },
        },
      },
    ],
    [
      'malformed image URI',
      {
        ...feedItem(),
        actor: {
          did: actorDid,
          avatar: { ...uriImage, uri: 'not a URI' },
        },
      },
    ],
    [
      'negative image size',
      {
        ...feedItem(),
        actor: {
          did: actorDid,
          avatar: {
            $type: 'org.hypercerts.defs#smallImage',
            image: blobWith({ size: -1 }),
          },
        },
      },
    ],
    [
      'malformed target reference',
      {
        ...feedItem('evaluation.create'),
        view: {
          ...viewsByKind['evaluation.create'],
          target: { uri: 'not-an-at-uri', cid: 'not-a-cid' },
        },
      },
    ],
  ])('rejects %s', (_label, item) => {
    expect(() => hydratedOutput.schema.$parse({ items: [item] })).toThrow()
  })
})

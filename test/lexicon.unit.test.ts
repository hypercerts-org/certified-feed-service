import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

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
const createdAt = '2026-07-21T10:00:00.000Z'

const uriImage = {
  $type: 'app.certified.feed.beta.defs#uriImage',
  uri: 'https://example.com/image.png',
}
const blobImage = {
  $type: 'app.certified.feed.beta.defs#blobImage',
  did: actorDid,
  cid,
  mimeType: 'image/png',
  size: 128,
}
const actor = {
  did: actorDid,
  handle: 'actor.example',
  displayName: 'Actor',
  avatar: blobImage,
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
    image: blobImage,
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
    image: blobImage,
    createdAt,
    target,
  },
} as const

const availableItem = (
  kind: keyof typeof viewsByKind = 'cert.create',
): Record<string, unknown> => ({
  $type: 'app.certified.feed.beta.defs#availableFeedItem',
  id: uri,
  kind,
  subject: { uri, cid },
  sortAt: createdAt,
  actor,
  recordState: 'available',
  view: viewsByKind[kind],
})

describe('feed Lexicon contract', () => {
  it('keeps shared input fields and UpperCamelCase public errors identical', () => {
    expect(hydratedMain.input).toEqual(skeletonMain.input)
    expect(
      hydratedMain.input.schema.properties.organizationQuality.ref,
    ).toBe('app.certified.feed.beta.defs#organizationQualityPolicy')
    expect(hydratedMain.errors).toEqual(skeletonMain.errors)
    expect(
      hydratedMain.errors.map((error: { name: string }) => error.name),
    ).toEqual([
      'InvalidRequest',
      'AuthorsFilterTooLarge',
      'TrustedEvaluatorsTooLarge',
      'FeedScopeTooLarge',
      'InvalidKind',
      'InvalidCursor',
      'InternalError',
    ])
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

  it('defines open available and invalid hydrated item variants', () => {
    expect(hydratedMain.output.schema.properties.items.items).toEqual({
      type: 'union',
      refs: [
        'app.certified.feed.beta.defs#availableFeedItem',
        'app.certified.feed.beta.defs#invalidFeedItem',
      ],
    })
    expect(defs.availableFeedItem.required).toEqual([
      'id',
      'kind',
      'subject',
      'sortAt',
      'actor',
      'recordState',
      'view',
    ])
    expect(defs.availableFeedItem.properties.recordState.const).toBe(
      'available',
    )
    expect(defs.availableFeedItem.properties.view).not.toHaveProperty('closed')
    expect(defs.availableFeedItem.properties.view.refs).toEqual([
      '#activityView',
      '#collectionView',
      '#endorsementView',
      '#evaluationView',
      '#measurementView',
      '#hyperboardView',
      '#updateView',
    ])
    expect(defs.invalidFeedItem.required).toEqual([
      'id',
      'kind',
      'subject',
      'sortAt',
      'actor',
      'recordState',
    ])
    expect(defs.invalidFeedItem.properties.recordState.const).toBe('invalid')
    expect(defs.invalidFeedItem.properties).not.toHaveProperty('view')
    expect(defs).not.toHaveProperty('hydratedFeedItem')

    const serialized = JSON.stringify({
      available: defs.availableFeedItem,
      invalid: defs.invalidFeedItem,
    })
    for (const forbidden of [
      'record',
      'profileSource',
      'actorDid',
      'notFound',
      'cidMismatch',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
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

  it('accepts both image variants, all seven views across eight kinds, and invalid items', () => {
    const items = Object.keys(viewsByKind).map((kind) =>
      availableItem(kind as keyof typeof viewsByKind),
    )
    items.push({
      $type: 'app.certified.feed.beta.defs#invalidFeedItem',
      id: uri,
      kind: 'collection.create',
      subject: { uri, cid },
      sortAt: createdAt,
      actor: { did: actorDid, avatar: uriImage },
      recordState: 'invalid',
    })

    expect(() =>
      hydratedOutput.schema.$parse({ items, cursor: 'opaque-cursor' }),
    ).not.toThrow()
  })

  it('accepts unknown future item and view variants through open unions', () => {
    expect(() =>
      hydratedOutput.schema.$parse({
        items: [
          {
            ...availableItem(),
            view: { $type: 'example.feed#unknownView' },
          },
          { $type: 'example.feed#unknownItem' },
        ],
      }),
    ).not.toThrow()
  })

  it.each([
    [
      'missing view discriminator',
      { ...availableItem(), view: { title: 'Missing type', locationCount: 0 } },
    ],
    [
      'missing required available view',
      (() => {
        const item = availableItem()
        delete item.view
        return item
      })(),
    ],
    [
      'missing item discriminator',
      (() => {
        const item = availableItem()
        delete item.$type
        return item
      })(),
    ],
    [
      'missing image discriminator',
      {
        ...availableItem(),
        actor: {
          did: actorDid,
          avatar: { uri: 'https://example.com/image.png' },
        },
      },
    ],
    [
      'unknown image discriminator',
      {
        ...availableItem(),
        actor: {
          did: actorDid,
          avatar: {
            $type: 'example.feed#unknownImage',
            uri: 'https://example.com/image.png',
          },
        },
      },
    ],
    ['malformed actor DID', { ...availableItem(), actor: { did: 'not-a-did' } }],
    [
      'malformed blob CID',
      {
        ...availableItem(),
        actor: {
          did: actorDid,
          avatar: { ...blobImage, cid: 'not-a-cid' },
        },
      },
    ],
    [
      'malformed image URI',
      {
        ...availableItem(),
        actor: {
          did: actorDid,
          avatar: { ...uriImage, uri: 'not a URI' },
        },
      },
    ],
    [
      'negative image size',
      {
        ...availableItem(),
        actor: { did: actorDid, avatar: { ...blobImage, size: -1 } },
      },
    ],
    [
      'malformed target reference',
      {
        ...availableItem('evaluation.create'),
        view: {
          ...viewsByKind['evaluation.create'],
          target: { uri: 'not-an-at-uri', cid: 'not-a-cid' },
        },
      },
    ],
    ['unknown record state', { ...availableItem(), recordState: 'notFound' }],
  ])('rejects %s', (_label, item) => {
    expect(() => hydratedOutput.schema.$parse({ items: [item] })).toThrow()
  })
})

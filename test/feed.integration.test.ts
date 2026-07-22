import { randomBytes } from 'node:crypto'

import pino from 'pino'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { Database } from '../src/database.js'
import { FeedRepository } from '../src/feed/query.js'
import { FeedService } from '../src/feed/service.js'
import { Metrics } from '../src/metrics.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
if (!TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is required for integration tests; point it at an empty disposable Postgres 16+ database.',
  )
}
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const staleCid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72a'
const plcAlphabet = 'abcdefghijklmnopqrstuvwxyz234567'

const randomDid = (): string => {
  const bytes = randomBytes(24)
  let suffix = ''
  for (const byte of bytes) suffix += plcAlphabet[byte % plcAlphabet.length]
  return `did:plc:${suffix}`
}

describe('FeedRepository against Postgres', () => {
  const logger = pino({ enabled: false })
  let admin: Pool
  let database: Database
  let service: FeedService

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL })
    await admin.query(`
      CREATE TABLE IF NOT EXISTS record (
        uri text PRIMARY KEY NOT NULL,
        cid text NOT NULL,
        did text NOT NULL,
        collection text NOT NULL,
        json jsonb NOT NULL,
        indexed_at timestamptz NOT NULL DEFAULT NOW(),
        sort_at timestamptz NOT NULL,
        subject_did text GENERATED ALWAYS AS (
          CASE jsonb_typeof(json->'subject')
            WHEN 'string' THEN
              CASE WHEN json->>'subject' LIKE 'at://%' THEN
                split_part(substring(json->>'subject' from 6), '/', 1)
              ELSE NULL END
            WHEN 'object' THEN
              COALESCE(
                json->'subject'->>'did',
                CASE WHEN json->'subject'->>'uri' LIKE 'at://%' THEN
                  split_part(substring(json->'subject'->>'uri' from 6), '/', 1)
                ELSE NULL END
              )
            ELSE NULL
          END
        ) STORED
      );
      CREATE TABLE IF NOT EXISTS actor (
        did text PRIMARY KEY NOT NULL,
        indexed_at timestamptz NOT NULL DEFAULT NOW(),
        is_active boolean NOT NULL DEFAULT true,
        is_certified_organization boolean NOT NULL DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS label (
        id serial PRIMARY KEY,
        uri text NOT NULL,
        src text NOT NULL,
        cid text,
        val text NOT NULL,
        neg boolean NOT NULL DEFAULT false,
        cts timestamptz NOT NULL DEFAULT NOW(),
        exp timestamptz
      );
    `)

    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_MAX_CONNECTIONS: '3',
      DATABASE_STATEMENT_TIMEOUT_MS: '10000',
    })
    database = new Database(config, logger)
    service = new FeedService(
      new FeedRepository(database),
      [],
      new Metrics(),
    )
  })

  afterAll(async () => {
    await database?.close()
    await admin?.end()
  })

  const seedActor = async (
    did: string,
    options: { active?: boolean; organization?: boolean } = {},
  ): Promise<void> => {
    await admin.query(
      `INSERT INTO actor (did, indexed_at, is_active, is_certified_organization)
       VALUES ($1, NOW(), $2, $3)`,
      [did, options.active ?? true, options.organization ?? false],
    )
  }

  const seedRecord = async (
    did: string,
    collection: string,
    rkey: string,
    body: Record<string, unknown>,
    sortAt: string,
  ): Promise<string> => {
    const uri = `at://${did}/${collection}/${rkey}`
    await admin.query(
      `INSERT INTO record (uri, cid, did, collection, json, sort_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
      [uri, cid, did, collection, JSON.stringify(body), sortAt],
    )
    return uri
  }

  it('passes readiness capability checks and rejects writes from the service pool', async () => {
    await expect(database.checkCompatibility()).resolves.toEqual({
      compatible: true,
    })
    await expect(
      database.query(
        `INSERT INTO actor (did, is_active, is_certified_organization)
         VALUES ($1, true, false)`,
        [randomDid()],
      ),
    ).rejects.toThrow(/read-only/i)
  })

  it('resolves follows and evaluators, applies quality, and classifies before filtering', async () => {
    const viewer = randomDid()
    const trustedLabeler = randomDid()
    const followedOrg = randomDid()
    const blockedOrg = randomDid()
    const inactive = randomDid()
    const evaluator = randomDid()
    const endorsedPerson = randomDid()
    const awardSubject = randomDid()

    await Promise.all([
      seedActor(viewer),
      seedActor(followedOrg, { organization: true }),
      seedActor(blockedOrg, { organization: true }),
      seedActor(inactive, { active: false }),
      seedActor(evaluator),
      seedActor(endorsedPerson),
      seedActor(awardSubject),
    ])

    for (const [index, subject] of [followedOrg, blockedOrg, inactive].entries()) {
      await seedRecord(
        viewer,
        'app.certified.graph.follow',
        `follow-${index}`,
        { subject },
        `2026-07-20T00:00:0${index}Z`,
      )
    }

    await admin.query(
      `INSERT INTO label (uri, src, val, neg, cts)
       VALUES
         ($1, $2, 'high-quality', false, '2026-07-20T00:00:00Z'),
         ($3, $2, 'likely-test', false, '2026-07-20T00:00:00Z'),
         ($3, $4, 'high-quality', false, '2026-07-20T00:00:01Z')`,
      [
        `at://${followedOrg}/app.certified.actor.organization/self`,
        trustedLabeler,
        `at://${blockedOrg}/app.certified.actor.organization/self`,
        randomDid(),
      ],
    )

    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'endorsement-definition',
      { badgeType: 'endorsement' },
      '2026-07-20T01:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'scope-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: endorsedPerson },
      },
      '2026-07-20T01:00:01Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'malformed-scope-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: 'alice' },
      },
      '2026-07-20T01:00:02Z',
    )
    await seedRecord(
      'alice',
      'org.hypercerts.claim.activity',
      'must-not-enter-scope',
      { createdAt: '2026-07-21T14:00:00Z' },
      '2026-07-21T14:00:00Z',
    )

    const activityUri = await seedRecord(
      followedOrg,
      'org.hypercerts.claim.activity',
      'paired-activity',
      { createdAt: '2026-07-21T10:00:00Z' },
      '2026-07-21T10:00:00Z',
    )
    const collectionUri = await seedRecord(
      followedOrg,
      'org.hypercerts.collection',
      'project',
      {
        createdAt: '2026-07-21T10:00:10Z',
        items: [{ itemIdentifier: { uri: activityUri, cid } }],
      },
      '2026-07-21T10:00:10Z',
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.evaluation',
      'evaluation',
      { createdAt: '2026-07-21T11:00:00+00:00' },
      '2026-07-21T09:00:00Z',
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.attachment',
      'update',
      { contentType: 'update', createdAt: '2026-07-21T09:00:00Z' },
      '2026-07-21T09:00:00Z',
    )
    await seedRecord(
      followedOrg,
      'org.hypercerts.context.attachment',
      'audit',
      { contentType: 'audit', createdAt: '2026-07-21T08:30:00Z' },
      '2026-07-21T08:30:00Z',
    )
    const boardUri = await seedRecord(
      followedOrg,
      'org.hyperboards.board',
      'board',
      { createdAt: { malformed: true } },
      '2026-07-21T08:00:00Z',
    )
    const dateOnlyUri = await seedRecord(
      followedOrg,
      'org.hypercerts.context.measurement',
      'date-only-created-at',
      { createdAt: '2026-07-22' },
      '2026-07-21T07:30:00Z',
    )
    await seedRecord(
      blockedOrg,
      'org.hypercerts.claim.activity',
      'blocked',
      { createdAt: '2026-07-21T12:00:00Z' },
      '2026-07-21T12:00:00Z',
    )
    await seedRecord(
      inactive,
      'org.hypercerts.claim.activity',
      'inactive',
      { createdAt: '2026-07-21T13:00:00Z' },
      '2026-07-21T13:00:00Z',
    )
    const endorsedUri = await seedRecord(
      endorsedPerson,
      'org.hypercerts.claim.activity',
      'endorsed',
      { createdAt: '2026-07-21T07:00:00Z' },
      '2026-07-21T07:00:00Z',
    )

    const feedDefinitionUri = await seedRecord(
      followedOrg,
      'app.certified.badge.definition',
      'feed-endorsement-definition',
      { badgeType: 'endorsement' },
      '2026-07-20T02:00:00Z',
    )
    const visibleAwardUri = await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'visible-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: awardSubject },
        createdAt: '2026-07-21T06:00:00Z',
      },
      '2026-07-21T06:00:00Z',
    )
    await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'malformed-subject-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: 'alice' },
        createdAt: '2026-07-21T05:30:00Z',
      },
      '2026-07-21T05:30:00Z',
    )
    await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'self-endorsement-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: followedOrg },
        createdAt: '2026-07-21T05:15:00Z',
      },
      '2026-07-21T05:15:00Z',
    )
    const rejectedAwardUri = await seedRecord(
      followedOrg,
      'app.certified.badge.award',
      'rejected-award',
      {
        badge: { uri: feedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: endorsedPerson },
        createdAt: '2026-07-21T05:00:00Z',
      },
      '2026-07-21T05:00:00Z',
    )
    await seedRecord(
      endorsedPerson,
      'app.certified.badge.response',
      'rejection',
      { badgeAward: { uri: rejectedAwardUri, cid }, response: 'rejected' },
      '2026-07-21T05:01:00Z',
    )

    service = new FeedService(
      new FeedRepository(database),
      [trustedLabeler],
      new Metrics(),
    )
    const output = await service.getFeedSkeleton({
      viewerDid: viewer,
      trustedEvaluators: [evaluator],
      organizationQuality: {
        allowed: ['high-quality'],
        includeUnrated: false,
      },
      limit: 50,
    })

    expect(output.items.map((item) => item.kind)).toEqual([
      'evaluation.create',
      'project.created_with_cert',
      'update.create',
      'hyperboard.create',
      'measurement.create',
      'cert.create',
      'endorsement.award',
    ])
    expect(output.items.map((item) => item.subject.uri)).toEqual([
      expect.stringContaining('/org.hypercerts.context.evaluation/'),
      collectionUri,
      expect.stringContaining('/org.hypercerts.context.attachment/update'),
      boardUri,
      dateOnlyUri,
      endorsedUri,
      visibleAwardUri,
    ])
    expect(output.items.some((item) => item.subject.uri === activityUri)).toBe(false)
    expect(output.items.find((item) => item.subject.uri === boardUri)?.sortAt).toBe(
      '2026-07-21T08:00:00.000000Z',
    )
    expect(
      output.items.find((item) => item.subject.uri === dateOnlyUri)?.sortAt,
    ).toBe('2026-07-21T07:30:00.000000Z')

    const projectOnly = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [followedOrg],
      organizationQuality: {
        allowed: ['high-quality'],
        includeUnrated: false,
      },
      kinds: ['project.created_with_cert'],
    })
    expect(projectOnly.items).toHaveLength(1)
    expect(projectOnly.items[0]?.subject.uri).toBe(collectionUri)

    await admin.query(
      `INSERT INTO label (uri, src, val, neg, cts, exp)
       VALUES ($1, $2, 'likely-test', true, '2026-07-20T00:00:00Z', '2000-01-01T00:00:00Z')`,
      [
        `at://${blockedOrg}/app.certified.actor.organization/self`,
        trustedLabeler,
      ],
    )
    const expiredNegation = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [blockedOrg],
      organizationQuality: { allowed: ['high-quality'], includeUnrated: true },
    })
    expect(expiredNegation.items).toEqual([])

    const activelyNegatedOrg = randomDid()
    await seedActor(activelyNegatedOrg, { organization: true })
    await seedRecord(
      activelyNegatedOrg,
      'org.hypercerts.claim.activity',
      'active-negation',
      { createdAt: '2026-07-21T04:00:00Z' },
      '2026-07-21T04:00:00Z',
    )
    await admin.query(
      `INSERT INTO label (uri, src, val, neg, cts)
       VALUES
         ($1, $2, 'likely-test', false, '2026-07-20T00:00:00Z'),
         ($1, $2, 'likely-test', true, '2026-07-20T00:00:01Z')`,
      [
        `at://${activelyNegatedOrg}/app.certified.actor.organization/self`,
        trustedLabeler,
      ],
    )
    const activeNegation = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [activelyNegatedOrg],
      organizationQuality: { allowed: ['high-quality'], includeUnrated: true },
    })
    expect(activeNegation.items.map((item) => item.kind)).toEqual([
      'cert.create',
    ])
  })

  it('uses the latest subject response when deciding whether an endorsement is active', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const subject = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(evaluator),
      seedActor(subject),
    ])

    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'latest-response-definition',
      { badgeType: 'endorsement' },
      '2026-07-21T01:00:00Z',
    )
    const awardUri = await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'latest-response-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: subject },
        createdAt: '2026-07-21T02:00:00Z',
      },
      '2026-07-21T02:00:00Z',
    )
    const subjectActivity = await seedRecord(
      subject,
      'org.hypercerts.claim.activity',
      'active-after-acceptance',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'older-rejection',
      {
        badgeAward: { uri: awardUri, cid },
        response: 'rejected',
        createdAt: '2026-07-21T04:00:00Z',
      },
      '2026-07-21T04:00:00Z',
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'newer-acceptance',
      {
        badgeAward: { uri: awardUri, cid },
        response: 'accepted',
        createdAt: '2026-07-21T05:00:00Z',
      },
      '2026-07-21T05:00:00Z',
    )

    const output = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [evaluator],
      trustedEvaluators: [evaluator],
      limit: 50,
    })

    expect(output.items.map((item) => item.subject.uri)).toEqual([
      subjectActivity,
      awardUri,
    ])
  })

  it('enforces allowed issuers for evaluator scope and award events', async () => {
    const viewer = randomDid()
    const disallowedIssuer = randomDid()
    const allowedIssuer = randomDid()
    const disallowedSubject = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(disallowedIssuer),
      seedActor(allowedIssuer),
      seedActor(disallowedSubject),
    ])

    const definitionUri = await seedRecord(
      disallowedIssuer,
      'app.certified.badge.definition',
      'restricted-definition',
      { badgeType: 'endorsement', allowedIssuers: [allowedIssuer] },
      '2026-07-21T01:00:00Z',
    )
    const disallowedAwardUri = await seedRecord(
      disallowedIssuer,
      'app.certified.badge.award',
      'disallowed-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T02:00:00Z',
    )
    const disallowedSubjectActivity = await seedRecord(
      disallowedSubject,
      'org.hypercerts.claim.activity',
      'must-not-expand',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )

    await expect(
      service.getFeedSkeleton({
        viewerDid: viewer,
        authors: [],
        trustedEvaluators: [disallowedIssuer],
      }),
    ).resolves.toEqual({ items: [] })
    await expect(
      service.getFeedSkeleton({
        viewerDid: viewer,
        authors: [disallowedIssuer],
      }),
    ).resolves.toEqual({ items: [] })

    const allowedAwardUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.award',
      'allowed-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T04:00:00Z',
    )
    const malformedDefinitionUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.definition',
      'malformed-allowed-issuers-definition',
      { badgeType: 'endorsement', allowedIssuers: { did: allowedIssuer } },
      '2026-07-21T04:00:01Z',
    )
    const malformedAwardUri = await seedRecord(
      allowedIssuer,
      'app.certified.badge.award',
      'malformed-allowed-issuers-award',
      {
        badge: { uri: malformedDefinitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: disallowedSubject },
      },
      '2026-07-21T04:00:02Z',
    )
    const allowedOutput = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [allowedIssuer],
    })

    expect(allowedOutput.items.map((item) => item.subject.uri)).toEqual([
      allowedAwardUri,
    ])
    expect(allowedOutput.items.some((item) => item.subject.uri === disallowedAwardUri)).toBe(
      false,
    )
    expect(allowedOutput.items.some((item) => item.subject.uri === malformedAwardUri)).toBe(
      false,
    )
    expect(
      allowedOutput.items.some(
        (item) => item.subject.uri === disallowedSubjectActivity,
      ),
    ).toBe(false)
  })

  it('does not turn record-target endorsements into account endorsements', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const recordOwner = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(evaluator),
      seedActor(recordOwner),
    ])

    const targetActivity = await seedRecord(
      recordOwner,
      'org.hypercerts.claim.activity',
      'record-target',
      { createdAt: '2026-07-21T03:00:00Z' },
      '2026-07-21T03:00:00Z',
    )
    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'record-target-definition',
      { badgeType: 'endorsement' },
      '2026-07-21T01:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'record-target-award',
      {
        badge: { uri: definitionUri, cid },
        subject: {
          $type: 'com.atproto.repo.strongRef',
          uri: targetActivity,
          cid,
        },
        createdAt: '2026-07-21T02:00:00Z',
      },
      '2026-07-21T02:00:00Z',
    )
    await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'wrong-subject-type-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'example.invalid#did', did: recordOwner },
        createdAt: '2026-07-21T02:30:00Z',
      },
      '2026-07-21T02:30:00Z',
    )

    await expect(
      service.getFeedSkeleton({
        viewerDid: viewer,
        authors: [],
        trustedEvaluators: [evaluator],
      }),
    ).resolves.toEqual({ items: [] })

    await expect(
      service.getFeedSkeleton({ viewerDid: viewer, authors: [evaluator] }),
    ).resolves.toEqual({ items: [] })
  })

  it('requires exact CIDs when pairing projects and resolving badge definitions', async () => {
    const viewer = randomDid()
    const author = randomDid()
    const endorsementSubject = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(author),
      seedActor(endorsementSubject),
    ])

    const activityUri = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'current-activity-version',
      { createdAt: '2026-07-21T10:00:00Z' },
      '2026-07-21T10:00:00Z',
    )
    const collectionUri = await seedRecord(
      author,
      'org.hypercerts.collection',
      'stale-activity-reference',
      {
        createdAt: '2026-07-21T10:00:10Z',
        items: [{ itemIdentifier: { uri: activityUri, cid: staleCid } }],
      },
      '2026-07-21T10:00:10Z',
    )
    const definitionUri = await seedRecord(
      author,
      'app.certified.badge.definition',
      'current-definition-version',
      { badgeType: 'endorsement' },
      '2026-07-21T09:00:00Z',
    )
    const awardUri = await seedRecord(
      author,
      'app.certified.badge.award',
      'stale-definition-reference',
      {
        badge: { uri: definitionUri, cid: staleCid },
        subject: {
          $type: 'app.certified.defs#did',
          did: endorsementSubject,
        },
        createdAt: '2026-07-21T09:30:00Z',
      },
      '2026-07-21T09:30:00Z',
    )
    const subjectActivity = await seedRecord(
      endorsementSubject,
      'org.hypercerts.claim.activity',
      'must-not-enter-through-stale-definition',
      { createdAt: '2026-07-21T11:00:00Z' },
      '2026-07-21T11:00:00Z',
    )

    const output = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [author],
      trustedEvaluators: [author],
      limit: 50,
    })

    expect(output.items.map((item) => item.subject.uri)).toEqual([
      collectionUri,
      activityUri,
    ])
    expect(output.items.map((item) => item.kind)).toEqual([
      'collection.create',
      'cert.create',
    ])
    expect(output.items.some((item) => item.subject.uri === awardUri)).toBe(false)
    expect(
      output.items.some((item) => item.subject.uri === subjectActivity),
    ).toBe(false)
  })

  it('suppresses a paired activity across a pagination boundary', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await Promise.all([seedActor(viewer), seedActor(author)])

    const pairedActivity = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'paired',
      { createdAt: '2026-07-21T10:00:02Z' },
      '2026-07-21T10:00:02Z',
    )
    const collection = await seedRecord(
      author,
      'org.hypercerts.collection',
      'project',
      {
        createdAt: '2026-07-21T10:00:04Z',
        items: [{ itemIdentifier: { uri: pairedActivity, cid } }],
      },
      '2026-07-21T10:00:04Z',
    )
    const standalone = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'standalone',
      { createdAt: '2026-07-21T10:00:03Z' },
      '2026-07-21T10:00:03Z',
    )
    const old = await seedRecord(
      author,
      'org.hypercerts.claim.activity',
      'old',
      { createdAt: '2026-07-21T09:00:00Z' },
      '2026-07-21T09:00:00Z',
    )

    const first = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [author],
      limit: 2,
    })
    expect(first.items.map((item) => item.subject.uri)).toEqual([
      collection,
      standalone,
    ])
    expect(first.items[0]?.kind).toBe('project.created_with_cert')

    const second = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [author],
      limit: 2,
      cursor: first.cursor!,
    })
    expect(second.items.map((item) => item.subject.uri)).toEqual([old])
    expect(
      [...first.items, ...second.items].some(
        (item) => item.subject.uri === pairedActivity,
      ),
    ).toBe(false)
  })

  it('paginates equal timestamps by descending URI without repeats', async () => {
    const viewer = randomDid()
    const author = randomDid()
    await Promise.all([seedActor(viewer), seedActor(author)])

    const uris: string[] = []
    for (const rkey of ['a', 'b', 'c']) {
      uris.push(
        await seedRecord(
          author,
          'org.hypercerts.context.measurement',
          rkey,
          { createdAt: '2026-07-21T12:00:00Z' },
          '2026-07-21T12:00:00Z',
        ),
      )
    }

    const first = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [author],
      limit: 2,
    })
    expect(first.items.map((item) => item.subject.uri)).toEqual([
      uris[2],
      uris[1],
    ])
    expect(first.cursor).toBeDefined()

    const second = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [author],
      limit: 2,
      cursor: first.cursor!,
    })
    expect(second.items.map((item) => item.subject.uri)).toEqual([uris[0]])
    expect(second.cursor).toBeUndefined()
  })

  it('ignores malformed follow subjects before they can enter the feed', async () => {
    const viewer = randomDid()
    const malformedDid = 'not-a-did'
    await seedActor(viewer)
    await seedRecord(
      viewer,
      'app.certified.graph.follow',
      'malformed-follow',
      { subject: malformedDid },
      '2026-07-22T01:00:00Z',
    )
    await seedRecord(
      malformedDid,
      'org.hypercerts.claim.activity',
      'must-not-break-feed',
      { createdAt: '2026-07-22T02:00:00Z' },
      '2026-07-22T02:00:00Z',
    )

    await expect(
      service.getFeedSkeleton({ viewerDid: viewer }),
    ).resolves.toEqual({ items: [] })
  })

  it('ignores responses that target a stale award CID', async () => {
    const viewer = randomDid()
    const evaluator = randomDid()
    const subject = randomDid()
    await Promise.all([
      seedActor(viewer),
      seedActor(evaluator),
      seedActor(subject),
    ])

    const definitionUri = await seedRecord(
      evaluator,
      'app.certified.badge.definition',
      'stale-response-definition',
      { badgeType: 'endorsement' },
      '2026-07-22T03:00:00Z',
    )
    const awardUri = await seedRecord(
      evaluator,
      'app.certified.badge.award',
      'stale-response-award',
      {
        badge: { uri: definitionUri, cid },
        subject: { $type: 'app.certified.defs#did', did: subject },
      },
      '2026-07-22T04:00:00Z',
    )
    const subjectActivity = await seedRecord(
      subject,
      'org.hypercerts.claim.activity',
      'stale-response-subject',
      { createdAt: '2026-07-22T05:00:00Z' },
      '2026-07-22T05:00:00Z',
    )
    await seedRecord(
      subject,
      'app.certified.badge.response',
      'stale-response-rejection',
      {
        badgeAward: { uri: awardUri, cid: staleCid },
        response: 'rejected',
      },
      '2026-07-22T06:00:00Z',
    )

    await expect(
      service.getFeedSkeleton({ viewerDid: viewer, authors: [evaluator] }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ subject: { uri: awardUri } })],
    })
    await expect(
      service.getFeedSkeleton({
        viewerDid: viewer,
        authors: [],
        trustedEvaluators: [evaluator],
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ subject: { uri: subjectActivity } })],
    })
  })

  it('keeps an explicitly empty author and evaluator scope empty', async () => {
    const viewer = randomDid()
    await seedActor(viewer)

    const output = await service.getFeedSkeleton({
      viewerDid: viewer,
      authors: [],
      trustedEvaluators: [],
    })

    expect(output).toEqual({ items: [] })
  })
})

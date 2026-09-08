# @hypercerts/hypercerts-feed-service

## 0.1.1

### Patch Changes

- [#7](https://github.com/hypercerts-org/hypercerts-feed-service/pull/7) [`07fc96f`](https://github.com/hypercerts-org/hypercerts-feed-service/commit/07fc96f229a4a9200331c94d6fdc15b68c271268) Thanks [@Kzoeps](https://github.com/Kzoeps)! - Introduce the initial version of Hypercerts Feed Service.

  Available in this release:

  - `org.hypercerts.feed.getFeedSkeleton`, returning URI-only feed subjects.
  - `org.hypercerts.feed.getFeed`, returning validated feed-specific views with actor summaries.
  - The Hypercerts feed algorithm, including follow-based scope, evaluator expansion, organization-quality filters, kind filtering, keyset pagination, and current-state hydration for all eight supported feed kinds.
  - Read-only Hyperindex PostgreSQL access, health and readiness endpoints, private Prometheus metrics, bounded requests and queries, and graceful shutdown.
  - Automated Changesets release notes, Git tags, and GitHub Releases with approval-gated CI and exact-commit validation.

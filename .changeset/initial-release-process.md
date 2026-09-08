---
"@hypercerts/hypercerts-feed-service": patch
---

Introduce the initial version of Hypercerts Feed Service.

Available in this release:

- `org.hypercerts.feed.getFeedSkeleton`, returning URI-only feed subjects.
- `org.hypercerts.feed.getFeed`, returning validated feed-specific views with actor summaries.
- The Hypercerts feed algorithm, including follow-based scope, evaluator expansion, organization-quality filters, kind filtering, keyset pagination, and current-state hydration for all eight supported feed kinds.
- Read-only Hyperindex PostgreSQL access, health and readiness endpoints, private Prometheus metrics, bounded requests and queries, and graceful shutdown.
- Automated Changesets release notes, Git tags, and GitHub Releases with approval-gated CI and exact-commit validation.

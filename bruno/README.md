# Bruno collection

Open this directory as a collection in [Bruno](https://www.usebruno.com/), then select an environment:

- `prod` uses `https://feed.hypercerts.dev`.
- `staging` uses the planned `https://dev.feed.hypercerts.dev` domain. Requests will fail until that domain is configured.

Both environments default to the public `kzoeps.com` viewer DID. Override `viewerDid` in Bruno when testing another viewer scope.

The collection contains read-only health, readiness, skeleton, hydrated-feed, and basic kind-filter requests. Feed requests are unauthenticated and do not modify records.

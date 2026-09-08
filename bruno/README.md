# Bruno collection

Open this directory as a collection in [Bruno](https://www.usebruno.com/), then select an environment:

- `prod` uses `https://feed.hypercerts.dev`.
- `staging` uses the planned `https://dev.feed.hypercerts.dev` domain. Requests will fail until that domain is configured.

Both environments default to the public `kzoeps.com` viewer DID and a page limit of 10. Override `viewerDid`, `limit`, or `cursor` in Bruno when testing another viewer scope or page. Leave `cursor` empty for the first page, then paste a cursor returned by the service to load the next page.

The collection contains read-only health, readiness, skeleton, hydrated-feed, and basic kind-filter requests. **Hydrated feed — all parameters** shows every currently supported request field in one place. Feed requests are unauthenticated and do not modify records.

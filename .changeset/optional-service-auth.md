---
"@hypercerts/hypercerts-feed-service": minor
---

Feed requests can now use AT Protocol service authentication. If a request includes a valid token, the token's issuer becomes the feed viewer. Requests without a token still need `params.viewerDid`.

Before upgrading, set `SERVICE_DID` to this service's DID, even if you do not use authentication. It must be a bare DID, without `#serviceId`.

The `did#serviceId` format from AT Protocol Proposal 0014 is not supported yet because `@atproto/lex-server` does not support it.

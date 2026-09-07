# Changesets

Add a `.changeset/*.md` fragment when a pull request affects application behavior, runtime configuration, the public contract, supported runtime versions, service deployment, or operator procedures:

```bash
npm run changeset
```

Local development tools, tests, behavior-preserving internal refactors, documentation-only corrections, and repository or CI maintenance with no service or operator impact do not need a Changeset. CI does not infer semantic release impact; contributors and reviewers own this decision.

The release workflow turns pending changesets into a `Release` pull request. GitHub creates CI runs for that automation-owned pull request in an approval-required state. A maintainer with write access must select **Approve workflows to run** before merging it.

Merging the `Release` pull request updates the application version and changelog. The release workflow then validates the exact merged commit and creates a Git tag and GitHub Release. The private application package is never published to npm.

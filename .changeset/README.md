# Changesets

Every normal pull request needs one `.changeset/*.md` fragment. Add a release-note changeset for application or operator-workflow changes:

```bash
npm run changeset
```

For docs-only, internal, or other changes that should merge without changing the application version, create an empty changeset:

```bash
npm run changeset:empty
```

The release workflow turns pending changesets into a `Release` pull request. GitHub creates CI runs for that automation-owned pull request in an approval-required state. A maintainer with write access must select **Approve workflows to run** before merging it.

Merging the `Release` pull request updates the application version and changelog. The release workflow then validates the exact merged commit and creates a Git tag and GitHub Release. The private application package is never published to npm.

# Releasing

This repository uses Changesets to version the service and create GitHub Releases. The package is private and is never published to npm. Releases are not coupled to deployment.

## Contributors

Every normal pull request needs one Changeset fragment. For application behavior, configuration, public contract, or operator-workflow changes, add a release-note fragment:

```bash
npm run changeset
```

Commit the generated `.changeset/*.md` file with the pull request. For docs-only, tests, internal refactors, or other changes that should merge without changing the application version, add an empty fragment:

```bash
npm run changeset:empty
```

Empty Changesets satisfy the CI check. `.changeset/README.md` is documentation, not a fragment.

## Maintainers

1. Merge a normal pull request into `main` after CI passes.
2. A push to `main` with pending Changesets creates or updates one pull request from `changeset-release/main` titled **Release**. That pull request updates `package.json`, `package-lock.json`, and `CHANGELOG.md`.
3. GitHub creates CI runs for the automation-owned Release pull request in an approval-required state. A maintainer with write access must select **Approve workflows to run** in the pull request merge box. Do not merge the Release pull request until its full CI run passes, including the disposable PostgreSQL integration tests.
4. Review and merge **Release**. The release workflow checks out the exact merge commit, installs dependencies without implicit lifecycle scripts, explicitly rebuilds required native dependencies, and reruns type-checking, unit tests, PostgreSQL integration tests, and the production build.
5. After validation, the workflow checks whether the derived tag and GitHub Release already both exist. It does nothing when both exist, fails when only one exists, and otherwise creates the tag and GitHub Release from the generated changelog. It does not publish to npm or deploy the service.

The repository setting **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** must be enabled so the version workflow can create or update **Release**.

The workflow uses only the automatically provided `GITHUB_TOKEN`. Current GitHub behavior creates `pull_request` workflow runs for automation-created or updated pull requests in an approval-required state. Using an organization-owned GitHub App installation token later would allow those CI runs to begin without manual approval while preserving the same Release pull request flow.

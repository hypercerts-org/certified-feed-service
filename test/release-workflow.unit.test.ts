import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const readOptionalFile = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  private?: boolean
  engines?: { node?: string }
  scripts: Record<string, string>
}
const changesetsConfig = (() => {
  const source = readOptionalFile('.changeset/config.json')
  return source === ''
    ? {}
    : (JSON.parse(source) as {
        baseBranch?: string
        changelog?: [string, { repo?: string }]
        privatePackages?: { version?: boolean; tag?: boolean }
      })
})()
const ciWorkflow = readOptionalFile('.github/workflows/ci.yml')
const releaseWorkflow = readOptionalFile('.github/workflows/release.yml')

describe('release workflow', () => {
  test('configures Changesets for private GitHub releases from main', () => {
    expect(packageJson.private).toBe(true)
    expect(packageJson.engines?.node).toBe('>=22.13')
    expect(packageJson.scripts['changeset']).toBe('changeset')
    expect(packageJson.scripts['changeset:empty']).toBe('changeset --empty')
    expect(packageJson.scripts['changeset:status']).toBe('changeset status')
    expect(packageJson.scripts['version:packages']).toBe(
      'changeset version && npm install --package-lock-only --ignore-scripts',
    )
    expect(changesetsConfig).toMatchObject({
      baseBranch: 'main',
      changelog: [
        '@changesets/changelog-github',
        { repo: 'hypercerts-org/certified-feed-service' },
      ],
      privatePackages: { version: true, tag: true },
    })
  })

  test('allows pull requests without a Changeset fragment', () => {
    expect(ciWorkflow).toMatch(/^  workflow_dispatch:/m)
    expect(ciWorkflow).not.toContain('Require a changeset')
    expect(ciWorkflow).not.toContain('npm run changeset:status -- --since')
  })

  test('uses the repository token to create an approval-gated Release pull request', () => {
    expect(releaseWorkflow).toContain('branches: [main]')
    expect(releaseWorkflow).toContain('changesets/action/version@')
    expect(releaseWorkflow).toContain('github-token: ${{ secrets.GITHUB_TOKEN }}')
    expect(releaseWorkflow).toContain("pr-base-branch: main")
    expect(releaseWorkflow).toContain("github.event.pull_request.head.ref == 'changeset-release/main'")
    expect(releaseWorkflow).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    )
  })

  test('disables implicit install scripts in CI and explicitly rebuilds esbuild', () => {
    expect(ciWorkflow).toContain('run: npm ci --ignore-scripts')
    expect(ciWorkflow).toContain('run: npm rebuild esbuild')
    expect(ciWorkflow).not.toMatch(/^\s+run: npm ci\s*$/m)
  })

  test('validates the exact merged release commit against disposable PostgreSQL before publishing', () => {
    expect(releaseWorkflow).toContain(
      'ref: ${{ github.event.pull_request.merge_commit_sha }}',
    )
    expect(releaseWorkflow).toContain('image: postgres:16-alpine')
    expect(releaseWorkflow).toContain(
      'TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/certified_feed_test',
    )
    expect(releaseWorkflow).toMatch(/run: npm run check\s/)
    expect(releaseWorkflow).toMatch(/run: npm test\s/)
    expect(releaseWorkflow).toMatch(/run: npm run test:integration\s/)
    expect(releaseWorkflow).toMatch(/run: npm run build\s/)
    expect(releaseWorkflow).toContain('npm rebuild esbuild')
  })

  test('hardens release dependencies and publishes only tags and GitHub Releases', () => {
    expect(releaseWorkflow).not.toMatch(/uses: [^\n]+@v\d/)
    expect(releaseWorkflow).not.toMatch(/\bnpx\b/)
    expect(releaseWorkflow.match(/^\s+run: npm ci.*$/gm)).toEqual([
      '        run: npm ci --ignore-scripts',
      '        run: npm ci --ignore-scripts',
      '        run: npm ci --ignore-scripts',
    ])
    expect(releaseWorkflow).toContain('create-github-releases: true')
    expect(releaseWorkflow).toContain('push-git-tags: true')
    expect(releaseWorkflow).not.toMatch(/^\s+run: npm publish/m)
  })
})

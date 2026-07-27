import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const hypercertsPackageRoot = dirname(
  require.resolve('@hypercerts-org/lexicon/package.json'),
)
const lexPackageRoot = dirname(dirname(require.resolve('@atproto/lex')))
const stagingRoot = await mkdtemp(join(tmpdir(), 'certified-feed-lexicons-'))
const stagedLexicons = join(stagingRoot, 'lexicons')

try {
  await cp(join(repositoryRoot, 'lexicons'), stagedLexicons, { recursive: true })

  // lex build resolves refs from one directory. Stage the exact published URI
  // fragment without generating unrelated definitions from the dependency.
  const hypercertsDefs = JSON.parse(
    await readFile(
      join(hypercertsPackageRoot, 'lexicons/org/hypercerts/defs.json'),
      'utf8',
    ),
  )
  if (
    hypercertsDefs.lexicon !== 1 ||
    hypercertsDefs.id !== 'org.hypercerts.defs' ||
    hypercertsDefs.defs?.uri === undefined
  ) {
    throw new Error(
      'The installed @hypercerts-org/lexicon package does not expose org.hypercerts.defs#uri in the expected Lexicon v1 document; verify the pinned package version before regenerating feed schemas.',
    )
  }
  const destination = join(stagedLexicons, 'org/hypercerts/defs.json')
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(
    destination,
    `${JSON.stringify(
      {
        lexicon: hypercertsDefs.lexicon,
        id: hypercertsDefs.id,
        defs: { uri: hypercertsDefs.defs.uri },
      },
      null,
      2,
    )}\n`,
  )

  execFileSync(
    process.execPath,
    [
      join(lexPackageRoot, 'bin', 'lex'),
      'build',
      '--lexicons',
      stagedLexicons,
      '--out',
      join(repositoryRoot, 'src/lexicons'),
      '--clear',
      '--indexFile',
    ],
    { stdio: 'inherit' },
  )
  execFileSync(
    process.execPath,
    [join(repositoryRoot, 'scripts/fix-generated-feed-defs.mjs')],
    { stdio: 'inherit' },
  )
} finally {
  await rm(stagingRoot, { recursive: true, force: true })
}

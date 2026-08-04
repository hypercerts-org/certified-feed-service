import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const generatedFile = fileURLToPath(
  new URL(
    '../src/lexicons/app/certified/feed/beta/defs.defs.ts',
    import.meta.url,
  ),
)

// @atproto/lex@0.3.0 emits an explicit schema generic whose optional
// properties conflict with exactOptionalPropertyTypes. Inference preserves
// the runtime schema and generated public type without weakening app checks.
const explicitParamsType = 'l.typedObject<CertifiedFeedParams>('

let source
try {
  source = await readFile(generatedFile, 'utf8')
} catch (cause) {
  throw new Error(
    `Expected generated feed definitions at ${generatedFile}; run lex build before the exact-optional-properties workaround and verify that output path.`,
    { cause },
  )
}

const occurrences = source.split(explicitParamsType).length - 1
if (occurrences !== 1) {
  throw new Error(
    `Expected exactly one ${explicitParamsType} in ${generatedFile}, found ${occurrences}; inspect the new @atproto/lex output and update or remove this workaround.`,
  )
}

await writeFile(
  generatedFile,
  source.replace(explicitParamsType, 'l.typedObject('),
)

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const generatedDefs = new URL(
  '../src/lexicons/app/certified/feed/beta/defs.defs.ts',
  import.meta.url,
)

// @atproto/lex@0.3.0 emits explicit typedObject<T> calls whose optional
// properties conflict with exactOptionalPropertyTypes. Inference preserves the
// same runtime schema and generated public types without weakening app checks.
const explicitSimpleType = /l\.typedObject<([A-Za-z_$][A-Za-z0-9_$]*)>\(/g

let source
try {
  source = await readFile(generatedDefs, 'utf8')
} catch (cause) {
  const generatedPath = fileURLToPath(generatedDefs)
  if (
    cause instanceof Error &&
    'code' in cause &&
    cause.code === 'ENOENT'
  ) {
    throw new Error(
      `Expected generated Certified feed definitions at ${generatedPath}, but lex build did not create them; run lex build with the repository's lexicons and output directory, then verify that path exists.`,
      { cause },
    )
  }
  throw new Error(
    `Failed to read generated Certified feed definitions at ${generatedPath}; check filesystem access and retry codegen.`,
    { cause },
  )
}

const rewritten = source.replace(explicitSimpleType, 'l.typedObject(')
if (rewritten.includes('l.typedObject<')) {
  throw new Error(
    'Generated Certified feed definitions contain an unsupported typedObject generic; update the narrow @atproto/lex@0.3.0 workaround before continuing.',
  )
}

if (rewritten !== source) await writeFile(generatedDefs, rewritten)

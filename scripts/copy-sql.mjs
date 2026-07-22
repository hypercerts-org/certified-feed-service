import { mkdir, copyFile } from 'node:fs/promises'

const source = new URL('../src/feed/feed-query.sql', import.meta.url)
const destination = new URL('../dist/feed/feed-query.sql', import.meta.url)

await mkdir(new URL('../dist/feed/', import.meta.url), { recursive: true })
await copyFile(source, destination)

/**
 * Run every test file in this directory, in order.
 *
 * Each file is a standalone script that asserts as it goes and prints its own
 * summary, so running them is just importing them one after another; the first
 * failing assertion stops the process with a non-zero exit code.
 */

import { readdir } from 'node:fs/promises'

const here = new URL('.', import.meta.url)
const files = (await readdir(here))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

for (const file of files) {
  await import(new URL(file, here))
}

console.log(`\n${files.length} test files passed`)

#!/usr/bin/env node
/**
 * Drift check (#49): confirms that every AuroraCloud data shape this server
 * relies on (src/auroraContract.ts) is still defined the same way in a
 * read-only checkout of Ogard-Labs/auroradocs.
 *
 *   node --import tsx scripts/auroraDrift.mjs --auroradocs ../auroradocs
 *
 * Exits 0 when every entry matches, 1 when any entry drifted (each is named
 * with its auroradocs file), and 2 when the checkout cannot be read. It only
 * reads files; it never writes to either repository.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

const WORD = /[A-Za-z0-9_$]/

/**
 * Whether `needle` appears in `text` as a whole: where it starts or ends with
 * a name or number character, the text beside it must not continue that name
 * or number. So `VERSION = 1` does not match `VERSION = 10`, and `'Done'` stays
 * exact because its quotes end it.
 */
export function containsWhole(text, needle) {
  if (!needle) return false
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const before = at > 0 ? text[at - 1] : ''
    const after = text[at + needle.length] ?? ''
    if (WORD.test(needle[0]) && WORD.test(before)) continue
    if (WORD.test(needle[needle.length - 1]) && WORD.test(after)) continue
    return true
  }
  return false
}

/** Checks each entry against the auroradocs checkout at `root`. Returns the drifted entries with a reason. */
export async function checkDrift(entries, root, read = (file) => readFile(file, 'utf8')) {
  const cache = new Map()
  const drifted = []
  for (const entry of entries) {
    const file = path.join(root, entry.file)
    if (!cache.has(file)) {
      cache.set(file, read(file).then(collapse, (error) => ({ missing: error?.code ?? String(error) })))
    }
    const text = await cache.get(file)
    if (typeof text !== 'string') {
      drifted.push({ entry, reason: `${entry.file} could not be read (${text.missing}); it may have moved` })
    } else if (!containsWhole(text, collapse(entry.source))) {
      drifted.push({ entry, reason: `${entry.file} no longer contains: ${collapse(entry.source)}` })
    }
  }
  return drifted
}

export function formatDrift(drifted) {
  return drifted.map(({ entry, reason }) =>
    `- ${entry.id} (${entry.what}, used by ${entry.usedBy.join(', ')}): ${reason}`).join('\n')
}

async function main(argv) {
  const index = argv.indexOf('--auroradocs')
  const root = index >= 0 ? argv[index + 1] : process.env.AURORADOCS_DIR
  if (!root) {
    console.error('Pass --auroradocs <path to an Ogard-Labs/auroradocs checkout>, or set AURORADOCS_DIR.')
    return 2
  }
  try {
    await readFile(path.join(root, 'package.json'), 'utf8')
  } catch {
    console.error(`${root} is not an auroradocs checkout (no package.json).`)
    return 2
  }
  const { AURORA_CONTRACT } = await import('../src/auroraContract.ts')
  const drifted = await checkDrift(AURORA_CONTRACT, root)
  if (drifted.length === 0) {
    console.log(`AuroraCloud contract: all ${AURORA_CONTRACT.length} entries match auroradocs.`)
    return 0
  }
  console.log(`AuroraCloud drift detected: ${drifted.length} of ${AURORA_CONTRACT.length} entries no longer match auroradocs.`)
  console.log(formatDrift(drifted))
  console.log('\nUpdate src/auroraContract.ts and the code that uses each entry, or fix auroradocs.')
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2))
}

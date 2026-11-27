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
    } else if (!text.includes(collapse(entry.source))) {
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

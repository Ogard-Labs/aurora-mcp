import assert from 'node:assert/strict'
import test from 'node:test'
import { AURORA_CONTRACT, AURORA_ROUTES, auroraRoute, TASK_PROPERTY_KEYS } from './auroraContract.js'
// @ts-expect-error plain JavaScript script without types
import { checkDrift, collapse, containsWhole, formatDrift } from '../scripts/auroraDrift.mjs'

test('every contract entry has a unique id and source text that holds the value the code uses', () => {
  const ids = AURORA_CONTRACT.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const entry of AURORA_CONTRACT) {
    assert.ok(entry.file && !entry.file.startsWith('/'), `${entry.id}: file is relative`)
    assert.ok(entry.usedBy.length > 0, `${entry.id}: names where it is used`)
    assert.ok(collapse(entry.source).includes(collapse(entry.value)), `${entry.id}: source holds ${entry.value}`)
  }
})

test('every task property key and every route is covered by an entry', () => {
  const values = new Set(AURORA_CONTRACT.map((entry) => entry.value))
  for (const key of Object.values(TASK_PROPERTY_KEYS)) assert.ok(values.has(key), key)
  for (const route of Object.values(AURORA_ROUTES)) assert.ok(values.has(route), route)
})

/** A fake auroradocs checkout that holds exactly each entry's source text. */
function fakeCheckout(change?: (file: string, text: string) => string) {
  const files = new Map<string, string>()
  for (const entry of AURORA_CONTRACT) files.set(entry.file, `${files.get(entry.file) ?? ''}\n${entry.source}\n`)
  return async (file: string) => {
    const relative = file.replace(/^\/checkout\//, '')
    const text = files.get(relative)
    if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return change ? change(relative, text) : text
  }
}

test('the drift check passes when auroradocs still holds every entry, whatever the line breaks', async () => {
  const read = fakeCheckout((_file, text) => text.replace(/ /g, '\n  '))
  assert.deepEqual(await checkDrift(AURORA_CONTRACT, '/checkout', read), [])
})

test('the drift check names the entry and the auroradocs file when a value changes', async () => {
  const read = fakeCheckout((file, text) => file === 'packages/core/src/lib/tasks.ts' ? text.replace("'due_date'", "'due_at'") : text)
  const drifted = await checkDrift(AURORA_CONTRACT, '/checkout', read)
  assert.deepEqual(drifted.map((item: { entry: { id: string } }) => item.entry.id), ['task-key-due_date'])
  const message = formatDrift(drifted)
  assert.match(message, /task-key-due_date/)
  assert.match(message, /packages\/core\/src\/lib\/tasks\.ts no longer contains: const DUE_DATE_KEY = 'due_date'/)
})

test('the drift check reports a file that moved', async () => {
  const read = fakeCheckout()
  const moved = async (file: string) => {
    if (file.endsWith('apps/api/src/lib/hiddenObjects.ts')) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return read(file)
  }
  const drifted = await checkDrift(AURORA_CONTRACT, '/checkout', moved)
  assert.deepEqual(drifted.map((item: { entry: { id: string } }) => item.entry.id), ['hidden-object-types-api'])
  assert.match(formatDrift(drifted), /could not be read \(ENOENT\); it may have moved/)
})

test('routes are filled from the contract, and a missing segment is refused', () => {
  assert.equal(auroraRoute('mcpWorkspaces'), '/api/mcp/workspaces')
  assert.equal(auroraRoute('knowledgeObject', { workspaceId: 'ws1', objectId: 'o1' }), '/api/knowledge/workspaces/ws1/objects/o1')
  assert.throws(() => auroraRoute('knowledgeRecent'), /needs workspaceId/)
})

test('a contract value must match whole: a longer number or name beside it is drift (#49 review)', async () => {
  assert.equal(containsWhole('export const TASK_STATUS_CONFIG_VERSION = 10', 'export const TASK_STATUS_CONFIG_VERSION = 1'), false)
  assert.equal(containsWhole('export const TASK_STATUS_CONFIG_VERSION = 1\n', 'export const TASK_STATUS_CONFIG_VERSION = 1'), true)
  assert.equal(containsWhole('const MY_STATUS_KEY = 1; const STATUS_KEY = 2', 'STATUS_KEY = 2'), true)
  assert.equal(containsWhole('const MY_STATUS_KEY = 2', 'STATUS_KEY = 2'), false)
  assert.equal(containsWhole("x = 'Done';", "'Done'"), true)
  const version = AURORA_CONTRACT.find((entry) => /= 1$/.test(collapse(entry.source)))
  assert.ok(version, 'the contract has an entry ending in a number')
  const bumped = async () => collapse(version.source) + '0'
  const drifted = await checkDrift([version], '/checkout', bumped)
  assert.equal(drifted.length, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { AURORA_CONTRACT, AURORA_ROUTES, auroraRoute, TASK_LIST_PROPERTY_KEYS, TASK_PROPERTY_KEYS } from './auroraContract.js'
// @ts-expect-error plain JavaScript script without types
import { checkDrift, collapse, containsWhole, endsLine, formatDrift, stripComments } from '../scripts/auroraDrift.mjs'

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
  for (const key of [...Object.values(TASK_PROPERTY_KEYS), ...Object.values(TASK_LIST_PROPERTY_KEYS)]) assert.ok(values.has(key), key)
  // A project route is checked as its path under the MCP prefix, which has an entry of its own.
  assert.ok(values.has('/api/mcp'))
  for (const route of Object.values(AURORA_ROUTES)) assert.ok(values.has(route) || values.has(route.replace(/^\/api\/mcp/, '')), route)
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
  // Except right after `return`, where a line break would end the statement.
  const read = fakeCheckout((_file, text) => text.replace(/(?<!\breturn) /g, '\n  '))
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

test('a change to how the config id turns digest bytes into characters is drift (#49 review)', async () => {
  const read = fakeCheckout((file, text) => file === 'packages/core/src/lib/workspaceConfigObject.ts'
    ? text.replace('(digest[index] as number) % ID_CHARS.length', '(digest[ID_LENGTH - index] as number) % ID_CHARS.length')
    : text)
  const drifted = await checkDrift(AURORA_CONTRACT, '/checkout', read)
  assert.deepEqual(drifted.map((item: { entry: { id: string } }) => item.entry.id), ['workspace-config-id'])
})


test('a whole-statement value is drift when anything but its line end follows it (#49 review)', async () => {
  const version = AURORA_CONTRACT.find((entry) => entry.id === 'task-status-config-version')
  assert.ok(version?.lineEnd)
  const file = (initializer: string) => async () => `export const TASK_STATUS_CONFIG_VERSION = ${initializer}\n\n/** Next. */\n`
  for (const changed of ['1.1', '1 + 1', '1 * 2', '1n', '10']) {
    assert.equal((await checkDrift([version], '/checkout', file(changed))).length, 1, changed)
  }
  for (const same of ['1', '1;', '1 // the first format']) {
    assert.deepEqual(await checkDrift([version], '/checkout', file(same)), [], same)
  }
  assert.equal(endsLine('VERSION = 1\n', 'VERSION = 1'), true)
  assert.equal(endsLine('MY_VERSION = 1\n', 'VERSION = 1'), false)
})

test('the config id entries hold no comment, so a reworded comment is not drift (#49 review)', async () => {
  for (const entry of AURORA_CONTRACT.filter((item) => item.id.startsWith('workspace-config-id'))) {
    assert.doesNotMatch(entry.source, /\/\*|\/\//, entry.id)
  }
  const read = fakeCheckout((file, text) => file === 'packages/core/src/lib/workspaceConfigObject.ts'
    ? text.replace('const ID_LENGTH = 15', 'const ID_LENGTH = 15\n/** Reworded. */')
    : text)
  assert.deepEqual(await checkDrift(AURORA_CONTRACT, '/checkout', read), [])
  const longer = fakeCheckout((file, text) => file === 'packages/core/src/lib/workspaceConfigObject.ts'
    ? text.replace('const ID_LENGTH = 15', 'const ID_LENGTH = 15 + 1')
    : text)
  assert.deepEqual((await checkDrift(AURORA_CONTRACT, '/checkout', longer)).map((item: { entry: { id: string } }) => item.entry.id), ['workspace-config-id-alphabet'])
})

test('a renamed task list key or members route is drift (#49 review)', async () => {
  for (const [file, from, to, id] of [
    ['packages/core/src/lib/taskListObjects.ts', "'list_id'", "'list_key'", 'task-list-key-list_id'],
    ['packages/core/src/lib/taskListObjects.ts', "'default_status'", "'status_default'", 'task-list-key-default_status'],
    ['packages/core/src/lib/taskListObjects.ts', "position: 'position'", "position: 'order'", 'task-list-key-position'],
    ['apps/api/src/routes/workspaces.ts', '/members', '/people', 'route-workspace-members'],
  ] as const) {
    const read = fakeCheckout((name, text) => name === file ? text.replace(from, to) : text)
    assert.deepEqual((await checkDrift(AURORA_CONTRACT, '/checkout', read)).map((item: { entry: { id: string } }) => item.entry.id), [id], id)
  }
  assert.equal(auroraRoute('workspaceMembers', { workspaceId: 'ws1' }), '/workspaces/ws1/members')
  assert.deepEqual(Object.values(TASK_LIST_PROPERTY_KEYS), ['list_id', 'default_status', 'position'])
})

test('a string constant is drift when its initializer goes on past the old literal (#49 review)', async () => {
  // Every entry that is one `const NAME = '...'` statement must end its line.
  for (const entry of AURORA_CONTRACT.filter((item) => /^(export )?const \w+ = '[^']*'$/.test(collapse(item.source)))) {
    assert.ok(entry.lineEnd, `${entry.id} ends its line`)
  }
  const read = fakeCheckout((file, text) => file === 'packages/core/src/lib/taskListObjects.ts'
    ? text.replace("export const TASK_LIST_ID_KEY = 'list_id'", "export const TASK_LIST_ID_KEY = 'list_id' + '_v2'")
    : text)
  assert.deepEqual((await checkDrift(AURORA_CONTRACT, '/checkout', read)).map((item: { entry: { id: string } }) => item.entry.id), ['task-list-key-list_id'])
})

test('a statement continued on the next line is drift too (#49 review)', () => {
  const needle = "export const TASK_LIST_ID_KEY = 'list_id'"
  for (const next of ["  + '_v2'", '  .toUpperCase()', '  in other', '\n  // why\n  + "_v2"', "  /* why */ + '_v2'", '  ?? fallback']) {
    assert.equal(endsLine(`${needle}\n${next}\n`, needle), false, next)
  }
  for (const next of ['', '/** Next. */\nexport const OTHER = 1', 'const KEY = {', '}', 'export function f() {}']) {
    assert.equal(endsLine(`${needle}\n${next}\n`, needle), true, next)
  }
  // TypeScript never joins `as` or `satisfies` across a line break, and a `;` ends the statement.
  for (const next of ['as()', 'satisfies(x)']) assert.equal(endsLine(`${needle}\n${next}\n`, needle), true, next)
  for (const next of ['[a, b] = pair', '(async () => {})()', "+ 'x'"]) assert.equal(endsLine(`${needle};\n${next}\n`, needle), true, next)
  // A later whole copy still counts when an earlier one is continued.
  assert.equal(endsLine(`${needle}\n+ 'x'\n${needle}\n`, needle), true)
})

test('every entry that is one whole statement must end its line, formulas too (#49 review)', async () => {
  for (const entry of AURORA_CONTRACT.filter((item) => /^(export )?(const|return) /.test(collapse(item.source)) && !/[{,]$/.test(collapse(item.source)))) {
    assert.ok(entry.lineEnd, `${entry.id} ends its line`)
  }
  const successor = AURORA_CONTRACT.find((entry) => entry.id === 'recurrence-successor-id')
  assert.ok(successor)
  const extended = async () => `${successor.source} + ':v2'\n`
  assert.equal((await checkDrift([successor], '/checkout', extended)).length, 1)
  const same = async () => `${successor.source}\n}\n`
  assert.deepEqual(await checkDrift([successor], '/checkout', same), [])
})

test('formatting alone is not drift, and a return split from its value is (#49 review)', async () => {
  const successor = AURORA_CONTRACT.find((entry) => entry.id === 'recurrence-successor-id')
  assert.ok(successor)
  const check = async (text: string) => (await checkDrift([successor], '/checkout', async () => text)).length
  assert.equal(await check(`${successor.source} }\n`), 0, 'closing brace on the same line')
  assert.equal(await check(`${successor.source} /* same id */\n`), 0, 'trailing block comment')
  assert.equal(await check(`${successor.source} /* a */ /* b */ // why\n`), 0, 'several comments')
  assert.equal(await check(`${successor.source} /* x */ + ':v2'\n`), 1, 'suffix after a block comment')
  assert.equal(await check(successor.source.replace('return ', 'return\n  ') + '\n'), 1, 'return on its own line returns nothing')
  const version = 'export const TASK_STATUS_CONFIG_VERSION = 1'
  assert.equal(endsLine(`${version} /* first */;\n`, version), true)
  assert.equal(endsLine(`${version}\n  = 2\n`, version), false)
})


test('the statement end check stays fast on long runs of comment markers (#49 review)', () => {
  const needle = 'export const TASK_STATUS_CONFIG_VERSION = 1'
  const started = Date.now()
  for (const tail of [` /*${'*//*'.repeat(5000)}`, `\n/*${'*//*'.repeat(5000)}`, ` ${'/**/'.repeat(5000)}x`]) endsLine(`${needle}${tail}`, needle)
  assert.ok(Date.now() - started < 1000)
  assert.equal(endsLine(`${needle} /* a */ /* b */\n`, needle), true)
  assert.equal(endsLine(`${needle} /* a */ + 1\n`, needle), false)
})

test('live code between two block comments is drift, and a no-break space after return is not (#49 review)', async () => {
  const successor = AURORA_CONTRACT.find((entry) => entry.id === 'recurrence-successor-id')
  assert.ok(successor)
  const check = async (text: string) => (await checkDrift([successor], '/checkout', async () => text)).length
  assert.equal(await check(`${successor.source} /* hash */ + ':v2' /* id version */\n`), 1)
  assert.equal(await check(successor.source.replace('return ', 'return ') + '\n'), 0)
  assert.equal(await check(successor.source.replace('return ', 'return ') + '\n'), 1)
})

test('a stale copy of a value in a comment is not live code (#49 review)', async () => {
  const version = AURORA_CONTRACT.find((entry) => entry.id === 'task-status-config-version')
  assert.ok(version)
  const stale = `// Old declaration: ${version.source}; version 2 adds a field.\nexport const TASK_STATUS_CONFIG_VERSION = 2\n`
  assert.equal((await checkDrift([version], '/checkout', async () => stale)).length, 1, 'line comment')
  const block = `/*\n${version.source};\n*/\nexport const TASK_STATUS_CONFIG_VERSION = 2\n`
  assert.equal((await checkDrift([version], '/checkout', async () => block)).length, 1, 'block comment')
  const key = AURORA_CONTRACT.find((entry) => entry.id === 'task-key-status')
  assert.ok(key)
  assert.equal((await checkDrift([key], '/checkout', async () => `/** Was: ${key.source} */\nconst STATUS_KEY = 'state'\n`)).length, 1, 'doc comment')
  // Strings are read through: a `//` or `/*` inside one is not a comment.
  assert.equal(stripComments("const url = 'https://x' // note\n"), "const url = 'https://x'        \n")
  assert.equal(stripComments('const a = "/* no */" /* yes */;'), 'const a = "/* no */"          ;')
  assert.equal(stripComments('const t = `a // b` // c'), 'const t = `a // b`     ')
})

test('comment markers inside regular expressions and nested templates are not comments (#49 review)', async () => {
  const version = AURORA_CONTRACT.find((entry) => entry.id === 'task-status-config-version')
  assert.ok(version)
  const check = async (before: string) => (await checkDrift([version], '/checkout', async () => `${before}\n${version.source}\n`)).length
  assert.equal(await check('const separator = /[/*]/'), 0, 'regex class')
  assert.equal(await check('const slashes = /\\/\\*/g'), 0, 'escaped regex')
  assert.equal(await check('const x = a ? /\\/\\// : b'), 0, 'regex after ?')
  assert.equal(await check('const t = `${`/*`}`'), 0, 'nested template')
  assert.equal(await check('const t = `a ${ { b: `/*` }.b } c`'), 0, 'braces inside an interpolation')
  assert.equal(await check('const half = total / 2 /* halved */'), 0, 'division then a real comment')
  assert.equal(stripComments('const r = /a\\/b/ // c'), 'const r = /a\\/b/     ')
  assert.equal(stripComments('x = y / 2 // z'), 'x = y / 2     ')
  assert.equal(stripComments('const t = `${a /* in */}`'), 'const t = `${a         }`')
})

test('a regular expression after a control-flow condition is not a comment (#49 review)', async () => {
  const version = AURORA_CONTRACT.find((entry) => entry.id === 'task-status-config-version')
  assert.ok(version)
  const check = async (before: string) => (await checkDrift([version], '/checkout', async () => `${before}\n${version.source}\n`)).length
  assert.equal(await check('if (input) /[/*]/.test(input)'), 0, 'after if')
  assert.equal(await check('while (f(x)) /[/*]/.exec(x)'), 0, 'after while with a nested call')
  assert.equal(await check('for (const a of b) /[/*]/.test(a)'), 0, 'after for')
  assert.equal(stripComments('const r = (a) / 2 /* c */'), 'const r = (a) / 2        ')
  assert.equal(stripComments('const r = f(a) / g(b) // c'), 'const r = f(a) / g(b)     ')
})

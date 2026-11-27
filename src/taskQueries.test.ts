import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeToolCall } from './tools.js'
import { getAuroraClient, resetAuroraClientForTests } from './auroraClient.js'
import { matchesTaskFilters, toTaskRow, type TaskRow } from './taskQueries.js'
import { withTaskStatusAliases, type TaskStatusDefinition } from './taskStatuses.js'

// #50: list_tasks and get_task read tasks with their fields in a bounded number of requests.

const ENCRYPTED = '__e2ee__{"v":1,"iv":"AAAA","ct":"BBBB"}'

type Task = { id: string; title: string; updated_at: string; props: Record<string, string> }

const TASKS: Task[] = [
  { id: 'task-overdue', title: 'Pay invoice', updated_at: '2026-07-03T10:00:00.000Z', props: { status: 'Todo', due_date: '2026-01-02', priority: 'High', assignee: 'user-1', tags: 'money', task_list_id: 'list-work' } },
  { id: 'task-future', title: 'Plan trip', updated_at: '2026-07-04T10:00:00.000Z', props: { status: 'In Progress', due_date: '2099-05-01T09:30', priority: 'Low', assignee: 'user-2', task_list_id: 'list-home' } },
  { id: 'task-done', title: 'File taxes', updated_at: '2026-07-05T10:00:00.000Z', props: { status: 'Done', due_date: '2026-01-01', assignee: 'user-1' } },
  { id: 'task-nodue', title: 'Read book', updated_at: '2026-07-01T10:00:00.000Z', props: { status: 'Backlog', recurrence: 'FREQ=WEEKLY' } },
  { id: 'task-secret', title: 'Secret', updated_at: '2026-07-02T10:00:00.000Z', props: { status: 'Todo', tags: ENCRYPTED, priority: ENCRYPTED } },
]

function list(items: unknown[]): string {
  return JSON.stringify({ items, totalPages: 1, page: 1, perPage: 50, totalItems: items.length })
}

function objectRecord(task: Task) {
  return {
    id: task.id, workspace_id: 'workspace-1', type: 'task', title: task.title, icon: null, parent_id: null,
    is_deleted: false, is_template: false, created_at: '2026-07-01T09:00:00.000Z', updated_at: task.updated_at,
  }
}

/** Tasks whose due date is stored end-to-end encrypted (as text, the way the app seals it). */
const sealedDueDates = new Set<string>()

function propertyRows(task: Task) {
  const sealed = sealedDueDates.has(task.id)
    ? [{ id: `${task.id}-sealed-due`, object_id: task.id, workspace_id: 'workspace-1', key: 'due_date', value_type: 'text', value_text: ENCRYPTED, value_num: null, value_date: null, value_bool: null, value_ref: null, updated_at: '2026-07-06T10:00:00.000Z' }]
    : []
  return [...sealed, ...Object.entries(task.props).map(([key, value], index) => ({
    id: `${task.id}-p${index}`, object_id: task.id, workspace_id: 'workspace-1', key,
    value_type: key === 'due_date' ? 'date' : 'text', value_text: key === 'due_date' ? null : value,
    value_num: null, value_date: key === 'due_date' ? value : null, value_bool: null, value_ref: null,
    updated_at: '2026-07-06T10:00:00.000Z',
  }))]
}

const TASK_LIST_OBJECTS = [
  { id: 'list-obj-work', workspace_id: 'workspace-1', type: 'task_list', title: 'Work', icon: null, parent_id: null, is_deleted: false, is_template: false, created_at: '2026-07-01T09:00:00.000Z', updated_at: '2026-07-01T09:00:00.000Z' },
  { id: 'list-obj-home', workspace_id: 'workspace-1', type: 'task_list', title: 'Home', icon: null, parent_id: null, is_deleted: false, is_template: false, created_at: '2026-07-01T09:01:00.000Z', updated_at: '2026-07-01T09:01:00.000Z' },
]
const LIST_ID_PROPS = [
  { id: 'lp-1', object_id: 'list-obj-work', workspace_id: 'workspace-1', key: 'list_id', value_type: 'text', value_text: 'list-work', value_num: null, value_date: null, value_bool: null, value_ref: null },
  { id: 'lp-2', object_id: 'list-obj-home', workspace_id: 'workspace-1', key: 'list_id', value_type: 'text', value_text: 'list-home', value_num: null, value_date: null, value_bool: null, value_ref: null },
]

/** Rows in the retired task_lists table (served only while non-empty; otherwise the table is gone). */
const LEGACY_LISTS: Array<{ id: string; name: string; default_status: string | null }> = []

const MEMBERS = [
  { userId: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'owner' },
  { userId: 'user-2', name: 'Grace Hopper', email: 'grace@example.com', role: 'editor' },
]

function handler(requests: string[]) {
  return (req: IncomingMessage, res: ServerResponse<IncomingMessage>, url: URL) => {
    requests.push(`${req.method} ${url.pathname}`)
    const filter = url.searchParams.get('filter') ?? ''
    if (url.pathname.endsWith('/workspaces/workspace-1/members')) {
      res.end(JSON.stringify({ members: MEMBERS }))
      return
    }
    if (url.pathname.endsWith('/auth/me')) {
      res.end(JSON.stringify({ user: { id: 'user-1' } }))
      return
    }
    if (url.pathname === '/api/collections/objects/records') {
      res.end(list(filter.includes('"task_list"') ? TASK_LIST_OBJECTS : TASKS.map(objectRecord)))
      return
    }
    const one = /^\/api\/collections\/objects\/records\/(.+)$/.exec(url.pathname)
    if (one) {
      const task = TASKS.find((entry) => entry.id === one[1])
      if (!task) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return }
      res.end(JSON.stringify(objectRecord(task)))
      return
    }
    if (url.pathname === '/api/collections/object_properties/records') {
      if (filter.includes('list-obj-')) { res.end(list(LIST_ID_PROPS)); return }
      res.end(list(TASKS.filter((task) => filter.includes(`"${task.id}"`)).flatMap(propertyRows)))
      return
    }
    if (url.pathname === '/api/collections/task_lists/records') {
      if (LEGACY_LISTS.length) { res.end(list(LEGACY_LISTS)); return }
      res.statusCode = 410
      res.end(JSON.stringify({ error: 'gone' }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  }
}

async function withFake(run: (requests: string[]) => Promise<void>): Promise<void> {
  const previous = process.env['AURORA_API_URL']
  const requests: string[] = []
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    handler(requests)(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    process.env['AURORA_API_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    resetAuroraClientForTests()
    await run(requests)
  } finally {
    if (previous === undefined) delete process.env['AURORA_API_URL']
    else process.env['AURORA_API_URL'] = previous
    resetAuroraClientForTests()
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

type Rows = { type: string; tasks: Array<Record<string, unknown>>; next_cursor: string | null; total: number; note?: string }

async function listTasks(input: Record<string, unknown>): Promise<Rows> {
  return await executeToolCall('list_tasks', input, 'workspace-1') as unknown as Rows
}

const ids = (rows: Rows) => rows.tasks.map((task) => task['id'])

test('list_tasks leaves completed tasks out by default and sorts by due date, undated last', async () => {
  await withFake(async () => {
    const rows = await listTasks({})
    assert.equal(rows.type, 'tasks')
    assert.deepEqual(ids(rows), ['task-overdue', 'task-future', 'task-nodue', 'task-secret'])
    assert.equal(rows.total, 4)
    assert.equal(rows.next_cursor, null)
  })
})

test('list_tasks rows carry resolved list and assignee names', async () => {
  await withFake(async () => {
    const [row] = (await listTasks({ label: 'MONEY' })).tasks
    assert.deepEqual(row, {
      id: 'task-overdue', title: 'Pay invoice', status: 'Todo', status_group: 'todo', due_date: '2026-01-02', priority: 'High',
      task_list: { id: 'list-work', name: 'Work' }, assignees: [{ id: 'user-1', name: 'Ada Lovelace' }], labels: ['money'],
      recurring: false, updated_at: '2026-07-03T10:00:00.000Z',
    })
  })
})

test('list_tasks filters by status group, list, assignee, due dates and recurrence', async () => {
  await withFake(async () => {
    assert.deepEqual(ids(await listTasks({ status_group: 'done' })), ['task-done'], 'asking for the done group includes completed tasks')
    assert.deepEqual(ids(await listTasks({ status: 'done' })), ['task-done'])
    assert.deepEqual(ids(await listTasks({ task_list: 'home' })), ['task-future'])
    // The credential acts as user-1 (its token is checked with /auth/me).
    getAuroraClient().authStore.save('token', null)
    assert.deepEqual(ids(await listTasks({ assignee: 'me', include_completed: true })), ['task-done', 'task-overdue'])
    assert.deepEqual(ids(await listTasks({ assignee: 'grace@example.com' })), ['task-future'])
    assert.deepEqual(ids(await listTasks({ overdue: true })), ['task-overdue'], 'a completed task is never overdue')
    assert.deepEqual(ids(await listTasks({ due_after: '2099-05-01' })), ['task-future'], 'a due time does not move the day')
    assert.deepEqual(ids(await listTasks({ due_before: '2026-06-01', include_completed: true })), ['task-done', 'task-overdue'])
    assert.deepEqual(ids(await listTasks({ has_due_date: false })), ['task-nodue', 'task-secret'])
    assert.deepEqual(ids(await listTasks({ recurring: true })), ['task-nodue'])
  })
})

test('list_tasks withholds encrypted values and never matches them', async () => {
  await withFake(async () => {
    const rows = await listTasks({ status: 'Todo', sort: 'updated_at' })
    assert.deepEqual(ids(rows), ['task-overdue', 'task-secret'])
    const secret = rows.tasks[1]!
    assert.equal(secret['priority'], null)
    assert.deepEqual(secret['labels'], [])
    assert.deepEqual(secret['encrypted_fields'], ['priority', 'labels'])
    assert.match(rows.note ?? '', /end-to-end encrypted/)
    assert.equal(JSON.stringify(rows).includes('__e2ee__'), false)
  })
})

test('list_tasks pages with a stable cursor tied to its query', async () => {
  await withFake(async () => {
    const first = await listTasks({ limit: 2, sort: 'priority' })
    assert.deepEqual(ids(first), ['task-overdue', 'task-future'])
    assert.ok(first.next_cursor)
    const second = await listTasks({ limit: 2, sort: 'priority', cursor: first.next_cursor })
    assert.deepEqual(ids(second), ['task-nodue', 'task-secret'])
    assert.equal(second.next_cursor, null)
    const other = await executeToolCall('list_tasks', { limit: 2, sort: 'due_date', cursor: first.next_cursor }, 'workspace-1') as unknown as Record<string, unknown>
    assert.equal(other['code'], 'invalid_input', 'a cursor from another query is refused')
  })
})

test('list_tasks makes the same number of requests whatever the page size', async () => {
  let small = 0
  let large = 0
  await withFake(async (requests) => { await listTasks({ limit: 1 }); small = requests.length })
  await withFake(async (requests) => { await listTasks({ limit: 100 }); large = requests.length })
  assert.equal(small, large)
  assert.ok(small <= 8, `bounded: ${small} requests`)
})

test('list_tasks rejects bad filters before reading anything', async () => {
  await withFake(async (requests) => {
    for (const input of [{ status_group: 'later' }, { due_before: '2026-02-31' }, { sort: 'title' }, { overdue: 'yes' }, { limit: 0 }]) {
      const result = await executeToolCall('list_tasks', input, 'workspace-1') as unknown as Record<string, unknown>
      assert.equal(result['code'], 'invalid_input', JSON.stringify(input))
    }
    assert.equal(requests.filter((request) => request.includes('/collections/')).length, 0)
  })
})

test('get_task returns every field and the next occurrence of a repeating task', async () => {
  await withFake(async () => {
    const result = await executeToolCall('get_task', { id: 'task-nodue' }, 'workspace-1') as unknown as { type: string; task: Record<string, unknown> }
    assert.equal(result.type, 'task')
    assert.equal(result.task['recurring'], true)
    assert.equal(result.task['recurrence'], 'FREQ=WEEKLY')
    assert.equal(result.task['description'], null)
    const next = result.task['next_occurrence'] as { id: string; due_date: string }
    assert.match(next.due_date, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(next.id.length, 15)
    // #51: the revision for update_task's expected_updated_at, as get_object's: the later of the row and its properties.
    assert.equal(result.task['updated_at'], '2026-07-06T10:00:00.000Z')
  })
})

test('get_task refuses an object that is not a task', async () => {
  await withFake(async () => {
    const result = await executeToolCall('get_task', { id: 'missing' }, 'workspace-1') as unknown as Record<string, unknown>
    assert.equal(result['code'], 'not_found')
  })
})

const ROW: TaskRow = {
  id: 'task-x', title: 'X', status: 'Todo', status_group: 'todo', due_date: null, priority: null,
  task_list: null, assignees: [], labels: [], recurring: false, updated_at: null,
}

test('a status filter finds tasks that still store a renamed status under its old name', () => {
  const statuses: TaskStatusDefinition[] = withTaskStatusAliases(
    [{ id: 'Todo', group: 'todo' }, { id: 'Shipped', group: 'done' }],
    { Done: 'Shipped' },
  )
  const row = { ...ROW, status: 'Done', status_group: 'done' as const }
  const filters = { statuses: new Set(['Shipped']), includeCompleted: false, today: '2026-07-10' }
  assert.equal(matchesTaskFilters(row, filters, statuses), true)
})

test('an encrypted due date matches no due-date filter, not even has_due_date false or overdue false', () => {
  const row = { ...ROW, encrypted_fields: ['due_date'] }
  const base = { includeCompleted: false, today: '2026-07-10' }
  for (const extra of [{ hasDueDate: false }, { hasDueDate: true }, { overdue: false }, { overdue: true }, { dueBefore: '2099-01-01' }, { dueAfter: '2000-01-01' }]) {
    assert.equal(matchesTaskFilters(row, { ...base, ...extra }, []), false, JSON.stringify(extra))
  }
  assert.equal(matchesTaskFilters(row, base, []), true, 'without a due-date filter the task is still listed')
})

test('a task with no status is in the to-do group, and an encrypted status is in none', async () => {
  const { toTaskRow } = await import('./taskQueries.js')
  const context = { statuses: [{ id: 'Todo', group: 'todo' as const }], lists: [], members: [] }
  const bare = toTaskRow({ id: 't1', title: 'Send invoice', updated_at: null, status: null, due_date: null, priority: null, assignees: [], labels: [], description: null, task_list_id: null, recurrence: null } as never, context)
  assert.equal(bare.status_group, 'todo')
  assert.equal(matchesTaskFilters(bare, { statusGroup: 'todo', includeCompleted: false, today: '2026-07-10' }, context.statuses), true)
  const sealed = toTaskRow({ id: 't2', title: 'Secret', updated_at: null, status: ENCRYPTED, due_date: null, priority: null, assignees: [], labels: [], description: null, task_list_id: null, recurrence: null } as never, context)
  assert.equal(sealed.status_group, null)
})

test('a past-due task with an encrypted status matches neither overdue true nor overdue false', () => {
  const row = { ...ROW, status: null, status_group: null, due_date: '2026-07-01', encrypted_fields: ['status'] }
  const base = { includeCompleted: false, today: '2026-07-10' }
  assert.equal(matchesTaskFilters(row, { ...base, overdue: true }, []), false)
  assert.equal(matchesTaskFilters(row, { ...base, overdue: false }, []), false)
  const future = { ...row, due_date: '2099-01-01' }
  assert.equal(matchesTaskFilters(future, { ...base, overdue: false }, []), true, 'a future due date is not overdue whatever the status')
})

test('assignee "me" with an MCP client credential is refused plainly, without calling /auth/me', async () => {
  await withFake(async (requests) => {
    getAuroraClient().authStore.save('aur_mcp_client_test', null)
    const result = await executeToolCall('list_tasks', { assignee: 'me' }, 'workspace-1') as unknown as Record<string, unknown>
    assert.equal(result['code'], 'invalid_input', JSON.stringify(result))
    assert.match(String(result['message']), /list_workspace_members/)
    assert.equal(requests.some((request) => request.endsWith('/auth/me')), false)
  })
})

test('get_task on a completed repeating task names the occurrence its completion created', async () => {
  const marker = JSON.stringify({ id: 'task-chain-next', date: '2026-10-12', rule: 'FREQ=DAILY', fp: null, state: 'live' })
  const added: Task[] = [
    { id: 'task-chain-done', title: 'Water plants', updated_at: '2026-10-11T10:00:00.000Z', props: { status: 'Done', due_date: '2026-10-11', recurrence_next: marker } },
    { id: 'task-chain-next', title: 'Water plants', updated_at: '2026-10-11T10:00:01.000Z', props: { status: 'Todo', due_date: '2026-10-12' } },
  ]
  TASKS.push(...added)
  try {
    await withFake(async () => {
      const result = await executeToolCall('get_task', { id: 'task-chain-done' }, 'workspace-1') as unknown as { task: Record<string, unknown> }
      assert.deepEqual(result.task['next_occurrence'], { id: 'task-chain-next', due_date: '2026-10-12' })
      // Completion moved the rule into the marker: the task is still part of a series.
      assert.equal(result.task['recurring'], true)
      assert.equal(result.task['recurrence'], 'FREQ=DAILY')
      const repeating = ids(await listTasks({ recurring: true, include_completed: true }))
      assert.ok(repeating.includes('task-chain-done'), JSON.stringify(repeating))
      assert.equal(ids(await listTasks({ recurring: false, include_completed: true })).includes('task-chain-done'), false)
    })
  } finally {
    TASKS.splice(TASKS.length - added.length, added.length)
  }
})

test('get_task gives no forecast when the due date or status it depends on is encrypted', async () => {
  const added: Task[] = [
    { id: 'task-sealed-due', title: 'Rent', updated_at: '2026-07-01T10:00:00.000Z', props: { status: 'Todo', recurrence: 'FREQ=MONTHLY' } },
    { id: 'task-sealed-status', title: 'Rent', updated_at: '2026-07-01T10:00:00.000Z', props: { status: ENCRYPTED, due_date: '2026-07-01', recurrence: 'FREQ=MONTHLY' } },
  ]
  TASKS.push(...added)
  sealedDueDates.add('task-sealed-due')
  try {
    await withFake(async () => {
      for (const id of ['task-sealed-due', 'task-sealed-status']) {
        const result = await executeToolCall('get_task', { id }, 'workspace-1') as unknown as { task: Record<string, unknown> }
        assert.equal(result.task['next_occurrence'], null, id)
        assert.equal(result.task['recurrence'], 'FREQ=MONTHLY')
      }
    })
  } finally {
    TASKS.splice(TASKS.length - added.length, added.length)
    sealedDueDates.clear()
  }
})

test('an undone marker or a reopened task is not recurring, and a sealed marker or status makes it unknown', () => {
  const statuses: TaskStatusDefinition[] = [{ id: 'Done', group: 'done' }, { id: 'Todo', group: 'todo' }]
  const context = { statuses, lists: [], members: [] }
  const base = { id: 't', title: 'x', updated_at: null, status: 'Done', due_date: null, priority: null, assignees: [], labels: [], description: null, task_list_id: null, recurrence: null }
  const undone = toTaskRow({ ...base, recurrence_next: JSON.stringify({ id: 'n', state: 'undone' }) } as never, context)
  assert.equal(undone.recurring, false)
  const sealed = toTaskRow({ ...base, recurrence_next: ENCRYPTED } as never, context)
  assert.deepEqual(sealed.encrypted_fields, ['recurrence_next'])
  assert.equal(sealed.recurring, null, 'unknown, not a one-off')
  const live = JSON.stringify({ id: 'n', rule: 'FREQ=DAILY', state: 'live' })
  // Reopened after completion: completing it again makes no occurrence, so it no longer repeats.
  const reopened = toTaskRow({ ...base, status: 'Todo', recurrence_next: live } as never, context)
  assert.equal(reopened.recurring, false)
  assert.equal(matchesTaskFilters(reopened, { includeCompleted: true, today: '2026-07-01', recurring: true }, statuses), false)
  // A live marker with an encrypted status cannot say whether the task is done.
  const hidden = toTaskRow({ ...base, status: ENCRYPTED, recurrence_next: live } as never, context)
  assert.equal(hidden.recurring, null)
  // Reopened with a sealed marker: the readable open status already says it does not repeat.
  const reopenedSealed = toTaskRow({ ...base, status: 'Todo', recurrence_next: ENCRYPTED } as never, context)
  assert.equal(reopenedSealed.recurring, false)
  const filters = { includeCompleted: true, today: '2026-07-01' }
  assert.equal(matchesTaskFilters(sealed, { ...filters, recurring: false }, statuses), false)
  assert.equal(matchesTaskFilters(sealed, { ...filters, recurring: true }, statuses), false)
  assert.equal(matchesTaskFilters(sealed, filters, statuses), true)
})

test('a list whose name is encrypted can be filtered by its exact id, never by a guess', async () => {
  TASK_LIST_OBJECTS.push({ id: 'list-obj-sealed', workspace_id: 'workspace-1', type: 'task_list', title: ENCRYPTED, icon: null, parent_id: null, is_deleted: false, is_template: false, created_at: '2026-07-01T09:02:00.000Z', updated_at: '2026-07-01T09:02:00.000Z' })
  LIST_ID_PROPS.push({ id: 'lp-3', object_id: 'list-obj-sealed', workspace_id: 'workspace-1', key: 'list_id', value_type: 'text', value_text: 'list-sealed', value_num: null, value_date: null, value_bool: null, value_ref: null })
  TASKS.push({ id: 'task-in-sealed', title: 'Hidden list task', updated_at: '2026-07-01T10:00:00.000Z', props: { status: 'Todo', task_list_id: 'list-sealed' } })
  try {
    await withFake(async () => {
      assert.deepEqual(ids(await listTasks({ task_list: 'list-sealed' })), ['task-in-sealed'])
      // A readable list whose name merely contains the id does not outrank it.
      TASK_LIST_OBJECTS.push({ id: 'list-obj-decoy', workspace_id: 'workspace-1', type: 'task_list', title: 'Old list-sealed notes', icon: null, parent_id: null, is_deleted: false, is_template: false, created_at: '2026-07-01T09:04:00.000Z', updated_at: '2026-07-01T09:04:00.000Z' })
      LIST_ID_PROPS.push({ id: 'lp-5', object_id: 'list-obj-decoy', workspace_id: 'workspace-1', key: 'list_id', value_type: 'text', value_text: 'list-decoy', value_num: null, value_date: null, value_bool: null, value_ref: null })
      assert.deepEqual(ids(await listTasks({ task_list: 'list-sealed' })), ['task-in-sealed'])
      TASK_LIST_OBJECTS.pop()
      LIST_ID_PROPS.pop()
      // The same for an unconverted list in the legacy table, and its name stays hidden.
      LEGACY_LISTS.push({ id: 'list-old', name: ENCRYPTED, default_status: null })
      TASKS.push({ id: 'task-in-old', title: 'Old list task', updated_at: '2026-07-01T10:00:00.000Z', props: { status: 'Todo', task_list_id: 'list-old' } })
      const old = await listTasks({ task_list: 'list-old' })
      assert.deepEqual(ids(old), ['task-in-old'])
      assert.deepEqual(old.tasks[0]?.['task_list'], { id: 'list-old', name: null })
      const guess = await listTasks({ task_list: 'list-seal' }) as unknown as Record<string, unknown>
      assert.equal(guess['code'], 'invalid_input', JSON.stringify(guess))
      assert.match(String(guess['message']), /exact id/)
    })
  } finally {
    TASK_LIST_OBJECTS.pop()
    LIST_ID_PROPS.pop()
    if (TASKS.at(-1)?.id === 'task-in-old') TASKS.pop()
    TASKS.pop()
    LEGACY_LISTS.length = 0
  }
})

test('an exact name two lists or two members share is refused, not silently given to the first', async () => {
  TASK_LIST_OBJECTS.push({ id: 'list-obj-work-2', workspace_id: 'workspace-1', type: 'task_list', title: 'Work', icon: null, parent_id: null, is_deleted: false, is_template: false, created_at: '2026-07-01T09:03:00.000Z', updated_at: '2026-07-01T09:03:00.000Z' })
  LIST_ID_PROPS.push({ id: 'lp-4', object_id: 'list-obj-work-2', workspace_id: 'workspace-1', key: 'list_id', value_type: 'text', value_text: 'list-work-2', value_num: null, value_date: null, value_bool: null, value_ref: null })
  MEMBERS.push({ userId: 'user-3', name: 'Ada Lovelace', email: 'ada.l@example.org', role: 'editor' })
  try {
    await withFake(async () => {
      const list = await listTasks({ task_list: 'work' }) as unknown as Record<string, unknown>
      assert.equal(list['code'], 'invalid_input', JSON.stringify(list))
      assert.match(String(list['message']), /2 task lists are named/)
      assert.deepEqual(ids(await listTasks({ task_list: 'list-work' })), ['task-overdue'], 'the id still picks one')
      const member = await listTasks({ assignee: 'Ada Lovelace' }) as unknown as Record<string, unknown>
      assert.equal(member['code'], 'invalid_input', JSON.stringify(member))
      assert.match(String(member['message']), /2 workspace members match/)
      assert.deepEqual(ids(await listTasks({ assignee: 'ada@example.com' })), ['task-overdue'], 'the email still picks one')
    })
  } finally {
    TASK_LIST_OBJECTS.pop()
    LIST_ID_PROPS.pop()
    MEMBERS.pop()
  }
})

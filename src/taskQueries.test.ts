import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeToolCall } from './tools.js'
import { getAuroraClient, resetAuroraClientForTests } from './auroraClient.js'

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

function propertyRows(task: Task) {
  return Object.entries(task.props).map(([key, value], index) => ({
    id: `${task.id}-p${index}`, object_id: task.id, workspace_id: 'workspace-1', key,
    value_type: key === 'due_date' ? 'date' : 'text', value_text: key === 'due_date' ? null : value,
    value_num: null, value_date: key === 'due_date' ? value : null, value_bool: null, value_ref: null,
  }))
}

const TASK_LIST_OBJECTS = [
  { id: 'list-obj-work', workspace_id: 'workspace-1', type: 'task_list', title: 'Work', icon: null, parent_id: null, is_deleted: false, is_template: false, created_at: '2026-07-01T09:00:00.000Z', updated_at: '2026-07-01T09:00:00.000Z' },
  { id: 'list-obj-home', workspace_id: 'workspace-1', type: 'task_list', title: 'Home', icon: null, parent_id: null, is_deleted: false, is_template: false, created_at: '2026-07-01T09:01:00.000Z', updated_at: '2026-07-01T09:01:00.000Z' },
]
const LIST_ID_PROPS = [
  { id: 'lp-1', object_id: 'list-obj-work', workspace_id: 'workspace-1', key: 'list_id', value_type: 'text', value_text: 'list-work', value_num: null, value_date: null, value_bool: null, value_ref: null },
  { id: 'lp-2', object_id: 'list-obj-home', workspace_id: 'workspace-1', key: 'list_id', value_type: 'text', value_text: 'list-home', value_num: null, value_date: null, value_bool: null, value_ref: null },
]

function handler(requests: string[]) {
  return (req: IncomingMessage, res: ServerResponse<IncomingMessage>, url: URL) => {
    requests.push(`${req.method} ${url.pathname}`)
    const filter = url.searchParams.get('filter') ?? ''
    if (url.pathname.endsWith('/workspaces/workspace-1/members')) {
      res.end(JSON.stringify({ members: [
        { userId: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'owner' },
        { userId: 'user-2', name: 'Grace Hopper', email: 'grace@example.com', role: 'editor' },
      ] }))
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
  })
})

test('get_task refuses an object that is not a task', async () => {
  await withFake(async () => {
    const result = await executeToolCall('get_task', { id: 'missing' }, 'workspace-1') as unknown as Record<string, unknown>
    assert.equal(result['code'], 'not_found')
  })
})

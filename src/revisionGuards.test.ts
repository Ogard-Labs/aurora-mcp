import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeToolCall } from './tools.js'
import { resetAuroraClientForTests } from './auroraClient.js'

// #51: `expected_updated_at` refuses a write over a changed object, writes carry
// `_expected_record`, and `dry_run` writes nothing.

const OBJECT_UPDATED_AT = '2026-07-01T12:00:00.000Z'
const PROPERTY_UPDATED_AT = '2026-07-01T12:30:00.000Z'
const CONTENT_UPDATED_AT = '2026-07-01T11:00:00.000Z'

type Write = { method: string; path: string; body: Record<string, unknown> }

type FakeState = {
  objectUpdatedAt: string
  propertyUpdatedAt: string
  objectType?: string
  /** Answer the next write with AuroraCloud's 409 for a changed record. */
  conflictOnWrite?: boolean
  /** Answer only this write (counted from 1) with the 409. */
  conflictOnWriteNumber?: number
  extraProperties?: Record<string, unknown>[]
  contentJson?: Record<string, unknown>
  writes: Write[]
}

function list(items: unknown[]): string {
  return JSON.stringify({ items, totalPages: 1, page: 1, perPage: 50, totalItems: items.length })
}

function handler(state: FakeState) {
  return (req: IncomingMessage, res: ServerResponse<IncomingMessage>, url: URL) => {
    if (req.method === 'GET' && url.pathname === '/api/collections/objects/records/obj-1') {
      res.end(JSON.stringify({
        id: 'obj-1', workspace_id: 'workspace-1', type: state.objectType ?? 'page', title: 'Original', icon: null, parent_id: null,
        is_deleted: false, is_template: false, created_at: '2026-07-01T10:00:00.000Z', updated_at: state.objectUpdatedAt,
      }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/collections/object_properties/records') {
      res.end(list([{
        id: 'prop-1', object_id: 'obj-1', workspace_id: 'workspace-1', key: 'Stage', value_type: 'text',
        value_text: 'Draft', value_num: null, value_date: null, value_bool: null, value_ref: null,
        updated_at: state.propertyUpdatedAt,
      }, ...(state.extraProperties ?? [])]))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/collections/content/records') {
      res.end(list([{
        id: 'content-1', object_id: 'obj-1', workspace_id: 'workspace-1', updated_at: CONTENT_UPDATED_AT,
        content_json: state.contentJson ?? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old line' }] }] },
      }]))
      return
    }
    if (req.method === 'PATCH' || req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += String(chunk) })
      req.on('end', () => {
        state.writes.push({ method: req.method ?? '', path: url.pathname, body: JSON.parse(body) as Record<string, unknown> })
        if (state.conflictOnWrite || state.conflictOnWriteNumber === state.writes.length) {
          res.statusCode = 409
          res.end(JSON.stringify({ message: 'The record changed on AuroraCloud; refresh before retrying this write.' }))
          return
        }
        res.end(JSON.stringify({ id: 'written' }))
      })
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  }
}

async function withFake(state: FakeState, run: () => Promise<void>): Promise<void> {
  const previous = process.env['AURORA_API_URL']
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    handler(state)(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    process.env['AURORA_API_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    resetAuroraClientForTests()
    await run()
  } finally {
    if (previous === undefined) delete process.env['AURORA_API_URL']
    else process.env['AURORA_API_URL'] = previous
    resetAuroraClientForTests()
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

function freshState(): FakeState {
  return { objectUpdatedAt: OBJECT_UPDATED_AT, propertyUpdatedAt: PROPERTY_UPDATED_AT, writes: [] }
}

test('get_object returns the latest of the object and property times as updated_at', async () => {
  const state = freshState()
  await withFake(state, async () => {
    const result = await executeToolCall('get_object', { id: 'obj-1' }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['type'], 'object')
    assert.equal(result['updated_at'], PROPERTY_UPDATED_AT)
  })
})

for (const [tool, input] of [
  ['set_content', { id: 'obj-1', text: 'New line' }],
  ['update_object', { id: 'obj-1', title: 'New title', text: 'New line' }],
  ['set_property', { object_id: 'obj-1', key: 'Stage', value_type: 'text', value: 'Done' }],
  ['update_task', { id: 'obj-1', title: 'New title' }],
] as const) {
  test(`${tool} with a stale expected_updated_at returns conflict and writes nothing`, async () => {
    const state = { ...freshState(), objectType: tool === 'update_task' ? 'task' : 'page' }
    await withFake(state, async () => {
      const result = await executeToolCall(tool, { ...input, expected_updated_at: '2026-07-01T09:00:00.000Z' }, 'workspace-1') as Record<string, unknown>
      assert.equal(result['type'], 'error')
      assert.equal(result['code'], 'conflict')
      assert.equal(result['retryable'], false)
      assert.equal(result['current_updated_at'], PROPERTY_UPDATED_AT)
      assert.deepEqual(state.writes, [])
    })
  })
}

test('set_content with a matching expected_updated_at writes over the content row it read', async () => {
  const state = freshState()
  await withFake(state, async () => {
    const result = await executeToolCall('set_content', { id: 'obj-1', text: 'New line', expected_updated_at: PROPERTY_UPDATED_AT }, 'workspace-1')
    assert.equal(result.type, 'content_set')
    assert.equal(state.writes.length, 1)
    assert.equal(state.writes[0].path, '/api/collections/content/records/content-1')
    assert.deepEqual(state.writes[0].body['_expected_record'], { updated_at: CONTENT_UPDATED_AT })
  })
})

test('update_object with a matching expected_updated_at guards both the title and the content write', async () => {
  const state = freshState()
  await withFake(state, async () => {
    const result = await executeToolCall('update_object', {
      id: 'obj-1', title: 'New title', text: 'New line', expected_updated_at: PROPERTY_UPDATED_AT,
    }, 'workspace-1')
    assert.equal(result.type, 'object_updated')
    assert.deepEqual(state.writes.map((w) => [w.path, w.body['_expected_record']]), [
      ['/api/collections/objects/records/obj-1', { updated_at: OBJECT_UPDATED_AT }],
      ['/api/collections/content/records/content-1', { updated_at: CONTENT_UPDATED_AT }],
    ])
  })
})

test('set_property with a matching expected_updated_at writes over the property row it read', async () => {
  const state = freshState()
  await withFake(state, async () => {
    const result = await executeToolCall('set_property', {
      object_id: 'obj-1', key: 'Stage', value_type: 'text', value: 'Done', expected_updated_at: PROPERTY_UPDATED_AT,
    }, 'workspace-1')
    assert.equal(result.type, 'property_set')
    assert.equal(state.writes.length, 1)
    assert.equal(state.writes[0].path, '/api/collections/object_properties/records/prop-1')
    assert.deepEqual(state.writes[0].body['_expected_record'], { updated_at: PROPERTY_UPDATED_AT })
  })
})

test('a 409 from AuroraCloud on a guarded write becomes a conflict error', async () => {
  const state = { ...freshState(), conflictOnWrite: true }
  await withFake(state, async () => {
    const result = await executeToolCall('set_content', { id: 'obj-1', text: 'New line', expected_updated_at: PROPERTY_UPDATED_AT }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['type'], 'error')
    assert.equal(result['code'], 'conflict')
    assert.match(String(result['message']), /changed on AuroraCloud/)
  })
})

test('a write without expected_updated_at keeps the old unguarded behaviour', async () => {
  const state = freshState()
  await withFake(state, async () => {
    const result = await executeToolCall('set_content', { id: 'obj-1', text: 'New line' }, 'workspace-1')
    assert.equal(result.type, 'content_set')
    assert.equal(state.writes.length, 1)
    assert.equal('_expected_record' in state.writes[0].body, false)
  })
})

test('an expected_updated_at that is not a time is invalid input', async () => {
  const state = freshState()
  await withFake(state, async () => {
    const result = await executeToolCall('set_content', { id: 'obj-1', text: 'New line', expected_updated_at: 'yesterday' }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['code'], 'invalid_input')
    assert.deepEqual(state.writes, [])
  })
})

test('set_content dry_run summarises the replacement and writes nothing', async () => {
  const state = freshState()
  await withFake(state, async () => {
    const result = await executeToolCall('set_content', { id: 'obj-1', text: 'New line\nSecond', dry_run: true }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['type'], 'dry_run')
    const content = result['content'] as Record<string, unknown>
    assert.equal(content['old_blocks'], 1)
    assert.equal(content['new_blocks'], 2)
    assert.deepEqual((content['first_changed_lines'] as unknown[])[0], { line: 1, old: 'Old line', new: 'New line' })
    assert.deepEqual(state.writes, [])
  })
})

test('update_object dry_run shows the title change and writes nothing', async () => {
  const state = freshState()
  await withFake(state, async () => {
    const result = await executeToolCall('update_object', {
      id: 'obj-1', title: 'New title', text: 'New line', dry_run: true, expected_updated_at: PROPERTY_UPDATED_AT,
    }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['type'], 'dry_run')
    assert.deepEqual(result['title'], { old: 'Original', new: 'New title' })
    assert.deepEqual(state.writes, [])
  })
})

test('update_task with a matching expected_updated_at guards its title write', async () => {
  const state = { ...freshState(), objectType: 'task' }
  await withFake(state, async () => {
    const result = await executeToolCall('update_task', { id: 'obj-1', title: 'New title', expected_updated_at: PROPERTY_UPDATED_AT }, 'workspace-1')
    assert.equal(result.type, 'task_updated')
    const titleWrite = state.writes.find((w) => w.path === '/api/collections/objects/records/obj-1')
    assert.deepEqual(titleWrite?.body['_expected_record'], { updated_at: OBJECT_UPDATED_AT })
  })
})

test('a conflict partway through update_object names what was already saved, with the revision now', async () => {
  const state = { ...freshState(), conflictOnWriteNumber: 2 }
  await withFake(state, async () => {
    const result = await executeToolCall('update_object', {
      id: 'obj-1', title: 'New title', text: 'New line', expected_updated_at: PROPERTY_UPDATED_AT,
    }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['code'], 'conflict')
    assert.deepEqual(result['saved_fields'], ['title'])
    assert.equal(result['current_updated_at'], PROPERTY_UPDATED_AT)
    assert.match(String(result['message']), /already saved before the conflict: title/)
  })
})

test('a conflict on the only write still carries the revision now', async () => {
  const state = { ...freshState(), conflictOnWrite: true }
  await withFake(state, async () => {
    const result = await executeToolCall('set_content', { id: 'obj-1', text: 'New line', expected_updated_at: PROPERTY_UPDATED_AT }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['code'], 'conflict')
    assert.equal(result['current_updated_at'], PROPERTY_UPDATED_AT)
    assert.equal('saved_fields' in result, false)
  })
})

const PRIORITY_ROW = {
  id: 'prop-priority', object_id: 'obj-1', workspace_id: 'workspace-1', key: 'priority', value_type: 'text',
  value_text: 'low', value_num: null, value_date: null, value_bool: null, value_ref: null, updated_at: '2026-07-01T09:00:00.000Z',
}

test('update_task with expected_updated_at writes each field only over the row it checked', async () => {
  const state = { ...freshState(), objectType: 'task', extraProperties: [PRIORITY_ROW] }
  await withFake(state, async () => {
    const result = await executeToolCall('update_task', {
      id: 'obj-1', priority: 'high', description: 'Handoff notes', expected_updated_at: PROPERTY_UPDATED_AT,
    }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['type'], 'task_updated', JSON.stringify(result))
    const priority = state.writes.find((w) => w.path === '/api/collections/object_properties/records/prop-priority')
    assert.deepEqual(priority?.body['_expected_record'], { updated_at: PRIORITY_ROW.updated_at })
    const description = state.writes.find((w) => w.method === 'POST' && w.body['key'] === 'description')
    assert.equal(description?.body['_expected_record'], null, 'a field with no row is created only if still none')
  })
})

test('a conflict partway through update_task names the fields already saved', async () => {
  const state = { ...freshState(), objectType: 'task', extraProperties: [PRIORITY_ROW], conflictOnWriteNumber: 2 }
  await withFake(state, async () => {
    const result = await executeToolCall('update_task', {
      id: 'obj-1', priority: 'high', description: 'Handoff notes', expected_updated_at: PROPERTY_UPDATED_AT,
    }, 'workspace-1') as Record<string, unknown>
    assert.equal(result['code'], 'conflict')
    assert.deepEqual(result['saved_fields'], ['priority'])
  })
})

for (const tool of ['set_content', 'update_object'] as const) {
  test(`${tool} refuses a dry_run that is not true or false, before any write`, async () => {
    const state = freshState()
    await withFake(state, async () => {
      const result = await executeToolCall(tool, { id: 'obj-1', text: 'New line', dry_run: 'true' }, 'workspace-1') as Record<string, unknown>
      assert.equal(result['code'], 'invalid_input')
      assert.match(String(result['message']), /dry_run must be true or false/)
      assert.deepEqual(state.writes, [])
    })
  })
}

test('a dry run names the formatting and embeds a plain-text replacement drops, even with the same text', async () => {
  const state = {
    ...freshState(),
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Equipment guide', marks: [{ type: 'bold' }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'See' }, { type: 'attachment', attrs: { id: 'file-1' } }] },
      ],
    },
  }
  await withFake(state, async () => {
    const result = await executeToolCall('set_content', { id: 'obj-1', text: 'Equipment guide\nSee', dry_run: true }, 'workspace-1') as Record<string, unknown>
    const content = result['content'] as Record<string, unknown>
    assert.deepEqual(content['first_changed_lines'], [])
    assert.deepEqual(content['replaced_formatting'], ['attachment', 'heading', 'mark:bold'])
    assert.deepEqual(state.writes, [])
  })
})

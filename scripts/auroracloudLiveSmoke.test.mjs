import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXTENDED_SMOKE_CHECKS,
  LIVE_SMOKE_TOOL_NAMES,
  executeReadOnlyTool,
  runLiveSmoke,
  smokeFailureSummary,
} from './auroracloudLiveSmokeCore.js'
import { AuroraApiError } from '../src/errors.js'

const clientEnv = {
  AURORA_API_URL: 'https://api.example.test',
  AURORA_API_TOKEN: 'aur_mcp_client_contract_test',
}

const clientContext = {
  kind: 'client',
  workspaces: [{
    workspaceId: 'workspace-1', alias: 'primary', name: 'Primary', role: 'owner',
    scopes: ['read:objects'], grantId: 'grant-1', expiresAt: '2026-08-01T00:00:00.000Z',
  }],
}

const legacyContext = {
  kind: 'legacy_workspace',
  defaultWorkspaceId: 'workspace-legacy',
  workspaces: [],
}

function successfulDependencies(overrides = {}) {
  const calls = []
  const dependencies = {
    resetAuroraClientForTests() {},
    async authenticate() { return clientContext },
    getToolDefinitions: () => [
      { name: 'list_workspaces' },
      { name: 'get_project_context' },
    ],
    getToolEffect: () => 'read',
    async executeToolCall(name, input, context) {
      calls.push({ name, input, context })
      if (name === 'list_workspaces') {
        return { type: 'workspaces', workspaces: context.workspaces }
      }
      if (name === 'get_project_context') {
        return { type: 'project_context', status: 'ok', cursor: null }
      }
      throw new Error(`Unexpected tool: ${name}`)
    },
    ...overrides,
  }
  return { calls, dependencies }
}

test('live smoke invokes the exact bounded read-only runtime call set', async () => {
  const { calls, dependencies } = successfulDependencies()
  let output = ''

  await runLiveSmoke({
    env: { ...clientEnv, AURORA_SMOKE_PROJECT_ID: 'project-1' },
    loadDependencies: async () => dependencies,
    writeOutput: (value) => { output += value },
  })

  assert.deepEqual(calls, [
    { name: 'list_workspaces', input: {}, context: clientContext },
    {
      name: 'get_project_context',
      input: {
        workspace_id: 'workspace-1',
        project_id: 'project-1',
        activity_days: 14,
        task_limit: 20,
        source_limit: 10,
      },
      context: clientContext,
    },
  ])
  assert.equal(output, 'AuroraCloud MCP live smoke passed.\n')
})

test('live smoke tool selection is statically limited to the read-only discovery and project-context tools', () => {
  assert.deepEqual(LIVE_SMOKE_TOOL_NAMES, ['list_workspaces', 'get_project_context'])
  assert.equal(LIVE_SMOKE_TOOL_NAMES.includes('create_object'), false)
  assert.equal(LIVE_SMOKE_TOOL_NAMES.includes('update_task'), false)
})

test('client smoke proves discovery and exits without guessing a project', async () => {
  const { calls, dependencies } = successfulDependencies()

  await runLiveSmoke({ env: clientEnv, loadDependencies: async () => dependencies, writeOutput() {} })

  assert.deepEqual(calls, [{ name: 'list_workspaces', input: {}, context: clientContext }])
})

test('production live smoke does not call the test-only client reset', async () => {
  const base = successfulDependencies()
  let resets = 0
  base.dependencies.resetAuroraClientForTests = () => { resets += 1 }

  await runLiveSmoke({ env: clientEnv, loadDependencies: async () => base.dependencies, writeOutput() {} })

  assert.equal(resets, 0)
})

test('legacy smoke uses its configured workspace and supports one explicit project check', async () => {
  const base = successfulDependencies({ async authenticate() { return legacyContext } })
  const env = {
    AURORA_API_URL: 'https://api.example.test',
    AURORA_WORKSPACE_ID: 'workspace-legacy',
    AURORA_API_TOKEN: 'aur_mcp_legacy_contract_test',
    AURORA_SMOKE_PROJECT_ID: 'project-legacy',
  }

  await runLiveSmoke({ env, loadDependencies: async () => base.dependencies, writeOutput() {} })

  assert.deepEqual(base.calls, [
    { name: 'list_workspaces', input: {}, context: legacyContext },
    {
      name: 'get_project_context',
      input: {
        workspace_id: 'workspace-legacy',
        project_id: 'project-legacy',
        activity_days: 14,
        task_limit: 20,
        source_limit: 10,
      },
      context: legacyContext,
    },
  ])
})

for (const effect of ['write', undefined]) {
  test(`read-only dispatcher rejects ${effect ?? 'unknown'} dynamically selected tools before dispatch`, async () => {
    let dispatches = 0
    const name = effect === 'write' ? 'create_object' : 'unclassified_tool'

    await assert.rejects(
      executeReadOnlyTool(
        {
          getToolEffect: () => effect,
          executeToolCall: async () => {
            dispatches += 1
            return { type: 'created', id: 'should-not-exist' }
          },
        },
        name,
        {},
        clientContext,
      ),
      new RegExp(`not authoritatively classified as read-only: ${name}`),
    )
    assert.equal(dispatches, 0)
  })
}

for (const failingTool of ['list_workspaces', 'get_project_context']) {
  test(`live smoke propagates ${failingTool} failures`, async () => {
    const base = successfulDependencies()
    const originalExecute = base.dependencies.executeToolCall
    base.dependencies.executeToolCall = async (name, input, workspaceId) => {
      if (name === failingTool) return { type: 'error', message: `${failingTool} backend failure` }
      return originalExecute(name, input, workspaceId)
    }

    await assert.rejects(
      runLiveSmoke({
        env: { ...clientEnv, AURORA_SMOKE_PROJECT_ID: 'project-1' },
        loadDependencies: async () => base.dependencies,
        writeOutput() {},
      }),
      new RegExp(`${failingTool} backend failure`),
    )
  })
}

test('live smoke failure output does not serialize workspace records', async () => {
  const base = successfulDependencies()
  const originalExecute = base.dependencies.executeToolCall
  base.dependencies.executeToolCall = async (name, input, workspaceId) => {
    if (name === 'list_workspaces') {
      return { type: 'unexpected', workspaces: [{ name: 'Private workspace title' }] }
    }
    return originalExecute(name, input, workspaceId)
  }

  await assert.rejects(
    runLiveSmoke({ env: clientEnv, loadDependencies: async () => base.dependencies, writeOutput() {} }),
    (error) => {
      assert.match(error.message, /unexpected result type: unexpected/)
      assert.doesNotMatch(error.message, /Private workspace title/)
      return true
    },
  )
})

const invalidEnvironmentCases = [
  ['missing AURORA_API_URL', 'AURORA_API_URL', undefined, /AURORA_API_URL is required/],
  ['blank AURORA_API_URL', 'AURORA_API_URL', '   ', /AURORA_API_URL is required/],
  ['missing AURORA_API_TOKEN', 'AURORA_API_TOKEN', undefined, /AURORA_API_TOKEN is required/],
  ['blank AURORA_API_TOKEN', 'AURORA_API_TOKEN', ' ', /AURORA_API_TOKEN is required/],
  ['malformed token prefix', 'AURORA_API_TOKEN', 'not-an-mcp-token', /must start with aur_mcp_ or aur_mcp_client_/],
]

for (const [label, key, value, expectedError] of invalidEnvironmentCases) {
  test(`${label} fails before imports, network, or dispatcher activity`, async () => {
    const env = { ...clientEnv }
    if (value === undefined) delete env[key]
    else env[key] = value
    let dependencyLoads = 0

    await assert.rejects(
      runLiveSmoke({
        env,
        loadDependencies: async () => {
          dependencyLoads += 1
          throw new Error('imports or network should not start')
        },
        writeOutput() {},
      }),
      expectedError,
    )
    assert.equal(dependencyLoads, 0)
  })
}

test('legacy credentials require AURORA_WORKSPACE_ID before imports or network', async () => {
  let dependencyLoads = 0
  await assert.rejects(
    runLiveSmoke({
      env: { AURORA_API_URL: 'https://api.example.test', AURORA_API_TOKEN: 'aur_mcp_legacy_test' },
      loadDependencies: async () => {
        dependencyLoads += 1
        throw new Error('imports or network should not start')
      },
      writeOutput() {},
    }),
    /AURORA_WORKSPACE_ID is required for legacy credentials/,
  )
  assert.equal(dependencyLoads, 0)
})

const EXTENDED_RESULTS = {
  list_task_lists: { type: 'task_lists', task_lists: [] },
  list_task_statuses: { type: 'task_statuses', statuses: [] },
  list_objects: { type: 'objects', objects: [] },
  wiki_search: { type: 'knowledge_sources', sources: [] },
}

function extendedDependencies(results = EXTENDED_RESULTS) {
  return successfulDependencies({
    getToolDefinitions: () => [{ name: 'list_workspaces' }, { name: 'get_project_context' }, ...EXTENDED_SMOKE_CHECKS.map((check) => ({ name: check.tool }))],
    async executeToolCall(name, input, context) {
      extended.calls.push({ name, input, context })
      if (name === 'list_workspaces') return { type: 'workspaces', workspaces: context.workspaces }
      if (results[name]) return results[name]
      throw new Error(`Unexpected tool: ${name}`)
    },
  })
}
let extended = { calls: [] }

test('the extended smoke calls only its fixed read-only tools, on the one granted workspace (#49)', async () => {
  extended = { calls: [] }
  const { dependencies } = extendedDependencies()
  await runLiveSmoke({ env: { ...clientEnv, AURORA_SMOKE_EXTENDED: '1' }, loadDependencies: async () => dependencies, writeOutput() {} })
  assert.deepEqual(extended.calls.map((call) => call.name), ['list_workspaces', 'list_task_lists', 'list_task_statuses', 'list_objects', 'wiki_search'])
  for (const call of extended.calls.slice(1)) assert.equal(call.input.workspace_id, 'workspace-1')
  assert.deepEqual(EXTENDED_SMOKE_CHECKS.map((check) => check.tool).filter((tool) => /create|update|delete|set_|apply|import|schedule/.test(tool)), [])
})

test('the extended smoke fails, naming the tool, when AuroraCloud answers in another shape (#49)', async () => {
  extended = { calls: [] }
  const { dependencies } = extendedDependencies({ ...EXTENDED_RESULTS, list_task_statuses: { type: 'error', message: 'unsupported config' } })
  await assert.rejects(
    runLiveSmoke({ env: { ...clientEnv, AURORA_SMOKE_EXTENDED: '1' }, loadDependencies: async () => dependencies, writeOutput() {} }),
    /list_task_statuses failed: tool error: unsupported config/,
  )
})

test('the extended smoke refuses a tool that is not classified read-only (#49)', async () => {
  extended = { calls: [] }
  const { dependencies } = extendedDependencies()
  dependencies.getToolEffect = (name) => name === 'list_objects' ? 'write' : 'read'
  await assert.rejects(
    runLiveSmoke({ env: { ...clientEnv, AURORA_SMOKE_EXTENDED: '1' }, loadDependencies: async () => dependencies, writeOutput() {} }),
    /not authoritatively classified as read-only: list_objects/,
  )
  assert.equal(extended.calls.some((call) => call.name === 'list_objects'), false)
})

test('the extended smoke fails when the workspace status config is newer than this server reads (#49)', async () => {
  extended = { calls: [] }
  const { dependencies } = extendedDependencies({ ...EXTENDED_RESULTS, list_task_statuses: { type: 'task_statuses', statuses: ['Todo'], source: 'unsupported' } })
  await assert.rejects(
    runLiveSmoke({ env: { ...clientEnv, AURORA_SMOKE_EXTENDED: '1' }, loadDependencies: async () => dependencies, writeOutput() {} }),
    /list_task_statuses failed: source is unsupported/,
  )
})

test('a failure the smoke did not write is printed as its status and code only, never its upstream message (#49)', async () => {
  const base = successfulDependencies()
  base.dependencies.authenticate = async () => {
    throw new AuroraApiError(401, 'invalid_token', 'Token for Private Workspace Title belongs to someone@example.com')
  }
  let caught
  await assert.rejects(
    runLiveSmoke({ env: clientEnv, loadDependencies: async () => base.dependencies, writeOutput() {} }),
    (error) => { caught = error; return true },
  )
  const line = smokeFailureSummary(caught)
  assert.equal(line, 'AuroraCloud MCP live smoke failed: AuroraCloud answered HTTP 401 (invalid_token).')
  assert.doesNotMatch(line, /Private Workspace|example\.com/)
  assert.equal(smokeFailureSummary(new Error('secret detail')), 'AuroraCloud MCP live smoke failed unexpectedly (Error).')
  assert.match(smokeFailureSummary(new Error('x')), /^AuroraCloud MCP live smoke failed unexpectedly/)
})

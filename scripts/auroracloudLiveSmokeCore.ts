import type { AuroraConnectionContext, GrantedWorkspace } from '../src/contracts.js'

type ToolEffect = 'read' | 'write'

type ToolResult = {
  type: string
  [key: string]: unknown
}

type ReadOnlyDispatcher = {
  getToolEffect(name: string): ToolEffect | undefined
  executeToolCall(name: string, input: Record<string, unknown>, context: AuroraConnectionContext): Promise<ToolResult>
}

type LiveSmokeDependencies = ReadOnlyDispatcher & {
  authenticate(options: { token: string; workspaceId?: string }): Promise<AuroraConnectionContext>
  resetAuroraClientForTests(): void
  getToolDefinitions(): Array<{ name: string }>
}

/** A failure this smoke wrote itself: its message names only tools, settings and sanitized tool errors. */
export class SmokeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SmokeError'
  }
}

/**
 * The one line the smoke prints on failure. The repository and its workflow
 * logs are public, and the drift job copies this into an issue, so anything
 * the smoke did not write itself (an upstream HTTP error, say) is reduced to
 * its status and code, never its message.
 */
export function smokeFailureSummary(error: unknown): string {
  if (error instanceof SmokeError) return error.message
  if (error instanceof Error && error.name === 'AuroraApiError') {
    const { status, code } = error as Error & { status?: unknown; code?: unknown }
    const detail = typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? ` (${code})` : ''
    return `AuroraCloud MCP live smoke failed: AuroraCloud answered HTTP ${typeof status === 'number' ? status : 'error'}${detail}.`
  }
  return `AuroraCloud MCP live smoke failed unexpectedly (${error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : 'unknown error'}).`
}

export const LIVE_SMOKE_TOOL_NAMES = ['list_workspaces', 'get_project_context'] as const

/**
 * Read-only tools the extended smoke also calls (#49), each with the result
 * type that proves AuroraCloud still answers in the shape the server reads.
 * They run only with AURORA_SMOKE_EXTENDED=1, as the on-demand drift workflow does.
 */
export const EXTENDED_SMOKE_CHECKS = [
  { tool: 'list_task_lists', input: {}, resultType: 'task_lists' },
  // A status config newer than this server reads falls back to the built-ins: that is drift.
  { tool: 'list_task_statuses', input: {}, resultType: 'task_statuses', refuse: { key: 'source', value: 'unsupported' } },
  { tool: 'list_objects', input: { limit: 5 }, resultType: 'objects' },
  { tool: 'wiki_search', input: { query: 'aurora', limit: 3 }, resultType: 'knowledge_sources' },
] as const

type LiveSmokeOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  loadDependencies?: () => Promise<LiveSmokeDependencies>
  writeOutput?: (value: string) => void
}

export async function executeReadOnlyTool(
  dependencies: ReadOnlyDispatcher,
  name: string,
  input: Record<string, unknown>,
  context: AuroraConnectionContext,
): Promise<ToolResult> {
  if (dependencies.getToolEffect(name) !== 'read') {
    throw new SmokeError(`Live smoke tool is not authoritatively classified as read-only: ${name}`)
  }
  return dependencies.executeToolCall(name, input, context)
}

export async function runLiveSmoke(options: LiveSmokeOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  requireEnv(env, 'AURORA_API_URL')
  const token = requireMcpToken(env)
  const legacyWorkspaceId = token.startsWith('aur_mcp_client_')
    ? optionalEnv(env, 'AURORA_WORKSPACE_ID')
    : requireLegacyWorkspaceId(env)

  const dependencies = await (options.loadDependencies ?? loadRuntimeDependencies)()
  if (env['NODE_ENV'] === 'test') dependencies.resetAuroraClientForTests()
  const context = await dependencies.authenticate({ token, workspaceId: legacyWorkspaceId })

  const tools = dependencies.getToolDefinitions()
  if (tools.length < 1) {
    throw new SmokeError('AuroraCloud MCP live smoke could not list tools.')
  }

  for (const requiredTool of LIVE_SMOKE_TOOL_NAMES) {
    if (!tools.some((tool) => tool.name === requiredTool)) {
      throw new SmokeError(`AuroraCloud MCP live smoke could not find required tool: ${requiredTool}`)
    }
  }

  const discovered = await executeReadOnlyTool(dependencies, LIVE_SMOKE_TOOL_NAMES[0], {}, context)
  if (discovered.type !== 'workspaces' || !Array.isArray(discovered['workspaces'])) {
    throw new SmokeError(`AuroraCloud MCP live smoke could not list granted workspaces: ${failureSummary(discovered)}`)
  }

  if (optionalEnv(env, 'AURORA_SMOKE_EXTENDED') === '1') {
    const workspaceId = selectSmokeWorkspace(env, context, discovered['workspaces'])
    for (const check of EXTENDED_SMOKE_CHECKS) {
      if (!tools.some((tool) => tool.name === check.tool)) {
        throw new SmokeError(`AuroraCloud MCP live smoke could not find required tool: ${check.tool}`)
      }
      const result = await executeReadOnlyTool(dependencies, check.tool, { workspace_id: workspaceId, ...check.input }, context)
      if (result.type !== check.resultType) {
        throw new SmokeError(`AuroraCloud MCP live smoke ${check.tool} failed: ${failureSummary(result)}`)
      }
      if ('refuse' in check && result[check.refuse.key] === check.refuse.value) {
        throw new SmokeError(`AuroraCloud MCP live smoke ${check.tool} failed: ${check.refuse.key} is ${check.refuse.value}`)
      }
    }
  }

  const projectId = optionalEnv(env, 'AURORA_SMOKE_PROJECT_ID')
  if (projectId) {
    const workspaceId = selectSmokeWorkspace(env, context, discovered['workspaces'])
    const project = await executeReadOnlyTool(dependencies, LIVE_SMOKE_TOOL_NAMES[1], {
      workspace_id: workspaceId,
      project_id: projectId,
      activity_days: 14,
      task_limit: 20,
      source_limit: 10,
    }, context)
    if (project.type !== 'project_context' || project['status'] !== 'ok') {
      throw new SmokeError(`AuroraCloud MCP live smoke could not get project context: ${failureSummary(project)}`)
    }
  }

  const writeOutput = options.writeOutput ?? ((value: string) => process.stdout.write(value))
  writeOutput('AuroraCloud MCP live smoke passed.\n')
}

function failureSummary(result: ToolResult): string {
  if (result.type === 'error') {
    return `tool error: ${String(result['message'] ?? 'unknown error')}`
  }
  return `unexpected result type: ${result.type}`
}

function requireEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new SmokeError(`${key} is required.`)
  }
  return value
}

function requireMcpToken(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const token = requireEnv(env, 'AURORA_API_TOKEN')
  if (!token.startsWith('aur_mcp_client_') && !token.startsWith('aur_mcp_')) {
    throw new SmokeError('AURORA_API_TOKEN must start with aur_mcp_ or aur_mcp_client_.')
  }
  return token
}

function optionalEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
): string | undefined {
  return env[key]?.trim() || undefined
}

function requireLegacyWorkspaceId(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const workspaceId = optionalEnv(env, 'AURORA_WORKSPACE_ID')
  if (!workspaceId) throw new SmokeError('AURORA_WORKSPACE_ID is required for legacy credentials.')
  return workspaceId
}

function selectSmokeWorkspace(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  context: AuroraConnectionContext,
  discovered: unknown[],
): string {
  if (context.kind === 'legacy_workspace') return context.defaultWorkspaceId

  const workspaces = discovered.filter(isGrantedWorkspace)
  if (workspaces.length < 1) throw new SmokeError('AuroraCloud MCP live smoke found no granted workspaces.')
  const requestedId = optionalEnv(env, 'AURORA_SMOKE_WORKSPACE_ID')
  if (requestedId) {
    if (!workspaces.some((workspace) => workspace.workspaceId === requestedId)) {
      throw new SmokeError('AURORA_SMOKE_WORKSPACE_ID does not match a discovered workspace grant.')
    }
    return requestedId
  }
  if (workspaces.length !== 1) {
    throw new SmokeError('AURORA_SMOKE_WORKSPACE_ID is required when the client has multiple workspace grants.')
  }
  return workspaces[0]!.workspaceId
}

function isGrantedWorkspace(value: unknown): value is GrantedWorkspace {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Record<string, unknown>)['workspaceId'] === 'string'
}

async function loadRuntimeDependencies(): Promise<LiveSmokeDependencies> {
  const [{ authenticate, resetAuroraClientForTests }, { executeToolCall }, { getToolDefinitions, getToolEffect }] = await Promise.all([
    import('../src/auroraClient.js'),
    import('../src/tools.js'),
    import('../src/toolCatalog.js'),
  ])

  return {
    authenticate,
    resetAuroraClientForTests,
    executeToolCall,
    getToolDefinitions,
    getToolEffect,
  }
}

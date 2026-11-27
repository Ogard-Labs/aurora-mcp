/**
 * Every AuroraCloud data shape this server relies on, in one place (#49).
 *
 * Each value here is a copy of a value Aurora defines in Ogard-Labs/auroradocs.
 * Nothing at run time checks that the two still agree, so each entry in
 * `AURORA_CONTRACT` names the auroradocs file that defines it and the exact
 * source text that must still be there. `scripts/auroraDrift.mjs` reads a
 * checkout of auroradocs and fails, naming the entry and the file, when any
 * of that text is gone. `src/auroraContract.test.ts` checks, offline, that
 * each entry's source text still holds the value the code uses.
 *
 * When Aurora changes one of these, change the value here, the entry's
 * `source`, and the code that reads it, together.
 */

/** Task property keys (auroradocs `packages/core/src/lib/tasks.ts`). */
export const TASK_PROPERTY_KEYS = {
  status: 'status',
  priority: 'priority',
  dueDate: 'due_date',
  assignee: 'assignee',
  labels: 'labels',
  tags: 'tags',
  description: 'description',
  taskListId: 'task_list_id',
  recurrence: 'recurrence',
  recurrenceNext: 'recurrence_next',
} as const

/** Properties of a `task_list` object that the server reads. */
export const TASK_LIST_PROPERTY_KEYS = {
  listId: 'list_id',
  defaultStatus: 'default_status',
  position: 'position',
} as const

/** The hidden object type that holds a workspace's synced settings. */
export const WORKSPACE_CONFIG_OBJECT_TYPE = 'workspace_config'

/** The hidden object type that holds one task list. */
export const TASK_LIST_OBJECT_TYPE = 'task_list'

/** Object types Aurora hides from every listing, search and export. */
export const HIDDEN_SYSTEM_OBJECT_TYPE_LIST = [WORKSPACE_CONFIG_OBJECT_TYPE, TASK_LIST_OBJECT_TYPE] as const

/** The property of the workspace config object that holds the task statuses, and its format version. */
export const TASK_STATUS_CONFIG_PROPERTY_KEY = 'task_statuses'
export const TASK_STATUS_CONFIG_VERSION = 1

/** The status tasks were completed with before statuses had groups. */
export const LEGACY_DONE_TASK_STATUS = 'Done'

/** The built-in task statuses, in board order. */
export const BUILTIN_TASK_STATUS_LIST = [
  { id: 'Backlog', group: 'todo' },
  { id: 'Todo', group: 'todo' },
  { id: 'In Progress', group: 'inProgress' },
  { id: LEGACY_DONE_TASK_STATUS, group: 'done' },
] as const

/** Prefix of an end-to-end encrypted value. */
export const E2EE_MARKER = '__e2ee__'

/** Seeds of the two ids Aurora derives instead of drawing at random. */
export const WORKSPACE_CONFIG_ID_SEED = 'aurora:workspace-config:'
export const WORKSPACE_CONFIG_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
export const WORKSPACE_CONFIG_ID_LENGTH = 15
export const RECURRENCE_SUCCESSOR_ID_SEED = 'task-recurrence:v1'
export const RECURRENCE_SUCCESSOR_ID_LENGTH = 15

/** AuroraCloud error `code` values that `src/errors.ts` turns into specific messages. */
export const EMAIL_VERIFICATION_REQUIRED_CODE = 'email_verification_required'
export const WRITE_REFUSED_CODE = 'write_refused'

/** AuroraCloud routes the server calls outside the collections API. */
export const AURORA_ROUTES = {
  mcpWorkspaces: '/api/mcp/workspaces',
  importCapabilities: '/api/mcp/workspaces/:workspaceId/import-capabilities',
  knowledgeSearch: '/api/knowledge/workspaces/:workspaceId/search',
  knowledgeObject: '/api/knowledge/workspaces/:workspaceId/objects/:objectId',
  knowledgeRelated: '/api/knowledge/workspaces/:workspaceId/related/:objectId',
  knowledgeRecent: '/api/knowledge/workspaces/:workspaceId/recent',
  projectContext: '/api/mcp/workspaces/:workspaceId/projects/context',
  projectChanges: '/api/mcp/workspaces/:workspaceId/projects/:projectId/changes',
  objectAttachments: '/api/mcp/workspaces/:workspaceId/objects/:objectId/attachments',
  authMe: '/auth/me',
  authLogin: '/auth/login',
  workspaceMembers: '/workspaces/:workspaceId/members',
} as const

/** The prefix AuroraCloud mounts its MCP routes under, besides `/mcp`. */
const MCP_PREFIX = '/api/mcp'

/** Fills an `AURORA_ROUTES` path's `:name` segments with `params`, as given (callers encode them). */
export function auroraRoute(name: keyof typeof AURORA_ROUTES, params: Record<string, string> = {}): string {
  return AURORA_ROUTES[name].replace(/:([A-Za-z]+)/g, (segment, key: string) => {
    const value = params[key]
    if (value === undefined) throw new Error(`auroraRoute(${name}) needs ${key}`)
    return value
  })
}

export type AuroraContractEntry = {
  /** A stable name for the entry, shown when it drifts. */
  id: string
  /** What the server relies on, in a few words. */
  what: string
  /** The value the server uses, as a string, which `source` must contain. */
  value: string
  /** The auroradocs file that defines it, relative to the repository root. */
  file: string
  /** Source text that must appear in `file`, compared with runs of whitespace collapsed. */
  source: string
  /** Where this server uses the value. */
  usedBy: string[]
  /** `source` is a whole statement: nothing but `;` or a line comment may follow it on its line. */
  lineEnd?: boolean
}

const TASKS_FILE = 'packages/core/src/lib/tasks.ts'
const taskKey = (constant: string, value: string): AuroraContractEntry => ({
  id: `task-key-${value}`,
  what: `task property key \`${value}\``,
  value,
  file: TASKS_FILE,
  source: `const ${constant} = '${value}'`,
  usedBy: ['src/auroraClient.ts', 'src/taskRecurrence.ts'],
  lineEnd: true,
})

export const AURORA_CONTRACT: readonly AuroraContractEntry[] = [
  taskKey('STATUS_KEY', TASK_PROPERTY_KEYS.status),
  taskKey('PRIORITY_KEY', TASK_PROPERTY_KEYS.priority),
  taskKey('DUE_DATE_KEY', TASK_PROPERTY_KEYS.dueDate),
  taskKey('ASSIGNEE_KEY', TASK_PROPERTY_KEYS.assignee),
  taskKey('LABELS_KEY', TASK_PROPERTY_KEYS.labels),
  taskKey('TAGS_KEY', TASK_PROPERTY_KEYS.tags),
  taskKey('DESCRIPTION_KEY', TASK_PROPERTY_KEYS.description),
  taskKey('TASK_LIST_KEY', TASK_PROPERTY_KEYS.taskListId),
  taskKey('RECURRENCE_KEY', TASK_PROPERTY_KEYS.recurrence),
  taskKey('RECURRENCE_NEXT_KEY', TASK_PROPERTY_KEYS.recurrenceNext),
  {
    id: 'hidden-object-types-core',
    what: 'hidden system object types (app)',
    value: HIDDEN_SYSTEM_OBJECT_TYPE_LIST[1],
    file: 'packages/core/src/lib/workspaceConfigObject.ts',
    source: "const HIDDEN_SYSTEM_OBJECT_TYPES: ReadonlySet<string> = new Set([WORKSPACE_CONFIG_OBJECT_TYPE, 'task_list'])",
    usedBy: ['src/objectTypes.ts'],
    lineEnd: true,
  },
  {
    id: 'hidden-object-types-api',
    what: 'hidden system object types (AuroraCloud)',
    value: HIDDEN_SYSTEM_OBJECT_TYPE_LIST.map((type) => `'${type}'`).join(', '),
    file: 'apps/api/src/lib/hiddenObjects.ts',
    source: "const HIDDEN_SYSTEM_OBJECT_TYPES: ReadonlySet<string> = new Set(['workspace_config', 'task_list'])",
    usedBy: ['src/objectTypes.ts'],
    lineEnd: true,
  },
  {
    id: 'workspace-config-type',
    what: 'workspace config object type',
    value: WORKSPACE_CONFIG_OBJECT_TYPE,
    file: 'packages/core/src/lib/workspaceConfigObject.ts',
    source: `export const WORKSPACE_CONFIG_OBJECT_TYPE = '${WORKSPACE_CONFIG_OBJECT_TYPE}'`,
    usedBy: ['src/objectTypes.ts', 'src/taskStatuses.ts'],
    lineEnd: true,
  },
  {
    id: 'workspace-config-id-alphabet',
    what: 'workspace config object id alphabet and length',
    value: WORKSPACE_CONFIG_ID_CHARS,
    file: 'packages/core/src/lib/workspaceConfigObject.ts',
    source: `const ID_CHARS = '${WORKSPACE_CONFIG_ID_CHARS}' const ID_LENGTH = ${WORKSPACE_CONFIG_ID_LENGTH}`,
    usedBy: ['src/taskStatuses.ts'],
    lineEnd: true,
  },
  {
    id: 'workspace-config-id',
    what: 'workspace config object id formula',
    value: WORKSPACE_CONFIG_ID_SEED,
    file: 'packages/core/src/lib/workspaceConfigObject.ts',
    // From the signature to the closing brace, so a change to how digest bytes become characters is drift too.
    source: 'export function workspaceConfigObjectId(workspaceId: string): string {'
      + ` const digest = sha256(new TextEncoder().encode(\`${WORKSPACE_CONFIG_ID_SEED}\${workspaceId}\`))`
      + " let id = '' for (let index = 0; index < ID_LENGTH; index += 1) {"
      + ' id += ID_CHARS[(digest[index] as number) % ID_CHARS.length] } return id }',
    usedBy: ['src/taskStatuses.ts'],
  },
  {
    id: 'task-status-config-key',
    what: 'task status config property key',
    value: TASK_STATUS_CONFIG_PROPERTY_KEY,
    file: 'packages/core/src/lib/taskStatusConfig.ts',
    source: `export const TASK_STATUS_CONFIG_PROPERTY_KEY = '${TASK_STATUS_CONFIG_PROPERTY_KEY}'`,
    usedBy: ['src/taskStatuses.ts'],
    lineEnd: true,
  },
  {
    id: 'task-status-config-version',
    what: 'task status config format version',
    value: String(TASK_STATUS_CONFIG_VERSION),
    file: 'packages/core/src/lib/taskStatusConfig.ts',
    source: `export const TASK_STATUS_CONFIG_VERSION = ${TASK_STATUS_CONFIG_VERSION}`,
    usedBy: ['src/taskStatuses.ts'],
    lineEnd: true,
  },
  {
    id: 'legacy-done-status',
    what: 'status tasks were completed with before groups',
    value: LEGACY_DONE_TASK_STATUS,
    file: 'packages/core/src/lib/taskStatusGroups.ts',
    source: `export const LEGACY_DONE_TASK_STATUS = '${LEGACY_DONE_TASK_STATUS}'`,
    usedBy: ['src/taskStatuses.ts'],
    lineEnd: true,
  },
  {
    id: 'builtin-task-status-list',
    what: 'built-in task status list',
    value: BUILTIN_TASK_STATUS_LIST.slice(0, 3).map((status) => `{ id: '${status.id}', group: '${status.group}' },`).join(' '),
    file: 'packages/core/src/lib/taskStatusGroups.ts',
    source: 'export const LEGACY_TASK_STATUS_DEFINITIONS: readonly TaskStatusDefinition[] = ['
      + ` ${BUILTIN_TASK_STATUS_LIST.slice(0, 3).map((status) => `{ id: '${status.id}', group: '${status.group}' },`).join(' ')}`
      + " { id: LEGACY_DONE_TASK_STATUS, group: 'done' }, ]",
    usedBy: ['src/taskStatuses.ts'],
    lineEnd: true,
  },
  {
    id: 'e2ee-marker',
    what: 'encrypted value marker',
    value: E2EE_MARKER,
    file: 'packages/core/src/lib/crypto.ts',
    source: `export const E2EE_MARKER = '${E2EE_MARKER}'`,
    usedBy: ['src/taskStatuses.ts'],
    lineEnd: true,
  },
  {
    id: 'recurrence-successor-id',
    what: 'recurrence successor id formula',
    value: RECURRENCE_SUCCESSOR_ID_SEED,
    file: TASKS_FILE,
    source: `return (await sha256(\`${RECURRENCE_SUCCESSOR_ID_SEED}\\n\${sourceTaskId}\\n\${occurrenceDate}\`)).slice(0, ${RECURRENCE_SUCCESSOR_ID_LENGTH})`,
    usedBy: ['src/taskRecurrence.ts'],
    lineEnd: true,
  },
  {
    id: 'error-email-verification-required',
    what: 'error code for an unconfirmed email',
    value: EMAIL_VERIFICATION_REQUIRED_CODE,
    file: 'apps/api/src/lib/auth.ts',
    source: `export const EMAIL_VERIFICATION_REQUIRED_CODE = '${EMAIL_VERIFICATION_REQUIRED_CODE}'`,
    usedBy: ['src/errors.ts'],
    lineEnd: true,
  },
  {
    id: 'error-write-refused',
    what: 'error code for a write the role may not make',
    value: WRITE_REFUSED_CODE,
    file: 'apps/api/src/routes/collectionAccess.ts',
    source: `export const WRITE_REFUSED_CODE = '${WRITE_REFUSED_CODE}'`,
    usedBy: ['src/errors.ts'],
    lineEnd: true,
  },
  {
    id: 'route-mcp-workspaces',
    what: 'MCP workspace list route',
    value: AURORA_ROUTES.mcpWorkspaces,
    file: 'apps/api/src/routes/mcp.ts',
    source: `for (const path of ['/mcp/workspaces', '${AURORA_ROUTES.mcpWorkspaces}'])`,
    usedBy: ['src/auroraClient.ts'],
  },
  {
    id: 'route-import-capabilities',
    what: 'import capabilities route',
    value: AURORA_ROUTES.importCapabilities,
    file: 'apps/api/src/routes/mcpAttachments.ts',
    source: `'${AURORA_ROUTES.importCapabilities}'`,
    usedBy: ['src/auroraClient.ts'],
  },
  ...(['knowledgeSearch', 'knowledgeObject', 'knowledgeRelated', 'knowledgeRecent'] as const).map((name): AuroraContractEntry => ({
    id: `route-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    what: `knowledge route ${AURORA_ROUTES[name]}`,
    value: AURORA_ROUTES[name],
    file: 'apps/api/src/routes/knowledge.ts',
    source: `'${AURORA_ROUTES[name]}'] as const`,
    usedBy: ['src/auroraClient.ts'],
  })),
  {
    id: 'knowledge-response-items',
    what: 'knowledge responses list their sources in `items`',
    value: 'items',
    file: 'apps/api/src/lib/knowledge.ts',
    source: 'type WorkspaceKnowledgeResponse = { workspaceId: string query: string | null limit: number items: WorkspaceKnowledgeSource[] }',
    usedBy: ['src/auroraClient.ts'],
  },
  {
    id: 'route-mcp-prefix',
    what: `MCP routes mounted under ${MCP_PREFIX}`,
    value: MCP_PREFIX,
    file: 'apps/api/src/routes/mcp.ts',
    source: `for (const prefix of ['/mcp', '${MCP_PREFIX}'] as const)`,
    usedBy: ['src/projectContext.ts'],
  },
  ...(['projectContext', 'projectChanges'] as const).map((name): AuroraContractEntry => ({
    id: `route-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    what: `project route ${AURORA_ROUTES[name]}`,
    // Mounted under each MCP prefix; the prefix has its own entry.
    value: AURORA_ROUTES[name].slice(MCP_PREFIX.length),
    file: 'apps/api/src/routes/mcp.ts',
    source: `\`\${prefix}${AURORA_ROUTES[name].slice(MCP_PREFIX.length)}\``,
    usedBy: ['src/projectContext.ts'],
  })),
  {
    id: 'route-object-attachments',
    what: 'attachment upload route',
    value: AURORA_ROUTES.objectAttachments,
    file: 'apps/api/src/routes/mcpAttachments.ts',
    source: `'${AURORA_ROUTES.objectAttachments}', ] as const`,
    usedBy: ['src/auroraClient.ts'],
  },
  {
    id: 'route-auth-me',
    what: 'signed-in user route',
    value: AURORA_ROUTES.authMe,
    file: 'apps/api/src/routes/auth.ts',
    source: `app.get('${AURORA_ROUTES.authMe}', async (request, reply) => {`,
    usedBy: ['src/auroraClient.ts'],
  },
  {
    id: 'route-auth-login',
    what: 'password sign-in route',
    value: AURORA_ROUTES.authLogin,
    file: 'apps/api/src/routes/auth.ts',
    source: `app.post<{ Body: AuthRequestBody }>('${AURORA_ROUTES.authLogin}', async (request, reply) => {`,
    usedBy: ['src/auroraClient.ts'],
  },
  {
    id: 'task-list-key-list_id',
    what: 'task list property key `list_id`',
    value: TASK_LIST_PROPERTY_KEYS.listId,
    file: 'packages/core/src/lib/taskListObjects.ts',
    source: `export const TASK_LIST_ID_KEY = '${TASK_LIST_PROPERTY_KEYS.listId}'`,
    usedBy: ['src/auroraClient.ts'],
    lineEnd: true,
  },
  ...(['defaultStatus', 'position'] as const).map((name): AuroraContractEntry => ({
    id: `task-list-key-${TASK_LIST_PROPERTY_KEYS[name]}`,
    what: `task list property key \`${TASK_LIST_PROPERTY_KEYS[name]}\``,
    value: TASK_LIST_PROPERTY_KEYS[name],
    file: 'packages/core/src/lib/taskListObjects.ts',
    source: `${name}: '${TASK_LIST_PROPERTY_KEYS[name]}',`,
    usedBy: ['src/auroraClient.ts'],
  })),
  {
    id: 'route-workspace-members',
    what: 'workspace member list route',
    value: AURORA_ROUTES.workspaceMembers,
    file: 'apps/api/src/routes/workspaces.ts',
    source: `app.get<{ Params: { workspaceId: string } }>( '${AURORA_ROUTES.workspaceMembers}',`,
    usedBy: ['src/auroraClient.ts'],
  },
]

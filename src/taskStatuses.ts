/**
 * Task statuses as Aurora defines them (auroradocs
 * `packages/core/src/lib/taskStatusGroups.ts` and `taskStatusConfig.ts`).
 *
 * Whether a task is finished is a property of its status's group, not of its
 * name: users rename and delete statuses, so "Done" may be called "Shipped" in
 * one workspace and be joined by "Won't do" in another. A workspace's own
 * statuses are synced as JSON in the `task_statuses` property of its hidden
 * `workspace_config` object. Pure functions only; reading lives in auroraClient.
 */
import { createHash } from 'node:crypto'
import {
  BUILTIN_TASK_STATUS_LIST,
  E2EE_MARKER,
  LEGACY_DONE_TASK_STATUS as CONTRACT_LEGACY_DONE_TASK_STATUS,
  TASK_STATUS_CONFIG_PROPERTY_KEY as CONTRACT_TASK_STATUS_CONFIG_PROPERTY_KEY,
  TASK_STATUS_CONFIG_VERSION as CONTRACT_TASK_STATUS_CONFIG_VERSION,
  WORKSPACE_CONFIG_ID_CHARS,
  WORKSPACE_CONFIG_ID_LENGTH,
  WORKSPACE_CONFIG_ID_SEED,
  WORKSPACE_CONFIG_OBJECT_TYPE as CONTRACT_WORKSPACE_CONFIG_OBJECT_TYPE,
} from './auroraContract.js'

export type TaskStatusGroup = 'todo' | 'inProgress' | 'done'

export type TaskStatusDefinition = {
  id: string
  group: TaskStatusGroup
  color?: string
  /** Set on an old status name kept only so tasks still carrying it are judged by the status it became. */
  aliasOf?: string
}

/** Where the statuses came from: the workspace's synced config, or the built-ins and why. */
export type TaskStatusSource = 'workspace' | 'builtin' | 'encrypted' | 'unsupported'

export type WorkspaceTaskStatuses = {
  /** Writable statuses in board order. */
  statuses: TaskStatusDefinition[]
  /** `statuses` plus alias entries for renamed or deleted names. */
  judged: TaskStatusDefinition[]
  source: TaskStatusSource
}

export const TASK_STATUS_GROUPS: readonly TaskStatusGroup[] = ['todo', 'inProgress', 'done']
// The values below come from the AuroraCloud contract (src/auroraContract.ts, #49).
export const LEGACY_DONE_TASK_STATUS = CONTRACT_LEGACY_DONE_TASK_STATUS
export const WORKSPACE_CONFIG_OBJECT_TYPE = CONTRACT_WORKSPACE_CONFIG_OBJECT_TYPE
export const TASK_STATUS_CONFIG_PROPERTY_KEY = CONTRACT_TASK_STATUS_CONFIG_PROPERTY_KEY
export const TASK_STATUS_CONFIG_VERSION = CONTRACT_TASK_STATUS_CONFIG_VERSION
/** Prefix of an end-to-end encrypted metadata value (auroradocs `E2EE_MARKER`). */
export const E2EE_METADATA_MARKER = E2EE_MARKER

export const BUILTIN_TASK_STATUSES: readonly TaskStatusDefinition[] = BUILTIN_TASK_STATUS_LIST.map((status) => ({ ...status }))

const LEGACY_GROUPS: Record<string, TaskStatusGroup> = { [LEGACY_DONE_TASK_STATUS]: 'done', 'In Progress': 'inProgress' }
const MAX_ALIAS_HOPS = 8

export function isStatusGroup(value: unknown): value is TaskStatusGroup {
  return value === 'todo' || value === 'inProgress' || value === 'done'
}

export function isEncryptedMetadataValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(E2EE_METADATA_MARKER)
}

function legacyGroup(statusId: string): TaskStatusGroup {
  return LEGACY_GROUPS[statusId] ?? 'todo'
}

/** The workspace config object's id: 15 characters of `[a-z0-9]` derived from the workspace id. */
export function workspaceConfigObjectId(workspaceId: string): string {
  const alphabet = WORKSPACE_CONFIG_ID_CHARS
  const digest = createHash('sha256').update(`${WORKSPACE_CONFIG_ID_SEED}${workspaceId}`).digest()
  let id = ''
  for (let index = 0; index < WORKSPACE_CONFIG_ID_LENGTH; index += 1) id += alphabet[digest[index]! % alphabet.length]
  return id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type ParsedConfig = {
  statuses: TaskStatusDefinition[]
  aliases: Record<string, string>
}

/**
 * The live statuses and aliases in a stored config, `'unsupported'` for a
 * newer format, or null when there is nothing usable.
 */
export function parseTaskStatusConfig(text: string | null | undefined): ParsedConfig | 'unsupported' | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  if (typeof raw['version'] === 'number' && raw['version'] > TASK_STATUS_CONFIG_VERSION) return 'unsupported'
  const entries: Array<TaskStatusDefinition & { order: number }> = []
  if (isRecord(raw['statuses'])) {
    for (const [id, value] of Object.entries(raw['statuses'])) {
      if (!id || !isRecord(value) || typeof value['updatedAt'] !== 'string') continue
      if (typeof value['color'] !== 'string' || typeof value['order'] !== 'number') continue
      if (value['deleted'] === true) continue
      entries.push({
        id,
        group: isStatusGroup(value['group']) ? value['group'] : legacyGroup(id),
        color: value['color'],
        order: value['order'],
      })
    }
  }
  entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const aliases: Record<string, string> = {}
  if (isRecord(raw['aliases'])) {
    for (const [from, value] of Object.entries(raw['aliases'])) {
      if (isRecord(value) && typeof value['to'] === 'string' && typeof value['updatedAt'] === 'string') aliases[from] = value['to']
    }
  }
  return { statuses: entries.map(({ order: _order, ...definition }) => definition), aliases }
}

/** The definitions plus one entry per old name that still leads to a live status, carrying that status's group. */
export function withTaskStatusAliases(
  statuses: readonly TaskStatusDefinition[],
  aliases: Readonly<Record<string, string>>,
): TaskStatusDefinition[] {
  const live = new Map(statuses.map((status) => [status.id, status] as const))
  const extra: TaskStatusDefinition[] = []
  for (const from of Object.keys(aliases)) {
    if (live.has(from)) continue
    let target: string | undefined = aliases[from]
    for (let hop = 0; target && !live.has(target) && hop < MAX_ALIAS_HOPS; hop += 1) target = aliases[target]
    const definition = target ? live.get(target) : undefined
    if (definition) extra.push({ id: from, group: definition.group, aliasOf: definition.id })
  }
  return [...statuses, ...extra]
}

/** Resolve the statuses a workspace uses from the raw `task_statuses` property value (null when absent). */
export function resolveWorkspaceTaskStatuses(rawConfig: string | null | undefined): WorkspaceTaskStatuses {
  const builtin = (source: TaskStatusSource): WorkspaceTaskStatuses => ({
    statuses: BUILTIN_TASK_STATUSES.map((status) => ({ ...status })),
    judged: BUILTIN_TASK_STATUSES.map((status) => ({ ...status })),
    source,
  })
  if (isEncryptedMetadataValue(rawConfig)) return builtin('encrypted')
  const parsed = parseTaskStatusConfig(rawConfig)
  if (parsed === 'unsupported') return builtin('unsupported')
  if (!parsed || parsed.statuses.length === 0) return builtin('builtin')
  return { statuses: parsed.statuses, judged: withTaskStatusAliases(parsed.statuses, parsed.aliases), source: 'workspace' }
}

/**
 * The group of a task's status. A value with no matching definition (deleted
 * elsewhere, or written by an older client) keeps its legacy meaning, so
 * deleting a status never silently reopens finished tasks.
 */
export function taskStatusGroup(statusId: string | null | undefined, statuses: readonly TaskStatusDefinition[]): TaskStatusGroup {
  if (!statusId) return 'todo'
  const definition = statuses.find((status) => status.id === statusId)
  return definition ? definition.group : legacyGroup(statusId)
}

export function isCompletedTaskStatus(statusId: string | null | undefined, statuses: readonly TaskStatusDefinition[]): boolean {
  return taskStatusGroup(statusId, statuses) === 'done'
}

/** The status a new recurring occurrence starts in: `Todo` unless the workspace changed it, else the first open status. */
export function openTaskStatusId(statuses: readonly TaskStatusDefinition[]): string {
  const writable = statuses.filter((status) => !status.aliasOf)
  const todo = writable.find((status) => status.id === 'Todo')
  if (todo && todo.group !== 'done') return 'Todo'
  return writable.find((status) => status.group !== 'done')?.id ?? 'Todo'
}

function statusKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * The status a stored or requested value stands for: an old name the
 * workspace renamed (an alias) stands for the status it became; otherwise the
 * writable status it matches, or null.
 */
export function canonicalTaskStatus(raw: string, statuses: readonly TaskStatusDefinition[]): string | null {
  const alias = statuses.find((status) => status.id === raw && status.aliasOf)
  if (alias?.aliasOf) return alias.aliasOf
  return matchTaskStatus(raw, statuses)
}

/**
 * The workspace status an agent meant: exact, then case- and spacing-
 * insensitive (so the old MCP spelling `To Do` still finds `Todo`). Null when
 * nothing matches.
 */
export function matchTaskStatus(raw: string, statuses: readonly TaskStatusDefinition[]): string | null {
  const writable = statuses.filter((status) => !status.aliasOf)
  const exact = writable.find((status) => status.id === raw)
  if (exact) return exact.id
  const key = statusKey(raw)
  return writable.find((status) => statusKey(status.id) === key)?.id ?? null
}

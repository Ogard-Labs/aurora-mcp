/**
 * Task queries for `list_tasks` and `get_task` (#50): compact task rows with
 * their fields, filtered and sorted the way Aurora's task views read them.
 *
 * - Completion follows the workspace's status groups: a status in the `done`
 *   group is complete (auroradocs `packages/core/src/lib/taskStatuses.ts`).
 * - A value that is end-to-end encrypted (`__e2ee__`) is never shown. It reads
 *   as null and its field is named in `encrypted_fields`, and no filter
 *   matches it.
 * - Dates compare by their `YYYY-MM-DD` part; a due time does not move a task
 *   to another day.
 */
import { createHash } from 'node:crypto'
import type { AuroraPlanningTask, AuroraTaskList, AuroraWorkspaceMember } from './auroraClient.js'
import {
  isCompletedTaskStatus,
  isEncryptedMetadataValue,
  canonicalTaskStatus,
  taskStatusGroup,
  type TaskStatusDefinition,
  type TaskStatusGroup,
} from './taskStatuses.js'

export type TaskSort = 'due_date' | 'updated_at' | 'priority'

export type TaskRow = {
  id: string
  title: string | null
  status: string | null
  status_group: TaskStatusGroup | null
  due_date: string | null
  priority: string | null
  task_list: { id: string; name: string | null } | null
  assignees: Array<{ id: string; name: string | null }>
  labels: string[]
  /** Null when it cannot be told: no readable rule, and the marker or the status that would settle it is encrypted. */
  recurring: boolean | null
  updated_at: string | null
  /** Fields whose stored value is end-to-end encrypted, so it is not shown. */
  encrypted_fields?: string[]
}

export type TaskFilters = {
  /** Status ids, already resolved against the workspace's statuses. */
  statuses?: ReadonlySet<string>
  statusGroup?: TaskStatusGroup
  taskListId?: string
  assigneeId?: string
  label?: string
  dueBefore?: string
  dueAfter?: string
  overdue?: boolean
  hasDueDate?: boolean
  recurring?: boolean
  includeCompleted: boolean
  today: string
}

const PRIORITY_RANK: Readonly<Record<string, number>> = { urgent: 0, high: 1, medium: 2, low: 3 }

function shown(value: string | null | undefined, field: string, encrypted: string[]): string | null {
  if (value === null || value === undefined || value === '') return null
  if (isEncryptedMetadataValue(value)) {
    if (!encrypted.includes(field)) encrypted.push(field)
    return null
  }
  return value
}

/**
 * A list is stored as one comma-separated text, so a sealed value arrives
 * split at the commas inside it: any piece that is sealed withholds the list.
 */
function shownList(values: readonly string[], field: string, encrypted: string[]): string[] {
  if (!values.some((value) => isEncryptedMetadataValue(value))) return [...values]
  if (!encrypted.includes(field)) encrypted.push(field)
  return []
}

/**
 * What a task's `recurrence_next` marker says. Completing a repeating task
 * clears its rule and records the occurrence it made in this marker, so a live
 * marker still marks the task as part of a series. An undone one does not.
 */
export function readRecurrenceMarker(raw: string | null | undefined):
  { state: 'none' } | { state: 'encrypted' } | { state: 'live'; rule: string | null } {
  if (!raw) return { state: 'none' }
  if (isEncryptedMetadataValue(raw)) return { state: 'encrypted' }
  try {
    const marker = JSON.parse(raw) as { id?: unknown; rule?: unknown; state?: unknown }
    if (!marker || typeof marker !== 'object' || typeof marker.id !== 'string' || !marker.id || marker.state === 'undone') {
      return { state: 'none' }
    }
    const rule = typeof marker.rule === 'string' && marker.rule && !isEncryptedMetadataValue(marker.rule) ? marker.rule : null
    return { state: 'live', rule }
  } catch {
    return { state: 'none' }
  }
}

/** The date part of a due value, or null. */
export function dueDateKey(value: string | null): string | null {
  const match = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null
  return match ? match[1] : null
}

/**
 * Whether a task repeats. An encrypted rule is still a rule. Completing a
 * repeating task clears its rule and leaves a live marker, so a completed task
 * with a live marker is part of a series; a reopened one is not, because
 * completing it again makes no occurrence. Unknown is null.
 */
function recurringOf(
  rule: string | null | undefined,
  marker: ReturnType<typeof readRecurrenceMarker>,
  status: string | null,
  statusEncrypted: boolean,
  statuses: readonly TaskStatusDefinition[],
): boolean | null {
  if (rule) return true
  if (marker.state === 'none') return false
  if (statusEncrypted) return null
  // A readable open status settles it, whatever the marker holds.
  if (!isCompletedTaskStatus(status, statuses)) return false
  return marker.state === 'encrypted' ? null : true
}

/** One task as a row, with names resolved and encrypted values withheld. */
export function toTaskRow(
  task: AuroraPlanningTask,
  context: {
    statuses: readonly TaskStatusDefinition[]
    lists: readonly AuroraTaskList[]
    members: readonly AuroraWorkspaceMember[]
  },
): TaskRow {
  const encrypted: string[] = []
  const status = shown(task.status, 'status', encrypted)
  const taskListId = shown(task.task_list_id, 'task_list', encrypted)
  const list = taskListId ? context.lists.find((entry) => entry.id === taskListId) ?? null : null
  const assigneeIds = shownList(task.assignees, 'assignees', encrypted)
  const marker = readRecurrenceMarker(task.recurrence_next)
  const row: TaskRow = {
    id: task.id,
    title: shown(task.title, 'title', encrypted),
    status,
    // No stored status is Aurora's to-do; an encrypted one is unknown.
    status_group: encrypted.includes('status') ? null : taskStatusGroup(status, context.statuses),
    due_date: shown(task.due_date, 'due_date', encrypted),
    priority: shown(task.priority, 'priority', encrypted),
    task_list: taskListId ? { id: taskListId, name: list?.name ?? null } : null,
    assignees: assigneeIds.map((id) => ({ id, name: context.members.find((member) => member.id === id)?.name ?? null })),
    labels: shownList(task.labels, 'labels', encrypted),
    recurring: recurringOf(task.recurrence, marker, status, encrypted.includes('status'), context.statuses),
    updated_at: task.updated_at,
  }
  if (isEncryptedMetadataValue(task.recurrence) && !encrypted.includes('recurrence')) encrypted.push('recurrence')
  if (!task.recurrence && marker.state === 'encrypted') encrypted.push('recurrence_next')
  if (encrypted.length) row.encrypted_fields = encrypted
  return row
}

export function matchesTaskFilters(row: TaskRow, filters: TaskFilters, statuses: readonly TaskStatusDefinition[]): boolean {
  const completed = row.status !== null && isCompletedTaskStatus(row.status, statuses)
  // Asking for a done status or the done group is asking for completed tasks.
  const asksForDone = filters.statusGroup === 'done'
    || [...(filters.statuses ?? [])].some((status) => isCompletedTaskStatus(status, statuses))
  if (completed && !filters.includeCompleted && !asksForDone) return false
  if (filters.statuses) {
    const status = row.status ? canonicalTaskStatus(row.status, statuses) ?? row.status : null
    if (!status || !filters.statuses.has(status)) return false
  }
  if (filters.statusGroup && row.status_group !== filters.statusGroup) return false
  if (filters.taskListId !== undefined && row.task_list?.id !== filters.taskListId) return false
  if (filters.assigneeId !== undefined && !row.assignees.some((assignee) => assignee.id === filters.assigneeId)) return false
  if (filters.label !== undefined) {
    const wanted = filters.label.trim().toLowerCase()
    if (!row.labels.some((label) => label.trim().toLowerCase() === wanted)) return false
  }
  // A due date this server cannot read is unknown, not absent: no due-date filter matches it.
  const dueFiltered = filters.hasDueDate !== undefined || filters.dueBefore !== undefined
    || filters.dueAfter !== undefined || filters.overdue !== undefined
  if (dueFiltered && row.encrypted_fields?.includes('due_date')) return false
  const due = dueDateKey(row.due_date)
  if (filters.hasDueDate !== undefined && (due !== null) !== filters.hasDueDate) return false
  if (filters.dueBefore !== undefined && (due === null || due > filters.dueBefore)) return false
  if (filters.dueAfter !== undefined && (due === null || due < filters.dueAfter)) return false
  if (filters.overdue !== undefined) {
    const pastDue = due !== null && due < filters.today
    // Past due with an encrypted status: whether it is done, and so overdue, is unknown.
    if (pastDue && row.encrypted_fields?.includes('status')) return false
    const overdue = pastDue && !completed
    if (overdue !== filters.overdue) return false
  }
  // Unknown (null) matches neither true nor false.
  if (filters.recurring !== undefined && row.recurring !== filters.recurring) return false
  return true
}

/** Sorted with the id as the last key, so a page boundary never moves between calls. */
export function sortTaskRows(rows: TaskRow[], sort: TaskSort): TaskRow[] {
  const byId = (a: TaskRow, b: TaskRow) => a.id.localeCompare(b.id)
  const nullsLast = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b))
  return [...rows].sort((a, b) => {
    if (sort === 'updated_at') {
      // Newest first, never-dated last.
      if (a.updated_at === b.updated_at) return byId(a, b)
      if (a.updated_at === null) return 1
      if (b.updated_at === null) return -1
      return b.updated_at.localeCompare(a.updated_at) || byId(a, b)
    }
    if (sort === 'priority') {
      const rank = (row: TaskRow) => PRIORITY_RANK[row.priority?.trim().toLowerCase() ?? ''] ?? 4
      return rank(a) - rank(b) || nullsLast(a.due_date, b.due_date) || byId(a, b)
    }
    return nullsLast(a.due_date, b.due_date) || byId(a, b)
  })
}

/** A fingerprint of a query's filters and sort, so a cursor is used only with the query that made it. */
export function taskQueryFingerprint(query: Record<string, unknown>): string {
  const keys = Object.keys(query).filter((key) => key !== 'cursor' && key !== 'limit' && query[key] !== undefined).sort()
  return createHash('sha256').update(JSON.stringify(keys.map((key) => [key, query[key]]))).digest('hex').slice(0, 16)
}

export function encodeTaskCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ o: offset, q: fingerprint })).toString('base64url')
}

/** The offset a cursor names, or null when it is malformed or made by another query. */
export function decodeTaskCursor(cursor: string, fingerprint: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown; q?: unknown }
    if (parsed.q !== fingerprint || !Number.isInteger(parsed.o) || (parsed.o as number) < 0) return null
    return parsed.o as number
  } catch {
    return null
  }
}

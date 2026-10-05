import { SEED_ROWS } from './seed'
import { allRows, restoreAll, saveRows } from './local-store'
import { THRESHOLD_v1 } from './grouting-config'
import type { EntryRow } from './types'

/**
 * 同步注浆工作区存储：注浆记录主数据 + 登记/补浆幂等表放在同一个 localStorage 键里，
 * 一次提交要么整体落库、要么就地撤销。
 *
 * 同时把注浆行镜像回通用台账的 grouting 键——概览看板、CSV 导出仍按原读法取数，
 * 统计口径只有工作区这一个写入点，别处不会各算一遍。
 */

const WORKSPACE_STORAGE_KEY = 'shield-tunnel-construction:grouting-workspace'

export type IdempotencyMap = Record<string, { kind: 'register' | 'refill'; id: number; seq?: number }>

export type GroutingWorkspace = {
  rows: EntryRow[]
  idempotency: IdempotencyMap
  migrated: boolean
}

const LOCKED_VERSION_FIELD = '判定版本'
const VOLUME_FIELD = '注浆量'
const BATCH_FIELD = '批次编号'
const NEW_SCHEMA_PREFIX = 'GJ-'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 老版本地台账兼容：
 * - 全新环境或重置后：通用台账里就是新结构 seed（GJ- 编号），直接用，不重复接续。
 * - 老版本浏览器：台账里是 GROU- 占位数据，只有已经按新结构补录过（注浆量为数值、
 *   挂了拌制批次）的存量行才接续进工作区，并按对应环次锁定老经验版 v2026-0 留档。
 */
function legacyRowsToMerge(): EntryRow[] {
  const existing = allRows().grouting ?? []
  const isNewSeed = existing.some((row) => String(row['注浆编号'] ?? '').startsWith(NEW_SCHEMA_PREFIX))
  if (isNewSeed) {
    return []
  }
  return existing
    .filter((row) => {
      const volume = Number(row[VOLUME_FIELD])
      return Number.isFinite(volume) && volume > 0 && Boolean(String(row[BATCH_FIELD] ?? ''))
    })
    .map((row) => ({ ...row }))
}

function initialWorkspace(): GroutingWorkspace {
  const seedRows = clone(SEED_ROWS.grouting ?? [])
  const legacy = legacyRowsToMerge()
  let nextId = seedRows.reduce((max, row) => Math.max(max, Number(row.id)), 0)
  for (const row of legacy) {
    nextId += 1
    row.id = nextId
    seedRows.push(row)
  }
  for (const row of seedRows) {
    if (typeof row[LOCKED_VERSION_FIELD] !== 'string') {
      row[LOCKED_VERSION_FIELD] = THRESHOLD_v1.version
    }
  }
  return { rows: seedRows, idempotency: {}, migrated: true }
}

let cache: GroutingWorkspace | null = null

function persist(workspace: GroutingWorkspace): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace))
  }
}

export function readWorkspace(): GroutingWorkspace {
  if (cache) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = initialWorkspace()
    return cache
  }
  const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as GroutingWorkspace
      if (Array.isArray(parsed.rows)) {
        cache = { rows: parsed.rows, idempotency: parsed.idempotency ?? {}, migrated: true }
        saveRows('grouting', clone(cache.rows))
        return cache
      }
    } catch {
      /* 工作区读坏了就重新初始化，不阻断业务 */
    }
  }
  cache = initialWorkspace()
  persist(cache)
  saveRows('grouting', clone(cache.rows))
  return cache
}

/**
 * 整体提交：先写工作区主数据，再镜像通用台账。
 * 任一步写库失败都恢复两份缓存并抛出，调用方就地向班组提示已撤销。
 */
export function commitWorkspace(next: GroutingWorkspace): void {
  const snapshot = cache ? clone(cache) : null
  const entriesSnapshot = clone(allRows())
  try {
    cache = clone(next)
    persist(cache)
    saveRows('grouting', clone(next.rows))
  } catch (error) {
    cache = snapshot
    if (snapshot) {
      try {
        persist(snapshot)
      } catch {
        /* 回滚本身再失败也不再抛二次异常 */
      }
    }
    // 回滚内存缓存：通用台账 saveRows 成功前可能已经替换了 cache，这里整体还原
    restoreAll(entriesSnapshot)
    throw error
  }
}

export function workspaceStorageKey(): string {
  return WORKSPACE_STORAGE_KEY
}

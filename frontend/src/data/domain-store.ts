import { GROUTING_CONFIG_V1 } from './grouting-config'
import type { GroutingConfig } from './grouting-config'
import { judgeGrouting } from './grouting-judge'
import { SEED_ROWS } from './seed'
import type { EntryRow, EntryValue } from './types'

/**
 * 注浆域持久化。
 *
 * 历史上数据直接存在 shield-tunnel-construction:entries 下；为了放阈值版本、幂等账本，
 * 升级为 shield-tunnel-construction:v2 单个对象：
 *   { entries, groutingConfigs, activeConfigVersion, commandLedger }
 * 旧 key 一旦被识别为占位演示数据就整库按新种子替换（旧版本没有真正的登记入口，
 * 里面只有“同步注浆样例1”这类占位串，不存在要保留的用户数据）；不是占位数据则按
 * 对应环次补进台账后原样保留。
 */

const LEGACY_KEY = 'shield-tunnel-construction:entries'
const STORE_KEY = 'shield-tunnel-construction:v2'
const SCHEMA_VERSION = 2

type IdempotentCommand = { key: string; firstAt: string; resultMessage: string }

export type DomainState = {
  schemaVersion: number
  entries: Record<string, EntryRow[]>
  groutingConfigs: GroutingConfig[]
  activeConfigVersion: number
  /** 连着点两回仍按头一回：同一业务键在窗口内只执行一次，回执也回头一回的 */
  commandLedger: IdempotentCommand[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isPlaceholderLegacy(entries: Record<string, EntryRow[]>): boolean {
  const rows = entries.grouting ?? []
  return rows.some((row) => String(row['注浆编号'] ?? '').includes('样例'))
}

function numberOrNull(value: EntryValue | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

function isMakeupRow(row: EntryRow): boolean {
  return String(row['原注浆编号'] ?? '') !== ''
}

/**
 * 历史台账补档：存量注浆记录补齐判定字段，并按 v1 阈值判一遍，
 * 按对应环次/配比挂进新台账（历史结论按当时标准留档，迁移动作不覆盖原状态口径，
 * 仅在记录还没有判定结论时补判）。拌制批次补派生字段由 syncMortarDerived 统一算。
 */
function backfillLegacyRows(entries: Record<string, EntryRow[]>, config: GroutingConfig): void {
  const grouting = entries.grouting ?? []
  grouting.forEach((row, index) => {
    if (row['对应环号'] === undefined) row['对应环号'] = String(index + 12)
    if (row['浆液配比'] === undefined) row['浆液配比'] = config.mixes[0]?.code ?? 'A'
    if (row['注浆班组'] === undefined) row['注浆班组'] = ''
    if (row['拌制批次'] === undefined) row['拌制批次'] = ''
    if (row['超限持续秒数'] === undefined) row['超限持续秒数'] = 0
    if (row['判定配置版本'] === undefined) row['判定配置版本'] = config.version
    if (row['建议补浆量'] === undefined) row['建议补浆量'] = 0
    if (row['判定留档'] === undefined) row['判定留档'] = []

    const volume = numberOrNull(row['注浆量'])
    const alreadyJudged = typeof row['判定等级'] === 'string' && row['判定等级'] !== ''
    if (volume === null || alreadyJudged) {
      if (!alreadyJudged) {
        row['判定等级'] = ''
        row['判定说明'] = volume === null ? '计划注浆，注浆量未登记，暂不判定' : ''
        row['判定时间'] = row['判定时间'] ?? ''
      }
      return
    }
    const verdict = judgeGrouting(
      {
        volume,
        pressure: numberOrNull(row['注浆压力']),
        holdSeconds: numberOrNull(row['超限持续秒数']),
        mixCode: String(row['浆液配比']),
      },
      config,
    )
    row['判定等级'] = verdict.level
    row['判定说明'] = verdict.message
    row['建议补浆量'] = verdict.suggestFix
    row['判定时间'] = row['判定时间'] ?? ''
    // 迁移时不强行改写用户原有状态流，但欠量/压力超限的记录统一带进待补浆口径，
    // 保证补进台账后两边看到同一份待补浆。
    if (verdict.level === '欠量待补浆' || verdict.level === '压力待补浆') {
      if (row.status !== '已补浆') {
        row.status = '待补浆'
        row.pending = true
        row.abnormal = true
      }
    }
  })
}

function freshState(): DomainState {
  return {
    schemaVersion: SCHEMA_VERSION,
    entries: clone(SEED_ROWS),
    groutingConfigs: [clone(GROUTING_CONFIG_V1)],
    activeConfigVersion: GROUTING_CONFIG_V1.version,
    commandLedger: [],
  }
}

function stateFromLegacy(raw: Record<string, EntryRow[]>): DomainState {
  // 占位演示数据直接换新种子；真实存量数据迁移并按对应环次补档。
  const entries = isPlaceholderLegacy(raw) ? clone(SEED_ROWS) : { ...clone(SEED_ROWS), ...clone(raw) }
  const state: DomainState = {
    schemaVersion: SCHEMA_VERSION,
    entries,
    groutingConfigs: [clone(GROUTING_CONFIG_V1)],
    activeConfigVersion: GROUTING_CONFIG_V1.version,
    commandLedger: [],
  }
  if (!isPlaceholderLegacy(raw)) {
    backfillLegacyRows(entries, GROUTING_CONFIG_V1)
  }
  syncMortarDerived(state)
  return state
}

/**
 * 把注浆结论回写到拌制那边的待用清单：已用方量/剩余方量/待用结论/待补浆批次。
 * 注浆台账是唯一事实源，拌制侧只做回写派生——两个入口读到的是同一份。
 */
export function syncMortarDerived(state: DomainState): void {
  const batches = state.entries.mortar ?? []
  const grouting = state.entries.grouting ?? []
  const pendingBatchCodes = new Set(
    grouting
      .filter((row) => row.status === '待补浆')
      .map((row) => String(row['拌制批次'] ?? ''))
      .filter(Boolean),
  )

  batches.forEach((batch) => {
    const code = String(batch['批次编号'] ?? '')
    const total = numberOrNull(batch['拌制方量']) ?? 0
    // 注浆量要与浆液拌制的批次清单对得上：消耗以注浆台账登记量为准（含补浆）。
    const used = grouting
      .filter((row) => String(row['拌制批次'] ?? '') === code)
      .reduce((sum, row) => sum + (numberOrNull(row['注浆量']) ?? 0), 0)
    const remain = Math.round((total - used) * 100) / 100
    batch['已用方量'] = Math.round(used * 100) / 100
    batch['剩余方量'] = remain
    batch['待补浆批次'] = pendingBatchCodes.has(code)
    if (batch.status !== '检验合格') {
      batch['待用结论'] = '检验未完成，不在待用清单'
    } else if (pendingBatchCodes.has(code)) {
      const list = grouting
        .filter((row) => row.status === '待补浆' && String(row['拌制批次'] ?? '') === code)
        .map((row) => String(row['注浆编号']))
      batch['待用结论'] = `有 ${list.length} 条待补浆（${list.join('、')}），优先补浆`
    } else if (remain > 0) {
      batch['待用结论'] = `待用：剩余 ${remain}m³`
    } else {
      batch['待用结论'] = '已用尽'
    }
  })
}

function writeStorage(state: DomainState): void {
  // localStorage.setItem 抛错（配额/隐私模式）时由调用方就地撤销缓存。
  window.localStorage.setItem(STORE_KEY, JSON.stringify(state))
}

let cache: DomainState | null = null

function readState(): DomainState {
  if (cache) return cache
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = freshState()
    return cache
  }
  const rawV2 = window.localStorage.getItem(STORE_KEY)
  if (rawV2) {
    try {
      const parsed = JSON.parse(rawV2) as DomainState
      if (parsed && parsed.entries) {
        cache = normalizeState(parsed)
        return cache
      }
    } catch {
      // 落库内容损坏，回退到种子
    }
  }
  const legacy = window.localStorage.getItem(LEGACY_KEY)
  if (legacy) {
    try {
      const parsedLegacy = JSON.parse(legacy) as Record<string, EntryRow[]>
      cache = stateFromLegacy(parsedLegacy)
      writeStorage(cache)
      window.localStorage.removeItem(LEGACY_KEY)
      return cache
    } catch {
      // 旧数据损坏，换新种子
    }
  }
  cache = freshState()
  syncMortarDerived(cache)
  writeStorage(cache)
  return cache
}

/** 读盘后补默认字段，保证老缓存升级后字段齐全；派生值统一重算，避免两处各算一遍。 */
function normalizeState(state: DomainState): DomainState {
  if (!Array.isArray(state.groutingConfigs) || state.groutingConfigs.length === 0) {
    state.groutingConfigs = [clone(GROUTING_CONFIG_V1)]
  }
  if (!state.activeConfigVersion) {
    state.activeConfigVersion = Math.max(...state.groutingConfigs.map((item) => item.version))
  }
  if (!state.commandLedger) state.commandLedger = []
  if (!state.entries) state.entries = clone(SEED_ROWS)
  state.entries = { ...clone(SEED_ROWS), ...state.entries }
  backfillLegacyRows(state.entries, activeConfigOf(state))
  syncMortarDerived(state)
  return state
}

export function state(): DomainState {
  return readState()
}

export function allEntries(): Record<string, EntryRow[]> {
  return state().entries
}

export function entriesOf(key: string): EntryRow[] {
  return state().entries[key] ?? []
}

/**
 * 统一事务出口：先在草稿上跑改动，再一次性落库；落库失败就地撤销内存改动。
 * mutate 返回的内容都在 commit 后的同一份 state 上。
 */
export function commit<T>(mutate: (draft: DomainState) => T): T {
  const current = state()
  const snapshot = clone(current)
  const draft = clone(current)
  const result = mutate(draft)
  syncMortarDerived(draft)
  try {
    writeStorage(draft)
  } catch (error) {
    // 写库失败就地撤销：缓存回到事务前快照
    cache = snapshot
    throw new Error(error instanceof Error ? `写库失败，已就地撤销：${error.message}` : '写库失败，已就地撤销')
  }
  cache = draft
  return result
}

export function resetEntries(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  commit((draft) => {
    draft.entries[key] = rows
  })
  return rows
}

export function activeConfigOf(target: DomainState = state()): GroutingConfig {
  const found =
    target.groutingConfigs.find((item) => item.version === target.activeConfigVersion) ??
    target.groutingConfigs[target.groutingConfigs.length - 1]
  return found ?? GROUTING_CONFIG_V1
}

export function configsOf(): GroutingConfig[] {
  return state().groutingConfigs
}

// ── 幂等：连着点两回仍按头一回 ────────────────────────────────────────────────

const COMMAND_WINDOW_MS = 15_000

function pruneLedger(draft: DomainState, now: number): void {
  draft.commandLedger = draft.commandLedger.filter((item) => {
    return now - new Date(item.firstAt).getTime() < COMMAND_WINDOW_MS
  })
}

/**
 * 在窗口内同业务键只执行一次；第二次命中直接返回头一回的回执。
 * 返回 null 表示是头一回，调用方继续执行业务；否则返回头一回结果。
 */
export function firstCommand(
  draft: DomainState,
  key: string,
): { message: string } | null {
  const now = Date.now()
  pruneLedger(draft, now)
  const hit = draft.commandLedger.find((item) => item.key === key)
  if (hit) return { message: `${hit.resultMessage}（连续提交，已按头一回处理）` }
  return null
}

export function recordCommand(draft: DomainState, key: string, resultMessage: string): void {
  draft.commandLedger.push({ key, firstAt: new Date().toISOString(), resultMessage })
}

export { isMakeupRow, numberOrNull }

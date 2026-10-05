import {
  GROUTING_CREWS,
  THRESHOLD_v1,
  batchMixVolume,
  loadCurrentThreshold,
  mixRuleOf,
  thresholdByVersion,
} from './grouting-config'
import { allRows } from './local-store'
import { commitWorkspace, readWorkspace } from './workspace-store'
import type { GroutingWorkspace } from './workspace-store'
import type { EntryRow } from './types'
import type { GroutingThreshold, MixDesignRule } from './grouting-config'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 同步注浆业务域：登记判定、待补浆派单、补浆回挂、配比权限、阈值重算、批次对账。
 * 注浆与拌制两个页面看到的「待补浆批次」「注浆结论」都从这里的同一份数据派生，
 * 谁也不另算一遍。
 */

// 注浆记录字段（沿用全模块统一的中文列）
export const F_BATCH_NO = '批次编号'
export const F_REPORTED_MIX = '填报配比'
export const F_DESIGN_MIX = '设计配比'
export const F_VOLUME = '注浆量'
export const F_PRESSURE = '注浆压力'
export const F_PRESSURE_DURATION = '压力超限持续秒'
export const F_RING = '对应环号'
export const F_CREW = '注浆班组'
export const F_LEADER = '班组负责人'
export const F_SET_TIME = '初凝时间'
export const F_LOCKED_VERSION = '判定版本'

// 域内留痕字段（不进通用导出模板，页面按名字读）
export const F_LOCKED_RESULT = '历史判定留档'
export const F_CURRENT_RESULT = '现行复核结果'
export const F_CURRENT_VERSION = '现行复核版本'
export const F_REFILLS = '补浆流水'

export const STATUS_PENDING_REFILL = '待补浆'
export const STATUS_DONE = '已完成'
export const STATUS_REFILLED = '已补浆'
export const BATCH_QUALIFIED = '检验合格'

export type RefillEntry = {
  seq: number
  batchNo: string
  volume: number
  pressure: number
  operator: string
  leader: string
  time: string
  idemKey: string
}

export type Judgement = {
  version: string
  reportedMix: string
  effectiveMix: string
  mixName: string
  batchNo: string
  batchQualified: boolean
  /** 配比/批次对账冲突说明，没有冲突为空串 */
  conflict: string
  batchOverflow: boolean
  volume: number
  designVolume: number
  ratio: number
  lowerVolume: number
  upperVolume: number
  lowerRatio: number
  upperRatio: number
  pressure: number
  pressureDuration: number
  pressureNormalUpper: number
  pressureSustained: boolean
  pressureSpikeOnly: boolean
  pressureBand: string
  underInjected: boolean
  overInjected: boolean
  needRefill: boolean
  suggestedRefill: number
  reasons: string[]
}

export type RefillBatchView = {
  batchNo: string
  mixCode: string
  mixName: string
  /** 该批次累计被占用方量（主注入 + 历次补浆） */
  occupiedVolume: number
  mixVolume: number | null
  items: {
    groutingNo: string
    ringNo: string
    crew: string
    lockedVersion: string
    suggestedRefill: number
    refilledVolume: number
    remainingRefill: number
    reasons: string[]
    conflict: string
  }[]
}

export type ServiceResult<T = EntryRow> = {
  ok: boolean
  message: string
  data?: T
  /** 幂等命中：连着点两回，第二回直接拿头一回的结果，不再落一条 */
  duplicated?: boolean
}

function numberField(row: EntryRow, field: string): number {
  const value = Number(row[field])
  return Number.isFinite(value) ? value : 0
}

/** 浮点容差：6.0×1.4=8.399999999999999 这种不能把正好顶格的量判成超注 */
const EPSILON = 1e-6

/**
 * 统一的应补方量算法（登记、补浆提交、看板剩余量都调它，禁止两处各算一遍）：
 * 欠注补到设计下限；压力持续超限按设计量 10% 复验补注；两项义务取大。
 */
export function requiredRefillGap(
  rule: MixDesignRule | undefined,
  volume: number,
  lowerVolume: number,
  designVolume: number,
  pressureSustained: boolean,
): number {
  if (!rule) {
    return 0
  }
  const underGap = volume < lowerVolume ? lowerVolume - volume : 0
  const pressureAllowance = pressureSustained ? designVolume * 0.1 : 0
  return Number(Math.max(underGap, pressureAllowance).toFixed(2))
}

function refillsOf(row: EntryRow): RefillEntry[] {
  const raw = row[F_REFILLS]
  if (typeof raw !== 'string' || raw === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as RefillEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function refilledVolume(row: EntryRow): number {
  return refillsOf(row).reduce((sum, item) => sum + (Number(item.volume) || 0), 0)
}

function batchRows(): EntryRow[] {
  return allRows().mortar ?? []
}

function batchMap(): Map<string, EntryRow> {
  return new Map(batchRows().map((row) => [String(row['批次编号']), row]))
}

/**
 * 单条判定：登记量对照该配比的设计用量区间，压力按区间判持续超限。
 * 配比以拌制批次「检验合格」携带的配比编码为准；批次缺失/不合格/对不上都记冲突。
 */
export function judgeRow(
  row: EntryRow,
  threshold: GroutingThreshold,
  batches: Map<string, EntryRow>,
  occupiedVolume = 0,
): Judgement {
  const reportedMix = String(row[F_REPORTED_MIX] ?? row[F_DESIGN_MIX] ?? '')
  const batchNo = String(row[F_BATCH_NO] ?? '')
  const batch = batchNo ? batches.get(batchNo) : undefined
  const batchQualified = String(batch?.status ?? '') === BATCH_QUALIFIED
  const batchMixCode = batch ? String(batch['配比编码'] ?? '') : ''
  const batchMixVolumeValue = batch ? batchMixVolume(batch) : null

  // 班组说法 vs 拌制批次主数据打架时，听拌制检验合格批次的；批次不可信就回退填报值并记冲突
  let effectiveMix = reportedMix
  let conflict = ''
  if (!batch) {
    conflict = `批次${batchNo || '（空）'}在拌制清单里查不到，注浆量无法对账`
  } else if (!batchQualified) {
    conflict = `批次${batchNo}状态为「${String(batch.status)}」，不是检验合格批次，配比不作数`
  } else if (batchMixCode && batchMixCode !== reportedMix) {
    conflict = `班组填报配比${reportedMix}，但检验合格批次${batchNo}带的是${batchMixCode}，以批次为准`
    effectiveMix = batchMixCode
  } else if (batchMixCode) {
    effectiveMix = batchMixCode
  }

  const rule: MixDesignRule | undefined = mixRuleOf(threshold, effectiveMix)
  const volume = numberField(row, F_VOLUME)
  const pressure = numberField(row, F_PRESSURE)
  const duration = numberField(row, F_PRESSURE_DURATION)

  const designVolume = rule ? rule.designVolumePerRing : 0
  const lowerVolume = rule ? designVolume * rule.lowerRatio : 0
  const upperVolume = rule ? designVolume * rule.upperRatio : 0
  const ratio = designVolume > 0 ? volume / designVolume : 0

  const pressureSustained =
    pressure > threshold.pressure.normalUpper && duration >= threshold.pressure.minDurationSeconds
  const pressureSpikeOnly = pressure > threshold.pressure.normalUpper && !pressureSustained

  const batchOverflow =
    batchMixVolumeValue !== null && occupiedVolume + volume > batchMixVolumeValue * threshold.batchVolumeRatio

  // 比较留容差，避免 6.0×1.4=8.399999999999999 这类浮点误差把正好顶格的量判成超注
  const reasons: string[] = []
  if (!rule) {
    conflict = conflict || `配比编码${effectiveMix}不在配置里，找不到设计用量`
  }
  const overInjected = rule !== undefined && volume > upperVolume + EPSILON
  const underInjected = rule !== undefined && volume < lowerVolume - EPSILON
  if (overInjected) {
    reasons.push(
      `注浆量${volume}m³超过配比${effectiveMix}上限${upperVolume.toFixed(2)}m³（设计${designVolume}m³×${rule?.upperRatio}）`,
    )
  }
  if (underInjected) {
    reasons.push(
      `注浆量${volume}m³低于配比${effectiveMix}下限${lowerVolume.toFixed(2)}m³（设计${designVolume}m³×${rule?.lowerRatio}），属欠注`,
    )
  }
  if (pressureSustained) {
    reasons.push(
      `注浆压力${pressure}MPa持续${duration}秒超出${threshold.pressure.overBand}，疑似劈裂跑浆`,
    )
  } else if (pressureSpikeOnly) {
    reasons.push(
      `注浆压力${pressure}MPa瞬时冲入${threshold.pressure.overBand}，但持续不足${threshold.pressure.minDurationSeconds}秒，仅做复核提示`,
    )
  }
  if (batchOverflow) {
    reasons.push(`批次${batchNo}累计对账方量超过拌制方量${batchMixVolumeValue}m³`)
  }

  // 补多少由配置统一算，不许班组各打各的：
  // 欠注补到下限、压力持续超限按设计量 10% 复验补注，两种义务取大；补过的量从应补量里扣
  const gap = requiredRefillGap(rule, volume, lowerVolume, designVolume, pressureSustained)
  const suggestedRefill = Math.max(0, gap - refilledVolume(row))
  const needRefill = gap > 0 && refilledVolume(row) < gap - 1e-6

  return {
    version: threshold.version,
    reportedMix,
    effectiveMix,
    mixName: rule?.mixName ?? effectiveMix,
    batchNo,
    batchQualified,
    conflict,
    batchOverflow,
    volume,
    designVolume,
    ratio,
    lowerVolume,
    upperVolume,
    lowerRatio: rule?.lowerRatio ?? 0,
    upperRatio: rule?.upperRatio ?? 0,
    pressure,
    pressureDuration: duration,
    pressureNormalUpper: threshold.pressure.normalUpper,
    pressureSustained,
    pressureSpikeOnly,
    pressureBand: pressure > threshold.pressure.normalUpper ? threshold.pressure.overBand : threshold.pressure.normalBand,
    underInjected,
    overInjected,
    needRefill,
    suggestedRefill: Number(suggestedRefill.toFixed(2)),
    reasons,
  }
}

/** 按锁定版本重算一条（历史留档）；缺版本的老台账锁定老经验版 v2026-0。 */
export function lockedJudgement(row: EntryRow, batches = batchMap()): Judgement {
  const lockedVersion = typeof row[F_LOCKED_VERSION] === 'string' ? row[F_LOCKED_VERSION] : THRESHOLD_v1.version
  return judgeRow(row, thresholdByVersion(lockedVersion), batches, occupiedByBatch(row, batches))
}

/** 当前配置下重算一条（现行复核，只提示不翻历史案）。 */
export function currentJudgement(row: EntryRow, batches = batchMap()): Judgement {
  return judgeRow(row, loadCurrentThreshold(), batches, occupiedByBatch(row, batches))
}

/** 该批次除本条之外已被占用的方量，用于拌制清单对账。 */
function occupiedByBatch(target: EntryRow, batches: Map<string, EntryRow>): number {
  const batchNo = String(target[F_BATCH_NO] ?? '')
  if (!batchNo) {
    return 0
  }
  return readWorkspace().rows
    .filter((row) => Number(row.id) !== Number(target.id) && String(row[F_BATCH_NO] ?? '') === batchNo)
    .reduce((sum, row) => sum + numberField(row, F_VOLUME) + refilledVolume(row), 0)
}

function nextGroutingNo(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = /GJ-(\d+)/.exec(String(row['注浆编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `GJ-${String(max + 1).padStart(4, '0')}`
}

function assertLeader(crewName: string, leader: string): string | null {
  const crew = GROUTING_CREWS.find((item) => item.crewName === crewName)
  if (!crew) {
    return `「${crewName}」不在注浆班组名册里，跨班组提交一律拦下`
  }
  if (!crew.leaders.includes(leader)) {
    return `只有${crewName}的负责人（${crew.leaders.join('、')}）能提交，${leader}不是该班负责人，已拦下`
  }
  return null
}

function load(): GroutingWorkspace {
  const workspace = readWorkspace()
  return ensureArchived(workspace)
}

/**
 * 首次装载时把存量记录按锁定版本做一次判定固化（历史留档），现行复核也一并落库。
 * 已留档的不动；只在缺判定快照时补这一次，之后阈值再改也只刷新现行复核列。
 */
function ensureArchived(workspace: GroutingWorkspace): GroutingWorkspace {
  const batches = batchMap()
  const current = loadCurrentThreshold()
  let touched = false
  const rows = workspace.rows.map((row) => {
    if (typeof row[F_LOCKED_RESULT] === 'string' && row[F_LOCKED_RESULT] !== '') {
      return row
    }
    touched = true
    const locked = judgeRow(row, thresholdByVersion(String(row[F_LOCKED_VERSION] ?? '')), batches, occupiedByBatch(row, batches))
    return {
      ...row,
      [F_LOCKED_RESULT]: JSON.stringify(locked),
      [F_CURRENT_RESULT]: JSON.stringify(judgeRow(row, current, batches, occupiedByBatch(row, batches))),
      [F_CURRENT_VERSION]: current.version,
    }
  })
  if (!touched) {
    return workspace
  }
  const next = { ...workspace, rows }
  try {
    commitWorkspace(next)
  } catch {
    // 首次归档落库失败不挡读：内存里已有判定结果，下次操作还会再试
    return next
  }
  return next
}

function save(workspace: GroutingWorkspace, rows: EntryRow[]): void {
  // 在副本上改完，带着当前配置的现行复核结果一起整体落库；写库失败由 commit 就地回滚。
  // 历史判定（F_LOCKED_RESULT）原样不动，这里只刷新现行复核。
  const batches = batchMap()
  const threshold = loadCurrentThreshold()
  const refreshed = rows.map((row) => ({
    ...row,
    [F_CURRENT_RESULT]: JSON.stringify(judgeRow(row, threshold, batches, occupiedByBatch(row, batches))),
    [F_CURRENT_VERSION]: threshold.version,
  }))
  commitWorkspace({ ...workspace, rows: refreshed })
}

export type RegisterInput = {
  ringNo: string
  batchNo: string
  mixCode: string
  volume: number
  pressure: number
  pressureDuration: number
  crewName: string
  leader: string
  setTime: string
  operator: string
  idemKey: string
}

/** 登记一条同步注浆：超上限/批次对不上/跨班组，一律不保存。 */
export function registerGrouting(input: RegisterInput): ServiceResult {
  const deny = assertLeader(input.crewName, input.leader)
  if (deny) {
    return { ok: false, message: deny }
  }
  const workspace = load()
  const hit = workspace.idempotency[input.idemKey]
  if (hit?.kind === 'register') {
    const existed = workspace.rows.find((row) => Number(row.id) === hit.id)
    if (existed) {
      return { ok: true, duplicated: true, message: '重复提交已忽略，仍按头一回登记的记录作数', data: existed }
    }
  }

  const batches = batchMap()
  const batch = batches.get(input.batchNo)
  if (!batch) {
    return { ok: false, message: `批次${input.batchNo}在拌制批次清单里查不到，注浆量无法对账，不许登记` }
  }
  if (String(batch.status) !== BATCH_QUALIFIED) {
    return { ok: false, message: `批次${input.batchNo}是「${String(batch.status)}」，只有检验合格批次能用于同步注浆` }
  }
  const batchMixCode = String(batch['配比编码'] ?? '')
  if (!batchMixCode) {
    return { ok: false, message: `批次${input.batchNo}没带配比编码，设计用量无对照依据` }
  }
  if (batchMixCode !== input.mixCode) {
    return {
      ok: false,
      message: `班组填的配比${input.mixCode}与检验合格批次${input.batchNo}的${batchMixCode}打架，以批次配比为准，请改按${batchMixCode}登记`,
    }
  }
  const threshold = loadCurrentThreshold()
  const rule = mixRuleOf(threshold, batchMixCode)
  if (!rule) {
    return { ok: false, message: `配比${batchMixCode}不在阈值配置里，找不到设计用量` }
  }
  if (!(input.volume > 0)) {
    return { ok: false, message: '注浆量必须大于 0' }
  }
  const lowerVolume = rule.designVolumePerRing * rule.lowerRatio
  const upperVolume = rule.designVolumePerRing * rule.upperRatio
  if (input.volume > upperVolume + EPSILON) {
    return {
      ok: false,
      message: `注浆量${input.volume}m³超出${rule.mixName}上限${upperVolume.toFixed(2)}m³（设计${rule.designVolumePerRing}m³×${rule.upperRatio}），按经验多打不允许保存`,
    }
  }

  // 拌制批次对账：累计占用（含本单 + 历次补浆）不得超过拌制方量
  const occupied = workspace.rows
    .filter((row) => String(row[F_BATCH_NO] ?? '') === input.batchNo)
    .reduce((sum, row) => sum + numberField(row, F_VOLUME) + refilledVolume(row), 0)
  const mixVolume = batchMixVolume(batch)
  if (mixVolume !== null && occupied + input.volume > mixVolume * threshold.batchVolumeRatio + 1e-6) {
    return {
      ok: false,
      message: `批次${input.batchNo}拌制方量${mixVolume}m³，已对账占用${occupied.toFixed(2)}m³，再注${input.volume}m³对不上，不许登记`,
    }
  }

  const id = workspace.rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const draft: EntryRow = {
    id,
    status: STATUS_DONE,
    pending: true,
    abnormal: false,
    注浆编号: nextGroutingNo(workspace.rows),
    [F_RING]: input.ringNo,
    [F_BATCH_NO]: input.batchNo,
    [F_REPORTED_MIX]: input.mixCode,
    [F_DESIGN_MIX]: batchMixCode,
    [F_VOLUME]: input.volume,
    [F_PRESSURE]: input.pressure,
    [F_PRESSURE_DURATION]: input.pressureDuration,
    [F_CREW]: input.crewName,
    [F_LEADER]: input.leader,
    [F_SET_TIME]: input.setTime,
    [F_LOCKED_VERSION]: threshold.version,
    [F_REFILLS]: '',
  }
  const judgement = judgeRow(draft, threshold, batches, occupied)
  // 压力持续超限：登记不拦（量没超），但直接派单转待补浆，并写明超的是哪个区间
  const needRefill = judgement.needRefill
  const row: EntryRow = {
    ...draft,
    status: needRefill ? STATUS_PENDING_REFILL : STATUS_DONE,
    pending: needRefill,
    abnormal: judgement.overInjected || judgement.batchOverflow || judgement.conflict.length > 0,
    [F_LOCKED_RESULT]: JSON.stringify(judgement),
    [F_CURRENT_RESULT]: JSON.stringify(judgement),
    [F_CURRENT_VERSION]: threshold.version,
  }
  const rows = [...workspace.rows, row]
  try {
    save({ ...workspace, idempotency: { ...workspace.idempotency, [input.idemKey]: { kind: 'register', id } } }, rows)
  } catch (error) {
    return { ok: false, message: `写库失败，已就地撤销本次登记：${errorText(error)}` }
  }
  if (input.volume < lowerVolume) {
    return { ok: true, data: row, message: `${String(row['注浆编号'])}已登记：注浆量低于下限，直接转为待补浆（${judgement.reasons.join('；')}）` }
  }
  if (needRefill) {
    return { ok: true, data: row, message: `${String(row['注浆编号'])}已登记并转为待补浆：${judgement.reasons.join('；')}` }
  }
  return { ok: true, data: row, message: `${String(row['注浆编号'])}已登记，判定合格` }
}

export type RefillInput = {
  id: number
  batchNo?: string
  volume: number
  pressure: number
  leader: string
  operator: string
  idemKey: string
}

/** 补浆完成：流水挂回原注浆编号，绝不另起一条。 */
export function submitRefill(input: RefillInput): ServiceResult {
  const workspace = load()
  const index = workspace.rows.findIndex((row) => Number(row.id) === Number(input.id))
  if (index < 0) {
    return { ok: false, message: `没有找到注浆记录 ${input.id}` }
  }
  const original = workspace.rows[index]
  const groutingNo = String(original['注浆编号'])
  const crewName = String(original[F_CREW] ?? '')
  const deny = assertLeader(crewName, input.leader)
  if (deny) {
    return { ok: false, message: deny }
  }

  const hit = workspace.idempotency[input.idemKey]
  if (hit?.kind === 'refill' && hit.id === Number(input.id)) {
    const existed = workspace.rows.find((row) => Number(row.id) === hit.id)
    if (existed) {
      return { ok: true, duplicated: true, message: `补浆重复提交已忽略，仍挂在${groutingNo}头一回的流水下`, data: existed }
    }
  }

  const batches = batchMap()
  const batchNo = input.batchNo || String(original[F_BATCH_NO] ?? '')
  const batch = batches.get(batchNo)
  if (!batch || String(batch.status) !== BATCH_QUALIFIED) {
    return { ok: false, message: `补浆批次${batchNo}不存在或未检验合格，不许提交` }
  }

  const locked = lockedJudgement(original, batches)
  const priorRefills = refillsOf(original)
  const gap = requiredRefillGap(
    mixRuleOf(thresholdByVersion(String(original[F_LOCKED_VERSION])), locked.effectiveMix),
    locked.volume,
    locked.lowerVolume,
    locked.designVolume,
    locked.pressureSustained,
  )
  const remaining = Math.max(0, gap - priorRefills.reduce((sum, item) => sum + item.volume, 0))
  if (remaining <= 0) {
    return { ok: false, message: `${groutingNo}应补方量已补齐，不能再补` }
  }
  const rule = mixRuleOf(thresholdByVersion(String(original[F_LOCKED_VERSION])), locked.effectiveMix)
  const lower = remaining * (rule?.refillLowerRatio ?? 0.9)
  const upper = remaining * (rule?.refillUpperRatio ?? 1.1)
  if (!(input.volume > 0)) {
    return { ok: false, message: '补浆量必须大于 0' }
  }
  if (input.volume < lower - 1e-6 || input.volume > upper + 1e-6) {
    return {
      ok: false,
      message: `本次补浆${input.volume}m³超出统一算法允许区间 ${lower.toFixed(2)}～${upper.toFixed(2)}m³（应补剩余${remaining.toFixed(2)}m³），不许提交`,
    }
  }

  // 对账：补浆也占用拌制批次方量
  const occupied = workspace.rows
    .filter((row) => String(row[F_BATCH_NO] ?? '') === batchNo && Number(row.id) !== Number(original.id))
    .reduce((sum, row) => sum + numberField(row, F_VOLUME) + refilledVolume(row), 0)
  const selfOccupied =
    String(original[F_BATCH_NO] ?? '') === batchNo ? numberField(original, F_VOLUME) + priorRefills.reduce((s, i) => s + i.volume, 0) : 0
  const mixVolume = batchMixVolume(batch)
  if (mixVolume !== null && occupied + selfOccupied + input.volume > mixVolume + 1e-6) {
    return { ok: false, message: `批次${batchNo}拌制方量${mixVolume}m³不够再补${input.volume}m³，对不上账` }
  }

  const entry: RefillEntry = {
    seq: priorRefills.length + 1,
    batchNo,
    volume: input.volume,
    pressure: input.pressure,
    operator: input.operator,
    leader: input.leader,
    time: new Date().toISOString().slice(0, 16).replace('T', ' '),
    idemKey: input.idemKey,
  }
  const refills = [...priorRefills, entry]
  const refilled = refills.reduce((sum, item) => sum + item.volume, 0)
  const finished = refilled >= gap - 1e-6
  const updated: EntryRow = {
    ...original,
    [F_BATCH_NO]: batchNo,
    [F_REFILLS]: JSON.stringify(refills),
    status: finished ? STATUS_REFILLED : STATUS_PENDING_REFILL,
    pending: !finished,
    abnormal: finished ? false : original.abnormal,
  }
  const rows = [...workspace.rows]
  rows[index] = updated
  try {
    save({ ...workspace, idempotency: { ...workspace.idempotency, [input.idemKey]: { kind: 'refill', id: Number(original.id), seq: entry.seq } } }, rows)
  } catch (error) {
    return { ok: false, message: `写库失败，补浆流水已就地撤销：${errorText(error)}` }
  }
  return {
    ok: true,
    data: updated,
    message: finished
      ? `${groutingNo}第${entry.seq}次补浆${input.volume}m³已挂回原编号，应补量补齐，结论改为已补浆`
      : `${groutingNo}第${entry.seq}次补浆${input.volume}m³已挂回原编号，还差${(gap - refilled).toFixed(2)}m³，仍为待补浆`,
  }
}

export type MixChangeInput = {
  id: number
  mixCode: string
  leader: string
}

/** 改浆液配比：只有本注浆班组自己的负责人能改，跨班组一律拦下。 */
export function changeMix(input: MixChangeInput): ServiceResult {
  const workspace = load()
  const index = workspace.rows.findIndex((row) => Number(row.id) === Number(input.id))
  if (index < 0) {
    return { ok: false, message: `没有找到注浆记录 ${input.id}` }
  }
  const original = workspace.rows[index]
  const crewName = String(original[F_CREW] ?? '')
  const deny = assertLeader(crewName, input.leader)
  if (deny) {
    return { ok: false, message: deny }
  }
  const batches = batchMap()
  const batchNo = String(original[F_BATCH_NO] ?? '')
  const batch = batches.get(batchNo)
  if (!batch || String(batch.status) !== BATCH_QUALIFIED) {
    return { ok: false, message: `批次${batchNo}不是检验合格批次，配比以批次为准，不能改` }
  }
  const batchMixCode = String(batch['配比编码'] ?? '')
  if (input.mixCode !== batchMixCode) {
    return { ok: false, message: `配比只能改成检验合格批次携带的${batchMixCode}，班组口头说法不作数` }
  }

  // 配比变了，已登记注浆量要对照新配比重算上限：超限直接不许改
  const threshold = loadCurrentThreshold()
  const rule = mixRuleOf(threshold, input.mixCode)
  if (!rule) {
    return { ok: false, message: `配比${input.mixCode}不在阈值配置里` }
  }
  const volume = numberField(original, F_VOLUME)
  const upperVolume = rule.designVolumePerRing * rule.upperRatio
  if (volume > upperVolume + EPSILON) {
    return { ok: false, message: `改成${rule.mixName}后注浆量${volume}m³超过新上限${upperVolume.toFixed(2)}m³，不能保存此次配比修改` }
  }

  const updated: EntryRow = { ...original, [F_REPORTED_MIX]: input.mixCode, [F_DESIGN_MIX]: input.mixCode }
  const rows = [...workspace.rows]
  rows[index] = updated
  try {
    save(workspace, rows)
  } catch (error) {
    return { ok: false, message: `写库失败，配比修改已就地撤销：${errorText(error)}` }
  }
  return { ok: true, data: updated, message: `${String(original['注浆编号'])}配比已由${input.leader}改为${input.mixCode}，并按新配比重新判定` }
}

/**
 * 调整阈值后的全量重算：历史锁定版本结论原样留档，只刷新「现行复核」。
 * 派单义务（待补浆/已补浆）一律以锁定版本为准，不在这里翻案。
 */
export function recomputeWithCurrentThreshold(): { version: string; changed: number; total: number } {
  const workspace = load()
  const batches = batchMap()
  const threshold = loadCurrentThreshold()
  let changed = 0
  const rows = workspace.rows.map((row) => {
    if (String(row.status) === '待注浆' || String(row.status) === '注浆中') {
      return row
    }
    const judgement = judgeRow(row, threshold, batches, occupiedByBatch(row, batches))
    if (String(row[F_CURRENT_VERSION]) !== threshold.version) {
      changed += 1
    }
    return { ...row, [F_CURRENT_RESULT]: JSON.stringify(judgement), [F_CURRENT_VERSION]: threshold.version }
  })
  try {
    commitWorkspace({ ...workspace, rows })
  } catch (error) {
    throw new Error(`阈值重算写库失败，已撤销：${errorText(error)}`)
  }
  return { version: threshold.version, changed, total: rows.length }
}

export type GroutingRowView = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | Judgement | RefillEntry[]
  locked: Judgement
  current: Judgement
  refills: RefillEntry[]
  remainingRefill: number
  /** 历史派单是否仍敞开：只看锁定版本，现行复核不能翻案也不能新增派单 */
  pendingRefill: boolean
}

function toView(row: EntryRow): GroutingRowView {
  const locked = parseJudgement(row[F_LOCKED_RESULT]) ?? lockedJudgement(row)
  const current = parseJudgement(row[F_CURRENT_RESULT]) ?? currentJudgement(row)
  const refills = refillsOf(row)
  const refilled = refills.reduce((sum, item) => sum + item.volume, 0)
  const gap = requiredRefillGap(
    mixRuleOf(thresholdByVersion(String(row[F_LOCKED_VERSION] ?? '')), locked.effectiveMix),
    locked.volume,
    locked.lowerVolume,
    locked.designVolume,
    locked.pressureSustained,
  )
  return {
    ...row,
    locked,
    current,
    refills,
    remainingRefill: Number(Math.max(0, gap - refilled).toFixed(2)),
    pendingRefill: String(row.status) === STATUS_PENDING_REFILL,
  }
}

function parseJudgement(raw: string | number | boolean | undefined): Judgement | null {
  if (typeof raw !== 'string' || raw === '') {
    return null
  }
  try {
    return JSON.parse(raw) as Judgement
  } catch {
    return null
  }
}

export function listGrouting(filters: Record<string, string> = {}): GroutingRowView[] {
  const rows = load().rows
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  return rows
    .filter((row) => pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())))
    .map(toView)
}

export function getGrouting(id: number): GroutingRowView | undefined {
  return load()
    .rows.filter((row) => Number(row.id) === Number(id))
    .map(toView)[0]
}

/**
 * 待补浆批次：注浆侧与拌制侧共用这一份派生结果。
 * 按拌制批次聚合仍敞开的历史派单（锁定版本），两边入口读到的必然是同一份。
 */
export function pendingRefillBatches(ringFilter = ''): RefillBatchView[] {
  const batches = batchMap()
  const threshold = loadCurrentThreshold()
  const grouped = new Map<string, RefillBatchView>()
  for (const view of listGrouting(ringFilter ? { [F_RING]: ringFilter } : {})) {
    if (!view.pendingRefill || view.remainingRefill <= 0) {
      continue
    }
    const batchNo = String(view[F_BATCH_NO] ?? '')
    const batch = batches.get(batchNo)
    const mixCode = String(batch?.['配比编码'] ?? view.locked.effectiveMix)
    const rule = mixRuleOf(threshold, mixCode)
    let group = grouped.get(batchNo)
    if (!group) {
      group = {
        batchNo,
        mixCode,
        mixName: rule?.mixName ?? mixCode,
        occupiedVolume: 0,
        mixVolume: batch ? batchMixVolume(batch) : null,
        items: [],
      }
      grouped.set(batchNo, group)
    }
    group.items.push({
      groutingNo: String(view['注浆编号']),
      ringNo: String(view[F_RING]),
      crew: String(view[F_CREW]),
      lockedVersion: view.locked.version,
      suggestedRefill: view.remainingRefill,
      refilledVolume: view.refills.reduce((sum, item) => sum + item.volume, 0),
      remainingRefill: view.remainingRefill,
      reasons: view.locked.reasons.filter((reason) => !reason.startsWith('注浆压力') || view.locked.pressureSustained),
      conflict: view.locked.conflict,
    })
  }
  for (const view of listGrouting()) {
    const batchNo = String(view[F_BATCH_NO] ?? '')
    const group = grouped.get(batchNo)
    if (group) {
      group.occupiedVolume += view.locked.volume + view.refills.reduce((sum, item) => sum + item.volume, 0)
    }
  }
  return [...grouped.values()].map((group) => ({
    ...group,
    occupiedVolume: Number(group.occupiedVolume.toFixed(2)),
  }))
}

export type GroutingStats = {
  totalVolume: number
  pendingCount: number
  avgPressure: string
  abnormalCount: number
}

/** 统一统计口径：注浆页卡片和别处引用都调这里，禁止两处各算一遍。 */
export function groutingStats(): GroutingStats {
  const rows = listGrouting()
  const measured = rows.filter((row) => !['待注浆', '注浆中'].includes(String(row.status)))
  const totalVolume = measured.reduce((sum, row) => sum + row.locked.volume, 0)
  const pendingCount = rows.filter((row) => row.pendingRefill).length
  const avgPressure = measured.length
    ? (measured.reduce((sum, row) => sum + row.locked.pressure, 0) / measured.length).toFixed(2)
    : '0.00'
  const abnormalCount = rows.filter((row) => Boolean(row.abnormal)).length
  return {
    totalVolume: Number(totalVolume.toFixed(2)),
    pendingCount,
    avgPressure,
    abnormalCount,
  }
}

/** 拌制侧待用清单的注浆结论：由注浆同一份数据回写派生，两处读到同一份。 */
export function groutingConclusionForBatch(batchNo: string): {
  linked: number
  pendingRefill: number
  done: number
  totalInjected: number
  text: string
} {
  const views = listGrouting().filter((row) => String(row[F_BATCH_NO] ?? '') === batchNo)
  const pendingRefill = views.filter((row) => row.pendingRefill).length
  const done = views.filter((row) => [STATUS_DONE, STATUS_REFILLED].includes(String(row.status))).length
  const totalInjected = Number(
    views.reduce((sum, row) => sum + row.locked.volume + row.refills.reduce((s, item) => s + item.volume, 0), 0).toFixed(2),
  )
  let text = '未被注浆引用'
  if (views.length > 0) {
    text = pendingRefill > 0 ? `待补浆 ${pendingRefill} 单` : `已注浆 ${views.length} 单，结论合格`
  }
  return { linked: views.length, pendingRefill, done, totalInjected, text }
}

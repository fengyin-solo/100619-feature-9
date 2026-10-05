import { mixOf } from '@/data/grouting-config'
import type { GroutingConfig, MixDesign } from '@/data/grouting-config'
import { judgeGrouting } from '@/data/grouting-judge'
import type { GroutingVerdict } from '@/data/grouting-judge'
import {
  activeConfigOf,
  commit,
  configsOf,
  entriesOf,
  firstCommand,
  isMakeupRow,
  numberOrNull,
  recordCommand,
} from '@/data/domain-store'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import type { SessionRole } from '@/stores/session'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

/** 调服务时传进来的当班操作人（结构与 stores/session 的 identity 一致） */
export type Operator = {
  role: SessionRole
  crew: string
  label: string
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 注浆状态只能由判定/补浆事务驱动，通用动作不能绕过阈值把记录随便改状态。
  if (key === 'grouting') {
    return {
      ok: false,
      message: '同步注浆状态由「登记判定 / 完成补浆」自动给出，不允许手动改状态',
    }
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ── 同步注浆：按配比与压力的判定 ───────────────────────────────────────────────

export type GroutingFormInput = {
  对应环号: string
  浆液配比: string
  注浆量: number | null
  注浆压力: number | null
  超限持续秒数: number | null
  初凝时间: string
  拌制批次: string
}

export type MakeupFormInput = {
  注浆量: number
  注浆压力: number | null
  超限持续秒数: number | null
  初凝时间: string
  拌制批次: string
}

type VerdictArchive = { 等级: string; 说明: string; 版本: number; 建议补浆量: number; 时间: string }

const STATUS_PENDING_MAKEUP = '待补浆'
const STATUS_DONE = '已完成'
const STATUS_MAKEUP_DONE = '已补浆'
const STATUS_PLAN = '待注浆'

function crewDefaultMix(crewName: string): string {
  const crew = entriesOf('crew').find((row) => String(row['班组名称'] ?? '') === crewName)
  return String(crew?.['默认配比'] ?? '') || 'A'
}

function crewLeader(crewName: string): string {
  const crew = entriesOf('crew').find((row) => String(row['班组名称'] ?? '') === crewName)
  return String(crew?.['班组长'] ?? '')
}

function nextPrimaryCode(rows: EntryRow[]): string {
  let max = 100
  rows.forEach((row) => {
    const code = String(row['注浆编号'] ?? '')
    const matched = /^GROU-(\d+)$/.exec(code)
    if (matched) max = Math.max(max, Number(matched[1]))
  })
  return `GROU-${max + 1}`
}

function childrenOf(rows: EntryRow[], parentCode: string): EntryRow[] {
  return rows.filter((row) => String(row['原注浆编号'] ?? '') === parentCode)
}

function archiveVerdict(row: EntryRow, when: string): void {
  if (!row['判定等级']) return
  const list = Array.isArray(row['判定留档']) ? (row['判定留档'] as VerdictArchive[]) : []
  const version = Number(row['判定配置版本'])
  // 同一版本只留一版：重算/连点不重复进档；历史版本按当时标准留档。
  if (list.some((item) => item.版本 === version)) return
  list.push({
    等级: String(row['判定等级']),
    说明: String(row['判定说明'] ?? ''),
    版本: version,
    建议补浆量: Number(row['建议补浆量'] ?? 0),
    时间: String(row['判定时间'] ?? when),
  })
  row['判定留档'] = list
}

function applyVerdict(row: EntryRow, verdict: GroutingVerdict, config: GroutingConfig, when: string): void {
  // 先把改判前那一版（当时标准下的结论）留档
  archiveVerdict(row, when)
  row['判定等级'] = verdict.level
  row['判定说明'] = verdict.message
  row['判定配置版本'] = verdict.configVersion
  row['建议补浆量'] = verdict.suggestFix
  row['判定时间'] = when

  if (isMakeupRow(row)) {
    row.status = STATUS_MAKEUP_DONE
    row.pending = false
    row.abnormal = false
  } else if (childrenOf(entriesOf('grouting'), String(row['注浆编号'])).length > 0) {
    row.status = STATUS_MAKEUP_DONE
    row.pending = false
    row.abnormal = false
  } else if (row['注浆量'] === null || row['注浆量'] === '') {
    row.status = STATUS_PLAN
    row.pending = true
    row.abnormal = false
  } else if (verdict.level === '欠量待补浆' || verdict.level === '压力待补浆') {
    row.status = STATUS_PENDING_MAKEUP
    row.pending = true
    row.abnormal = true
  } else if (verdict.level === '超量拒绝') {
    // 新阈值下老记录越过了上限：记录保留留档，标异常，不允许再扩大注浆量。
    row.status = STATUS_DONE
    row.pending = false
    row.abnormal = true
  } else {
    row.status = STATUS_DONE
    row.pending = false
    row.abnormal = false
  }
  // 再把新阈值下的结论留档；同一版本去重，历史版本按当时标准保留。
  archiveVerdict(row, when)
}

function findBatch(code: string): EntryRow | undefined {
  return entriesOf('mortar').find((row) => String(row['批次编号'] ?? '') === code)
}

/** 注浆量与拌制批次清单对账：批次要合格、配比要一致、剩余方量要够。 */
function checkBatch(code: string, mixCode: string, volume: number): { ok: boolean; message: string } {
  if (!code) return { ok: false, message: '必须选择浆液拌制批次，注浆量要与批次清单对得上' }
  const batch = findBatch(code)
  if (!batch) return { ok: false, message: `拌制批次「${code}」不在批次清单里` }
  if (batch.status !== '检验合格') {
    return { ok: false, message: `批次「${code}」当前状态「${batch.status}」，检验合格后才准使用` }
  }
  if (String(batch['配比代码'] ?? '') !== mixCode) {
    return {
      ok: false,
      message: `批次「${code}」是 ${batch['配比代码']} 型浆液，与本条记录登记的 ${mixCode} 型配比不一致，配比以登记的设计配比为准`,
    }
  }
  const remain = numberOrNull(batch['剩余方量']) ?? 0
  if (remain + 1e-9 < volume) {
    return { ok: false, message: `批次「${code}」剩余 ${remain}m³，不够本次 ${volume}m³，请换批次` }
  }
  return { ok: true, message: '' }
}

function assertSubmitter(operator: Operator, crewName: string): ActionResult | null {
  if (operator.role === 'admin') {
    return { ok: false, message: '管理员不替班组登记注浆，请切换到注浆班组负责人或注浆手身份' }
  }
  if (operator.role === 'other' || !operator.crew) {
    return { ok: false, message: `「${operator.label}」不是注浆作业班组，跨工种提交一律拦下` }
  }
  if (crewName !== operator.crew) {
    return {
      ok: false,
      message: `记录属于「${crewName}」，当前身份属于「${operator.crew}」，跨班组提交一律拦下`,
    }
  }
  return null
}

/**
 * 统一事务出口：先在草稿上跑改动，再一次性落库；落库失败 domain-store 会就地撤销内存，
 * 这里把异常收成失败回执，不抛到页面。
 */
function transact(run: (draft: import('@/data/domain-store').DomainState) => ActionResult): ActionResult {
  try {
    return commit(run)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '写库失败，已就地撤销' }
  }
}

/** 登记一条同步注浆记录；注浆量高于该配比上限直接拒绝，不允许保存。 */
export function registerGrouting(input: GroutingFormInput, operator: Operator): ActionResult {
  const ring = String(input.对应环号 ?? '').trim()
  if (!ring) return { ok: false, message: '对应环号必填' }
  const ringRow = entriesOf('ring').find((row) => String(row['环号'] ?? '') === ring)
  if (!ringRow) return { ok: false, message: `环号「${ring}」不在掘进环次台账里，请先核对环次` }

  // 记录归属班组以掘进环次台账上的责任班组为准（不是提交人选谁就是谁），
  // 跨班组提交在这里拦死。
  const crewName = String(ringRow['掘进班组'] ?? '').trim()
  const denied = assertSubmitter(operator, crewName)
  if (denied) return denied

  const config = activeConfigOf()
  const mix = mixOf(config, input.浆液配比)
  if (!mix) return { ok: false, message: `配比「${input.浆液配比}」不在当前阈值版本 v${config.version} 里` }

  // 只有本注浆班组负责人能改浆液配比：注浆手登记时强制用班组默认配比。
  if (operator.role !== 'leader' && input.浆液配比 !== crewDefaultMix(crewName)) {
    return {
      ok: false,
      message: `只有本注浆班组负责人（${crewLeader(crewName)}）能改浆液配比，注浆手按班组默认配比 ${crewDefaultMix(crewName)} 登记；班组说法与设计配比不一致时，以登记的设计配比为准`,
    }
  }

  const hasVolume = input.注浆量 !== null && !Number.isNaN(input.注浆量)
  if (hasVolume && (input.注浆量 as number) <= 0) {
    return { ok: false, message: '注浆量必须大于 0' }
  }
  let batchCheck = { ok: true, message: '' }
  if (hasVolume) {
    batchCheck = checkBatch(input.拌制批次, input.浆液配比, input.注浆量 as number)
    if (!batchCheck.ok) return batchCheck
  }

  const verdict = judgeGrouting(
    {
      volume: hasVolume ? (input.注浆量 as number) : null,
      pressure: input.注浆压力,
      holdSeconds: input.超限持续秒数,
      mixCode: input.浆液配比,
    },
    config,
  )
  if (verdict.level === '超量拒绝') {
    return { ok: false, message: verdict.message }
  }
  if (verdict.level === '无效') {
    return { ok: false, message: verdict.message }
  }

  return transact((draft) => {
    const dup = firstCommand(draft, `register:${ring}:${input.初凝时间}:${input.注浆量 ?? 'plan'}:${crewName}`)
    if (dup) return { ok: false, message: dup.message }

    const rows = draft.entries.grouting
    const code = nextPrimaryCode(rows)
    const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    const now = new Date().toISOString()
    const row: EntryRow = {
      id,
      status: STATUS_PLAN,
      pending: true,
      abnormal: false,
      注浆编号: code,
      对应环号: ring,
      浆液配比: input.浆液配比,
      注浆量: hasVolume ? (input.注浆量 as number) : null,
      注浆压力: input.注浆压力,
      超限持续秒数: input.超限持续秒数,
      初凝时间: input.初凝时间,
      注浆班组: crewName,
      拌制批次: hasVolume ? input.拌制批次 : '',
      判定等级: '',
      判定说明: '',
      建议补浆量: 0,
      判定配置版本: config.version,
      判定时间: hasVolume ? now : '',
      判定留档: [],
    }
    if (hasVolume) {
      row['判定等级'] = verdict.level
      row['判定说明'] = verdict.message
      row['建议补浆量'] = verdict.suggestFix
    } else {
      row['判定说明'] = '计划注浆，注浆量未登记，暂不判定'
    }
    rows.push(row)
    recordCommand(draft, `register:${ring}:${input.初凝时间}:${input.注浆量 ?? 'plan'}:${crewName}`, `${code} 已登记`)
    return {
      ok: true,
      message:
        verdict.level === '欠量待补浆' || verdict.level === '压力待补浆'
          ? `${code} 已登记并转待补浆：${verdict.message}`
          : hasVolume
            ? `${code} 已登记，判定${verdict.level}`
            : `${code} 已登记为待注浆计划`,
      code,
    }
  })
}

/** 补浆完成：新记录挂回原注浆编号（编号带 -B1/-B2），不许另起一条主记录。 */
export function submitMakeup(parentId: number, input: MakeupFormInput, operator: Operator): ActionResult {
  const parent = entriesOf('grouting').find((row) => Number(row.id) === parentId)
  if (!parent) return { ok: false, message: '没有找到原注浆记录' }
  if (isMakeupRow(parent)) return { ok: false, message: '补浆记录不能再补浆，请选择原注浆编号' }
  if (parent.status !== STATUS_PENDING_MAKEUP) {
    return { ok: false, message: `原记录「${parent['注浆编号']}」当前是「${parent.status}」，不是待补浆状态` }
  }
  const denied = assertSubmitter(operator, String(parent['注浆班组']))
  if (denied) return denied

  if (!input.注浆量 || input.注浆量 <= 0) return { ok: false, message: '补浆量必须大于 0' }
  const config = activeConfigOf()
  const mixCode = String(parent['浆液配比'])
  const batchCheck = checkBatch(input.拌制批次, mixCode, input.注浆量)
  if (!batchCheck.ok) return batchCheck

  const parentCode = String(parent['注浆编号'])
  const previousChildren = childrenOf(entriesOf('grouting'), parentCode)
  const rejudge = judgeGrouting(
    {
      volume: numberOrNull(parent['注浆量']),
      pressure: numberOrNull(parent['注浆压力']),
      holdSeconds: numberOrNull(parent['超限持续秒数']),
      mixCode,
    },
    config,
  )
  const already = previousChildren.reduce((sum, row) => sum + (numberOrNull(row['注浆量']) ?? 0), 0)
  const need = Math.max(0, Math.round((rejudge.suggestFix - already) * 100) / 100)
  if (need > 0 && input.注浆量 + 1e-9 < need) {
    return {
      ok: false,
      message: `本次补浆 ${input.注浆量}m³ 不够闭环：按 v${config.version} 还需补 ${need}m³（已补 ${already}m³，建议总量 ${rejudge.suggestFix}m³）`,
    }
  }

  return transact((draft) => {
    const draftRows = draft.entries.grouting
    const draftParent = draftRows.find((row) => Number(row.id) === parentId) as EntryRow
    const dup = firstCommand(draft, `makeup:${parentCode}`)
    if (dup) return { ok: false, message: dup.message }

    const seq = draftRows.filter((row) => String(row['原注浆编号'] ?? '') === parentCode).length + 1
    const id = draftRows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    const now = new Date().toISOString()
    const total =
      Math.round(((numberOrNull(draftParent['注浆量']) ?? 0) + already + input.注浆量) * 100) / 100
    const child: EntryRow = {
      id,
      status: STATUS_MAKEUP_DONE,
      pending: false,
      abnormal: false,
      注浆编号: `${parentCode}-B${seq}`,
      对应环号: String(draftParent['对应环号']),
      浆液配比: mixCode,
      注浆量: input.注浆量,
      注浆压力: input.注浆压力,
      超限持续秒数: input.超限持续秒数,
      初凝时间: input.初凝时间,
      注浆班组: String(draftParent['注浆班组']),
      拌制批次: input.拌制批次,
      原注浆编号: parentCode,
      判定等级: '补浆记录',
      判定说明: `挂回原注浆编号 ${parentCode} 的补浆记录，补浆 ${input.注浆量}m³，累计 ${total}m³`,
      建议补浆量: 0,
      判定配置版本: config.version,
      判定时间: now,
      判定留档: [],
    }
    draftRows.push(child)

    archiveVerdict(draftParent, now)
    const mix = mixOf(config, mixCode)
    draftParent['判定说明'] =
      `${rejudge.message}；补浆 ${Math.round((already + input.注浆量) * 100) / 100}m³ 后累计 ${total}m³` +
      (mix ? `（设计 ${mix.designVolume}m³）` : '') +
      '，已闭环'
    draftParent['判定等级'] = '补浆闭环'
    draftParent['建议补浆量'] = 0
    draftParent['判定配置版本'] = config.version
    draftParent['判定时间'] = now
    draftParent.status = STATUS_MAKEUP_DONE
    draftParent.pending = false
    draftParent.abnormal = false

    recordCommand(draft, `makeup:${parentCode}`, `${parentCode} 补浆已完成`)
    return { ok: true, message: `${parentCode} 补浆完成，补浆记录 ${child['注浆编号']} 已挂回原编号，累计 ${total}m³` }
  })
}

/** 改浆液配比：只有本注浆班组负责人能改；改完按当前阈值重判，越上限同样不允许保存。 */
export function changeGroutingMix(id: number, nextMixCode: string, operator: Operator): ActionResult {
  const row = entriesOf('grouting').find((item) => Number(item.id) === id)
  if (!row) return { ok: false, message: '没有找到该注浆记录' }
  if (isMakeupRow(row)) return { ok: false, message: '补浆记录的配比随原注浆编号，不能单独改' }
  const crewName = String(row['注浆班组'] ?? '')
  if (operator.role !== 'leader') {
    return { ok: false, message: `只有本注浆班组负责人（${crewLeader(crewName)}）能改浆液配比` }
  }
  if (operator.crew !== crewName) {
    return { ok: false, message: `该记录属于「${crewName}」，跨班组改配比一律拦下` }
  }
  const config = activeConfigOf()
  const mix = mixOf(config, nextMixCode)
  if (!mix) return { ok: false, message: `配比「${nextMixCode}」不在当前阈值版本 v${config.version} 里` }
  if (String(row['浆液配比']) === nextMixCode) {
    return { ok: false, message: `配比已经是 ${nextMixCode}，没有变化` }
  }
  const volume = numberOrNull(row['注浆量'])
  if (volume !== null) {
    const verdict = judgeGrouting(
      {
        volume,
        pressure: numberOrNull(row['注浆压力']),
        holdSeconds: numberOrNull(row['超限持续秒数']),
        mixCode: nextMixCode,
      },
      config,
    )
    if (verdict.level === '超量拒绝') {
      return { ok: false, message: `配比改不成 ${nextMixCode}：${verdict.message}` }
    }
  }

  return transact((draft) => {
    const target = draft.entries.grouting.find((item) => Number(item.id) === id) as EntryRow
    const dup = firstCommand(draft, `mix:${id}:${nextMixCode}`)
    if (dup) return { ok: false, message: dup.message }

    target['浆液配比'] = nextMixCode
    const v = volume === null ? null : judgeGrouting(
      {
        volume,
        pressure: numberOrNull(target['注浆压力']),
        holdSeconds: numberOrNull(target['超限持续秒数']),
        mixCode: nextMixCode,
      },
      config,
    )
    if (v && volume !== null) applyVerdict(target, v, config, new Date().toISOString())
    recordCommand(draft, `mix:${id}:${nextMixCode}`, `配比已改为 ${nextMixCode}`)
    return {
      ok: true,
      message:
        volume === null
          ? `配比已改为 ${nextMixCode}（${mix?.name ?? ''}），注浆量登记后判定`
          : `配比已改为 ${nextMixCode}（${mix?.name ?? ''}），已按 v${config.version} 重判：${v?.message ?? ''}`,
    }
  })
}

// ── 阈值配置：调整走发布新版本，已登记记录照新阈值重算，历史留档 ─────────────────

export type ConfigDraft = {
  note: string
  mixes: MixDesign[]
  warnPressure: { min: number; max: number }
  overPressure: { min: number; max: number }
  overHoldSeconds: number
  warnHoldSeconds: number
  pressureFixVolume: number
}

export function listGroutingConfigs(): GroutingConfig[] {
  return configsOf()
}

export function activeGroutingConfig(): GroutingConfig {
  return activeConfigOf()
}

export function draftFromActive(): ConfigDraft {
  const config = activeConfigOf()
  return JSON.parse(JSON.stringify({
    note: config.note,
    mixes: config.mixes,
    warnPressure: config.warnPressure,
    overPressure: config.overPressure,
    overHoldSeconds: config.overHoldSeconds,
    warnHoldSeconds: config.warnHoldSeconds,
    pressureFixVolume: config.pressureFixVolume,
  })) as ConfigDraft
}

function validateDraft(draft: ConfigDraft): string | null {
  if (!draft.note.trim()) return '版本说明必填'
  if (draft.mixes.length === 0) return '至少保留一档配比'
  for (const mix of draft.mixes) {
    if (!mix.code.trim()) return '配比代码不能为空'
    if (!(mix.minVolume > 0) || !(mix.designVolume > 0) || !(mix.maxVolume > 0)) {
      return `配比 ${mix.code} 的用量必须都大于 0`
    }
    if (mix.minVolume > mix.designVolume || mix.designVolume > mix.maxVolume) {
      return `配比 ${mix.code} 需满足 下限 ≤ 设计值 ≤ 上限`
    }
  }
  if (!(draft.warnPressure.min < draft.warnPressure.max)) return '预警压力区间下限要小于上限'
  if (!(draft.overPressure.min >= draft.warnPressure.max)) {
    return '超限压力下限不能低于预警压力上限'
  }
  if (draft.overHoldSeconds <= 0 || draft.warnHoldSeconds <= 0) return '持续判定秒数要大于 0'
  if (!(draft.pressureFixVolume > 0)) return '压力补浆固定量要大于 0'
  return null
}

function draftFingerprint(draft: ConfigDraft): string {
  return JSON.stringify(draft)
}

/** 用新阈值重算全部已登记注浆记录；同一版本下重复点不再重判（仍按头一回）。 */
function recomputeAll(draft: DomainDraftLike, config: GroutingConfig): { pending: number; abnormal: number } {
  const rows = draft.entries.grouting
  const when = new Date().toISOString()
  rows.forEach((row) => {
    // 补浆记录是挂回原编号的追加记录，不按单环区间重判；阈值调整只重判主记录。
    if (isMakeupRow(row)) {
      row.status = STATUS_MAKEUP_DONE
      row.pending = false
      row.abnormal = false
      return
    }
    const volume = numberOrNull(row['注浆量'])
    if (volume === null) {
      applyVerdict(
        row,
        {
          level: '无效',
          configVersion: config.version,
          mixCode: String(row['浆液配比']),
          designVolume: null,
          volumeRange: '',
          pressureNote: '',
          message: '计划注浆，注浆量未登记，暂不判定',
          suggestFix: 0,
          sameKey: `v${config.version}:${String(row['浆液配比'])}`,
        },
        config,
        when,
      )
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
    applyVerdict(row, verdict, config, when)
  })
  return {
    pending: rows.filter((row) => row.status === STATUS_PENDING_MAKEUP).length,
    abnormal: rows.filter((row) => row.abnormal).length,
  }
}

type DomainDraftLike = { entries: Record<string, EntryRow[]> }

export function publishGroutingConfig(draft: ConfigDraft, operator: Operator): ActionResult {
  if (operator.role !== 'admin') {
    return { ok: false, message: '只有值班管理员能发布判定阈值新版本；班组负责人只改本班组记录挂的配比' }
  }
  const invalid = validateDraft(draft)
  if (invalid) return { ok: false, message: invalid }
  const fingerprint = draftFingerprint(draft)
  const active = activeConfigOf()

  return transact((state) => {
    const dup = firstCommand(state, `publish:${fingerprint}`)
    if (dup) return { ok: false, message: dup.message }

    const version = Math.max(...state.groutingConfigs.map((item) => item.version)) + 1
    const config: GroutingConfig = {
      version,
      note: draft.note.trim(),
      publishedAt: new Date().toISOString().slice(0, 10),
      mixes: JSON.parse(JSON.stringify(draft.mixes)) as MixDesign[],
      warnPressure: { ...draft.warnPressure },
      overPressure: { ...draft.overPressure },
      overHoldSeconds: draft.overHoldSeconds,
      warnHoldSeconds: draft.warnHoldSeconds,
      pressureFixVolume: draft.pressureFixVolume,
    }
    state.groutingConfigs.push(config)
    state.activeConfigVersion = version
    const summary = recomputeAll(state, config)
    recordCommand(state, `publish:${fingerprint}`, `阈值 v${version} 已发布`)
    return {
      ok: true,
      message: `阈值 v${version} 已发布（接替 v${active.version}），已登记注浆记录全部照新阈值重算：待补浆 ${summary.pending} 条、异常 ${summary.abnormal} 条；历史结论按当时版本留档`,
      version,
    }
  })
}

/** 不动阈值，按当前在用版本手动重算一遍（同一版本连点按头一回）。 */
export function recomputeWithActive(operator: Operator): ActionResult {
  if (operator.role !== 'admin') {
    return { ok: false, message: '只有值班管理员能发起全量重算' }
  }
  const config = activeConfigOf()
  return transact((state) => {
    const dup = firstCommand(state, `recompute:v${config.version}`)
    if (dup) return { ok: true, message: `当前已是按 v${config.version} 判定的结果（连续提交，按头一回处理）` }
    const summary = recomputeAll(state, config)
    recordCommand(state, `recompute:v${config.version}`, `已按 v${config.version} 重算`)
    return {
      ok: true,
      message: `已按当前阈值 v${config.version} 重算全部注浆记录：待补浆 ${summary.pending} 条、异常 ${summary.abnormal} 条`,
    }
  })
}

// ── 注浆台账与拌制待用清单：同一份事实源，两处入口读法一致 ──────────────────────

export type PendingMakeupItem = {
  id: number
  注浆编号: string
  对应环号: string
  注浆班组: string
  浆液配比: string
  拌制批次: string
  建议补浆量: number
  判定说明: string
  判定等级: string
}

/** 待补浆记录：注浆页与拌制页都从这里取，看到的是同一份。 */
export function listPendingMakeups(): PendingMakeupItem[] {
  return entriesOf('grouting')
    .filter((row) => row.status === STATUS_PENDING_MAKEUP && !isMakeupRow(row))
    .map((row) => ({
      id: Number(row.id),
      注浆编号: String(row['注浆编号']),
      对应环号: String(row['对应环号']),
      注浆班组: String(row['注浆班组']),
      浆液配比: String(row['浆液配比']),
      拌制批次: String(row['拌制批次'] ?? ''),
      建议补浆量: numberOrNull(row['建议补浆量']) ?? 0,
      判定说明: String(row['判定说明'] ?? ''),
      判定等级: String(row['判定等级'] ?? ''),
    }))
}

/** 待补浆涉及的拌制批次：注浆页与拌制页必须看到同一份，直接读回写后的批次标记。 */
export function listPendingMakeupBatches(): EntryRow[] {
  return entriesOf('mortar').filter((row) => row['待补浆批次'] === true)
}

/** 拌制侧待用清单：检验合格且还有剩余方量的批次（注浆登记选批次也从这里取）。 */
export function listUsableMortarBatches(mixCode?: string): EntryRow[] {
  return entriesOf('mortar').filter((row) => {
    if (row.status !== '检验合格') return false
    if ((numberOrNull(row['剩余方量']) ?? 0) <= 0) return false
    if (mixCode && String(row['配比代码'] ?? '') !== mixCode) return false
    return true
  })
}

export type GroutingStats = {
  /** 已注入浆液总量 m³：主记录 + 补浆记录（补浆真实发生，计入总量），计划记录不计 */
  totalVolume: number
  /** 待补浆记录数（与 listPendingMakeups 同一份口径） */
  pendingMakeupCount: number
  /** 平均峰值注浆压力 MPa：只对已登记主记录取均值 */
  avgPressure: number
  /** 待补浆涉及拌制批次去重后的批次数 */
  pendingBatchCount: number
}

/** 同步注浆的统计只有这一个出口：看板、注浆页、拌制页都调它，不各算一遍。 */
export function groutingStats(): GroutingStats {
  const rows = entriesOf('grouting')
  const measured = rows.filter((row) => numberOrNull(row['注浆量']) !== null)
  const totalVolume = Math.round(
    measured.reduce((sum, row) => sum + (numberOrNull(row['注浆量']) ?? 0), 0) * 100,
  ) / 100
  const primaryWithPressure = rows.filter(
    (row) => !isMakeupRow(row) && numberOrNull(row['注浆压力']) !== null,
  )
  const pressureSum = primaryWithPressure.reduce(
    (sum, row) => sum + (numberOrNull(row['注浆压力']) ?? 0),
    0,
  )
  const avgPressure =
    primaryWithPressure.length === 0
      ? 0
      : Math.round((pressureSum / primaryWithPressure.length) * 1000) / 1000
  const pendingBatches = new Set(
    listPendingMakeups()
      .map((item) => item.拌制批次)
      .filter(Boolean),
  )
  return {
    totalVolume,
    pendingMakeupCount: listPendingMakeups().length,
    avgPressure,
    pendingBatchCount: pendingBatches.size,
  }
}

/** 拌制页统计：待拌制/合格/废弃沿用状态，再补一份与注浆侧同源的待补浆批次数。 */
export function mortarStats(): { usable: number; pendingBatchCount: number } {
  return {
    usable: listUsableMortarBatches().length,
    pendingBatchCount: listPendingMakeupBatches().length,
  }
}

/** 注浆页表格排序：主记录按环号排，补浆记录紧跟在原注浆编号后面。 */
export function listGroutingLedger(filters: Record<string, string> = {}): PageResult {
  const rows = listRows('grouting')
  const primaries = rows
    .filter((row) => !isMakeupRow(row))
    .sort((a, b) => {
      const ringDiff = Number(a['对应环号']) - Number(b['对应环号'])
      return ringDiff !== 0 ? ringDiff : Number(a.id) - Number(b.id)
    })
  const ordered: EntryRow[] = []
  primaries.forEach((primary) => {
    ordered.push(primary)
    childrenOf(rows, String(primary['注浆编号']))
      .sort((a, b) => String(a['注浆编号']).localeCompare(String(b['注浆编号'])))
      .forEach((child) => ordered.push(child))
  })
  const matched = filterRows(ordered, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 班组台账（页面选择班组/负责人时用） */
export function listGroutingCrews(): EntryRow[] {
  return entriesOf('crew').filter((row) => String(row['主要工种'] ?? '') === '同步注浆')
}

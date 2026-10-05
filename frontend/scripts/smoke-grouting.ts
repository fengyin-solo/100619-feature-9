// 判定/事务/幂等/对账逻辑的冒烟测试（node 下跑，localStorage 用内存桩）。
function memStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  }
}
;(globalThis as { window?: unknown; localStorage?: Storage }).window = globalThis
;(globalThis as { localStorage?: Storage }).localStorage = memStorage()

import { GROUTING_CONFIG_V1 } from '../src/data/grouting-config'
import { judgeGrouting } from '../src/data/grouting-judge'
import {
  activeGroutingConfig,
  changeGroutingMix,
  draftFromActive,
  groutingStats,
  listEntries,
  listGroutingLedger,
  listPendingMakeupBatches,
  listPendingMakeups,
  listUsableMortarBatches,
  publishGroutingConfig,
  recomputeWithActive,
  registerGrouting,
  submitMakeup,
} from '../src/api/local-service'
import type { ConfigDraft } from '../src/api/local-service'
import type { GroutingConfig } from '../src/data/grouting-config'
import { entriesOf } from '../src/data/domain-store'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const admin = { role: 'admin' as const, crew: '', label: '管理员' }
const g1Leader = { role: 'leader' as const, crew: '注浆一班', label: '赵建国' }
const g1Member = { role: 'member' as const, crew: '注浆一班', label: '周振国' }
const g2Leader = { role: 'leader' as const, crew: '注浆二班', label: '钱卫东' }
const other = { role: 'other' as const, crew: '综合拼装班', label: '孙立德' }

// ── 判定引擎边界 ──
let v = judgeGrouting({ volume: 7.0, pressure: 0.2, holdSeconds: 0, mixCode: 'A' }, GROUTING_CONFIG_V1)
check('A 型 7.0 > 6.33 超量拒绝', v.level === '超量拒绝', v.level)
v = judgeGrouting({ volume: 4.5, pressure: 0.2, holdSeconds: 0, mixCode: 'A' }, GROUTING_CONFIG_V1)
check('A 型 4.5 < 4.95 欠量待补浆', v.level === '欠量待补浆' && v.suggestFix === 1, `${v.level}/${v.suggestFix}`)
v = judgeGrouting({ volume: 5.5, pressure: 0.52, holdSeconds: 45, mixCode: 'A' }, GROUTING_CONFIG_V1)
check('压力 0.52 持续45s 转压力待补浆，说明写清超限区间', v.level === '压力待补浆' && v.message.includes('超限区间') && v.suggestFix === 0.5, v.message)
v = judgeGrouting({ volume: 5.5, pressure: 0.52, holdSeconds: 10, mixCode: 'A' }, GROUTING_CONFIG_V1)
check('压力 0.52 仅10s 不转待补浆（合格+留痕）', v.level === '合格' && v.message.includes('瞬时冲高'), v.level)
v = judgeGrouting({ volume: 6.0, pressure: 0.38, holdSeconds: 40, mixCode: 'B' }, GROUTING_CONFIG_V1)
check('预警区间 0.38 持续40s 不单独转待补浆', v.level === '合格' && v.message.includes('预警区间'), v.level)
v = judgeGrouting({ volume: 5.5, pressure: 0.2, holdSeconds: 0, mixCode: 'Z' }, GROUTING_CONFIG_V1)
check('未知配比判无效', v.level === '无效')
// 欠量+压力同时命中，补浆量取大
v = judgeGrouting({ volume: 4.6, pressure: 0.6, holdSeconds: 60, mixCode: 'A' }, GROUTING_CONFIG_V1)
check('欠量0.9与压力0.5同时命中取大0.9', v.suggestFix === 0.9 && v.level === '欠量待补浆' && v.message.includes('超限区间'), `${v.level}/${v.suggestFix}`)

// ── 种子初始口径 ──
const seedPending = listPendingMakeups()
check('种子待补浆为 GROU-102/GROU-103 两条', seedPending.length === 2 && seedPending.map((i) => i.注浆编号).join() === 'GROU-102,GROU-103', seedPending.map((i) => i.注浆编号).join())
const pendingBatchCodes = listPendingMakeupBatches().map((b) => b['批次编号'])
check('待补浆批次为 MORT-0001/MORT-0002 同一份', pendingBatchCodes.join() === 'MORT-0001,MORT-0002', pendingBatchCodes.join())
const stats = groutingStats()
check('注浆总量含补浆 45.1', stats.totalVolume === 45.1, String(stats.totalVolume))
check('平均压力 0.332', stats.avgPressure === 0.332, String(stats.avgPressure))
check('待补浆统计=2', stats.pendingMakeupCount === 2, String(stats.pendingMakeupCount))
// 批次对账：已用/剩余回写
const m1 = entriesOf('mortar').find((b) => b['批次编号'] === 'MORT-0001')
check('MORT-0001 已用10.1 剩1.9', m1?.['已用方量'] === 10.1 && m1?.['剩余方量'] === 1.9, `${m1?.['已用方量']}/${m1?.['剩余方量']}`)
check('MORT-0001 待用结论提示待补浆', String(m1?.['待用结论']).includes('待补浆'))

// ── 登记：权限与超量拒绝 ──
let r = registerGrouting({ 对应环号: '20', 浆液配比: 'A', 注浆量: 7.0, 注浆压力: 0.2, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g1Leader)
check('超量 7.0 不允许保存', !r.ok && r.message.includes('不允许保存'), r.message)
r = registerGrouting({ 对应环号: '20', 浆液配比: 'A', 注浆量: 5.5, 注浆压力: 0.2, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, other)
check('非注浆班组登记被拦', !r.ok && r.message.includes('跨工种'), r.message)
r = registerGrouting({ 对应环号: '20', 浆液配比: 'A', 注浆量: 5.5, 注浆压力: 0.2, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g2Leader)
check('跨班组登记被拦', !r.ok && r.message.includes('跨班组'), r.message)
r = registerGrouting({ 对应环号: '20', 浆液配比: 'B', 注浆量: 5.5, 注浆压力: 0.2, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g1Member)
check('注浆手改非默认配比被拦', !r.ok && r.message.includes('负责人'), r.message)
r = registerGrouting({ 对应环号: '20', 浆液配比: 'A', 注浆量: 5.5, 注浆压力: 0.2, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0002' }, g1Member)
check('批次配比不一致被拦（A 记录选 B 批次）', !r.ok && r.message.includes('不一致'), r.message)
r = registerGrouting({ 对应环号: '20', 浆液配比: 'A', 注浆量: 5.0, 注浆压力: 0.2, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g1Member)
check('注浆手按默认 A 合法登记 5.0 -> 合格', r.ok && r.code === 'GROU-110', r.message)
// 连点两回：同入参第二次被幂等拦
r = registerGrouting({ 对应环号: '20', 浆液配比: 'A', 注浆量: 5.0, 注浆压力: 0.2, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g1Member)
check('同表单连点第二次按头一回处理（不再新增）', !r.ok && r.message.includes('按头一回'), r.message)
check('登记后 GROU-110 只有一条', entriesOf('grouting').filter((x) => x['注浆编号'] === 'GROU-110').length === 1)

// 批次剩余被扣减
const m7 = entriesOf('mortar').find((b) => b['批次编号'] === 'MORT-0007')
check('MORT-0007 登记后剩余 5.0', m7?.['剩余方量'] === 5, String(m7?.['剩余方量']))
// 超批次余量登记
r = registerGrouting({ 对应环号: '20', 浆液配比: 'A', 注浆量: 5.5, 注浆压力: 0.2, 超限持续秒数: 0, 初凝时间: '2026-10-06', 拌制批次: 'MORT-0007' }, g1Member)
check('批次余量不足被拦', !r.ok && r.message.includes('不够'), r.message)

// 压力持续超限登记自动转待补浆（用二班责任环 14 与 B 批次；批次还在拌制中应被拦）
r = registerGrouting({ 对应环号: '14', 浆液配比: 'B', 注浆量: 6.0, 注浆压力: 0.5, 超限持续秒数: 40, 初凝时间: '2026-10-06', 拌制批次: 'MORT-0008' }, g2Leader)
// MORT-0008 还在拌制中 → 应被拦
check('未合格批次使用被拦', !r.ok && r.message.includes('检验合格'), r.message)

// ── 补浆：挂回原编号，不许另起 ──
const g102 = entriesOf('grouting').find((x) => x['注浆编号'] === 'GROU-102') as { id: number }
r = submitMakeup(g102.id, { 注浆量: 1.0, 注浆压力: 0.22, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g2Leader)
check('跨班组补浆被拦', !r.ok && r.message.includes('跨班组'), r.message)
r = submitMakeup(g102.id, { 注浆量: 0.3, 注浆压力: 0.22, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g1Leader)
check('补浆量不足以闭环被拦', !r.ok && r.message.includes('不够闭环'), r.message)
r = submitMakeup(g102.id, { 注浆量: 1.0, 注浆压力: 0.22, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g1Leader)
check('补浆完成生成 GROU-102-B1 挂回原编号', r.ok && r.message.includes('GROU-102-B1'), r.message)
const child = entriesOf('grouting').find((x) => x['注浆编号'] === 'GROU-102-B1')
check('补浆记录原注浆编号=GROU-102', child?.['原注浆编号'] === 'GROU-102')
const parentAfter = entriesOf('grouting').find((x) => x['注浆编号'] === 'GROU-102')
check('父记录状态变已补浆', parentAfter?.status === '已补浆', String(parentAfter?.status))
check('待补浆清单同步少一条（剩 GROU-103）', listPendingMakeups().map((i) => i.注浆编号).join() === 'GROU-103', listPendingMakeups().map((i) => i.注浆编号).join())
// 已闭环再补被拦
r = submitMakeup(g102.id, { 注浆量: 1.0, 注浆压力: 0.22, 超限持续秒数: 0, 初凝时间: '2026-10-05', 拌制批次: 'MORT-0007' }, g1Leader)
check('已补浆记录不能再补', !r.ok)
// 补浆记录消耗批次
const m7b = entriesOf('mortar').find((b) => b['批次编号'] === 'MORT-0007')
check('MORT-0007 补浆后剩余 4.0', m7b?.['剩余方量'] === 4, String(m7b?.['剩余方量']))

// ── 改配比：仅本班组负责人 ──
const g104 = entriesOf('grouting').find((x) => x['注浆编号'] === 'GROU-104') as { id: number }
r = changeGroutingMix(g104.id, 'A', g1Leader)
check('一班负责人改二班记录配比被拦', !r.ok && r.message.includes('跨班组'), r.message)
r = changeGroutingMix(g104.id, 'A', g2Leader)
check('二班负责人可改本记录，改后重判', r.ok && r.message.includes('v1'), r.message)
// 改成 C（上限5.98），GROU-104 注浆量6.0 → 超量拒绝修改
r = changeGroutingMix(g104.id, 'C', g2Leader)
check('改成 C 导致超上限，拒绝保存', !r.ok && r.message.includes('不允许保存'), r.message)
r = changeGroutingMix(g104.id, 'B', g1Member)
check('注浆手改配比被拦', !r.ok && r.message.includes('负责人'), r.message)

// ── 阈值发布新版本 + 存量重算 + 历史留档 ──
r = publishGroutingConfig({} as ConfigDraft, g1Leader)
check('非管理员发布阈值被拦', !r.ok)
const draft = draftFromActive()
draft.note = '收紧 A 型上限到 6.0'
;(draft.mixes.find((m) => m.code === 'A') as { maxVolume: number }).maxVolume = 6.0
r = publishGroutingConfig(JSON.parse(JSON.stringify(draft)) as ConfigDraft, admin)
check('管理员发布 v2 并重算', r.ok && r.message.includes('v2') && r.message.includes('重算'), r.message)
check('在用版本变 v2', activeGroutingConfig().version === 2)
const g101 = entriesOf('grouting').find((x) => x['注浆编号'] === 'GROU-101')
check('GROU-101 量5.6 在新上限6内仍合格', g101?.status === '已完成', String(g101?.status))
const archive = (g101?.['判定留档'] as { 版本: number }[]) ?? []
check('GROU-101 留档含 v1 与 v2 两版', archive.map((a) => a.版本).join() === '1,2', archive.map((a) => a.版本).join())
// 连点发布同草稿 → 幂等
const r2 = publishGroutingConfig(JSON.parse(JSON.stringify(draft)) as ConfigDraft, admin)
check('同草稿连点发布按头一回（不再出 v3）', !r2.ok && r2.message.includes('按头一回'), r2.message)
check('没有产生 v3', Math.max(...entriesOf('grouting').map(() => 0)) === 0 && activeGroutingConfig().version === 2)
// 手动重算幂等
r = recomputeWithActive(admin)
check('手动重算 v2 头一回执行', r.ok && !r.message.includes('已是最新'), r.message)
r = recomputeWithActive(admin)
check('手动重算连点按头一回', r.ok && r.message.includes('按头一回'), r.message)

// 把 A 上限再收紧到 5.5：GROU-101(5.6) 变超量异常，仍保留记录
const draft3 = draftFromActive()
draft3.note = '再收紧'
;(draft3.mixes.find((m) => m.code === 'A') as { maxVolume: number }).maxVolume = 5.5
publishGroutingConfig(JSON.parse(JSON.stringify(draft3)) as ConfigDraft, admin)
const g101b = entriesOf('grouting').find((x) => x['注浆编号'] === 'GROU-101')
check('收紧到5.5后 GROU-101 标异常但记录保留', g101b?.abnormal === true && g101b?.status === '已完成', `${g101b?.abnormal}/${g101b?.status}`)

// ── 台账排序：补浆紧跟父记录 ──
const ledgerCodes = listGroutingLedger().items.map((x) => x['注浆编号'])
const i102 = ledgerCodes.indexOf('GROU-102')
check('台账中 B1 紧跟 GROU-102', ledgerCodes[i102 + 1] === 'GROU-102-B1', ledgerCodes.slice(i102, i102 + 2).join())
const i106 = ledgerCodes.indexOf('GROU-106')
check('台账中 GROU-106-B1 紧跟 GROU-106', ledgerCodes[i106 + 1] === 'GROU-106-B1')

// ── 待用批次口径 ──
check('待用清单只列合格有余量的批次', listUsableMortarBatches().every((b) => b.status === '检验合格' && Number(b['剩余方量']) > 0))
check('MORT-0008 拌制中不在待用清单', !listUsableMortarBatches().some((b) => b['批次编号'] === 'MORT-0008'))

// ── 导出与总览仍可用 ──
const page = listEntries('grouting')
check('listEntries 仍返回注浆行', page.items.length === entriesOf('grouting').length)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

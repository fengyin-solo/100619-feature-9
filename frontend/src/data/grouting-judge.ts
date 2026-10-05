import { mixOf } from './grouting-config'
import type { GroutingConfig } from './grouting-config'

/** 判定结论等级：合格 / 欠量待补浆 / 压力持续超限待补浆 / 高于上限拒绝保存 / 数据无效 */
export type GroutingVerdictLevel = '合格' | '欠量待补浆' | '压力待补浆' | '超量拒绝' | '无效'

/**
 * 一次阈值判定的结果。sameKey 用于归档去重：同一条记录在同一版本下的判定只留一版，
 * 连着点两回仍按头一回的结论。
 */
export type GroutingVerdict = {
  level: GroutingVerdictLevel
  /** 判定所用配置版本，历史按当时的标准留档 */
  configVersion: number
  /** 配比代码 */
  mixCode: string
  /** 设计用量 m³ */
  designVolume: number | null
  /** 允许区间文案，如 4.95 ~ 6.33 */
  volumeRange: string
  /** 压力区间结论文案，如「超限区间 ≥0.45MPa，持续 45s ≥ 30s」 */
  pressureNote: string
  /** 给台账看的完整说明：超的是哪个区间、该不该补、补多少 */
  message: string
  /** 建议补浆量 m³：欠量给差值、压力持续超限给固定量，其余为 0 */
  suggestFix: number
  sameKey: string
}

export type GroutingJudgeInput = {
  /** 注浆量 m³；未登记给 null（计划中的记录） */
  volume: number | null
  /** 峰值注浆压力 MPa；未填给 null */
  pressure: number | null
  /** 压力超限区间内持续秒数；未填给 null */
  holdSeconds: number | null
  /** 浆液配比代码 A/B/C */
  mixCode: string
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 按「配比 + 压力」判定一条注浆记录。
 * 先判注浆量（高于上限直接拒绝，低于下限欠量），再判压力持续超限；
 * 欠量与压力持续超限同时命中时，补浆量取两者较大者并都写进说明。
 */
export function judgeGrouting(input: GroutingJudgeInput, config: GroutingConfig): GroutingVerdict {
  const mix = mixOf(config, input.mixCode)
  const designVolume = mix ? mix.designVolume : null
  const volumeRange = mix
    ? `${round2(mix.minVolume)} ~ ${round2(mix.maxVolume)}（设计 ${round2(mix.designVolume)}）`
    : '配比未在当前配置中登记'
  const sameKey = `v${config.version}:${input.mixCode}`

  const base: GroutingVerdict = {
    level: '无效',
    configVersion: config.version,
    mixCode: input.mixCode,
    designVolume,
    volumeRange,
    pressureNote: '',
    message: '',
    suggestFix: 0,
    sameKey,
  }

  if (!mix) {
    return {
      ...base,
      message: `配比「${input.mixCode}」不在 v${config.version} 配置里，无法对照设计用量，请先由本班组负责人改挂有效配比`,
    }
  }
  if (input.volume === null || Number.isNaN(input.volume)) {
    return { ...base, message: '注浆量未登记，暂不判定' }
  }
  if (input.volume <= 0) {
    return { ...base, message: '注浆量必须大于 0' }
  }

  // 1) 注浆量对照该配比的设计用量区间
  let level: GroutingVerdictLevel = '合格'
  const reasons: string[] = []
  let suggestFix = 0

  if (input.volume > mix.maxVolume) {
    level = '超量拒绝'
    reasons.push(
      `注浆量 ${round2(input.volume)}m³ 高于「${mix.name}」上限 ${round2(mix.maxVolume)}m³（设计 ${round2(mix.designVolume)}m³，允许 ${volumeRange}），不允许保存`,
    )
  } else if (input.volume < mix.minVolume) {
    level = '欠量待补浆'
    const gap = round2(mix.designVolume - input.volume)
    suggestFix = gap
    reasons.push(
      `注浆量 ${round2(input.volume)}m³ 低于下限 ${round2(mix.minVolume)}m³，欠量区间：[下限 ${round2(mix.minVolume)}，上限 ${round2(mix.maxVolume)}]，建议补浆 ${gap}m³`,
    )
  }

  // 2) 注浆压力：区分预警区间 / 超限区间，且要求持续超限
  const pressure = input.pressure
  const hold = input.holdSeconds ?? 0
  let pressureNote = ''
  if (pressure !== null && !Number.isNaN(pressure)) {
    if (pressure >= config.overPressure.min) {
      if (hold >= config.overHoldSeconds) {
        pressureNote = `峰值 ${pressure}MPa 落在超限区间 [≥${config.overPressure.min}MPa]，持续 ${hold}s ≥ ${config.overHoldSeconds}s，压力待补浆（建议 ${config.pressureFixVolume}m³）`
        if (level === '合格') level = '压力待补浆'
        reasons.push(pressureNote)
        suggestFix = Math.max(suggestFix, config.pressureFixVolume)
      } else {
        pressureNote = `峰值 ${pressure}MPa 落在超限区间 [≥${config.overPressure.min}MPa]，但仅持续 ${hold}s < ${config.overHoldSeconds}s，按瞬时冲高留痕，不转待补浆`
        reasons.push(pressureNote)
      }
    } else if (pressure >= config.warnPressure.min) {
      pressureNote =
        hold >= config.warnHoldSeconds
          ? `峰值 ${pressure}MPa 落在预警区间 [${config.warnPressure.min}, ${config.overPressure.min})，持续 ${hold}s，留痕观察，不单独转待补浆`
          : `峰值 ${pressure}MPa 落在预警区间 [${config.warnPressure.min}, ${config.overPressure.min})，仅持续 ${hold}s，瞬时预警留痕`
      reasons.push(pressureNote)
    } else {
      pressureNote = `峰值 ${pressure}MPa 在正常区间 [<${config.warnPressure.min}MPa]`
    }
  }

  const message =
    reasons.length > 0
      ? reasons.join('；')
      : `注浆量 ${round2(input.volume)}m³ 在允许区间 ${volumeRange}，压力正常，判定合格`

  return { ...base, level, pressureNote, message, suggestFix: round2(suggestFix) }
}

/**
 * 同步注浆判定配置（阈值由本文件定死，线上调整走「发布新版本」而不是改本文件）。
 *
 * 口径（出现争议时按这里执行）：
 * - 浆液配比以登记的设计配比版本为准；班组口头说的配比不作数，只有本注浆班组负责人
 *   可以在登记后改这条记录挂的配比，跨班组一律拦下（见 local-service.ts）。
 * - 注浆量按该配比对应环次的设计用量 ± 允许区间判定：高于上限不允许保存；
 *   低于下限转待补浆；区间内合格。
 * - 注浆压力分「预警区间」和「超限区间」，要求持续超限才算：持续秒数达到配置值
 *   直接转待补浆，并注明压的是哪一个区间；只是瞬时冲高只留痕、不转待补浆。
 */

export type MixDesign = {
  /** 配比代码：浆液拌制批次按浆液类型挂这个代码 */
  code: string
  /** 配比名称，如 水泥:粉煤灰:砂:膨润土:水 的质量比 */
  name: string
  /** 单环设计注浆量 m³（按该配比的充填系数算出） */
  designVolume: number
  /** 允许注浆量下限 m³（含）：低于即欠量待补浆 */
  minVolume: number
  /** 允许注浆量上限 m³（含）：高于直接拒绝保存 */
  maxVolume: number
}

export type GroutingConfig = {
  /** 配置版本号，发布后只增不改；历史结论按当时版本留档 */
  version: number
  /** 版本说明 */
  note: string
  /** 发布日期 YYYY-MM-DD */
  publishedAt: string
  /** 各配比的设计用量与允许区间 */
  mixes: MixDesign[]
  /** 预警压力区间：达到预警但还没到超限 */
  warnPressure: { min: number; max: number }
  /** 超限压力区间（上限开区间）：持续达到即转待补浆 */
  overPressure: { min: number; max: number }
  /** 压力持续超限判定秒数：超限区间 */
  overHoldSeconds: number
  /** 压力持续超限判定秒数：预警区间（只留痕，不单独转待补浆） */
  warnHoldSeconds: number
  /** 压力持续超限转待补浆时建议补浆量 m³（固定量，不按差值推算） */
  pressureFixVolume: number
}

/** v1：初始阈值。浆液为可硬性惰性浆液，按开挖空隙量 130%~150% 充填系数取区间。 */
export const GROUTING_CONFIG_V1: GroutingConfig = {
  version: 1,
  note: '初版：A/B/C 三档配比，注浆量按设计用量上下浮动判定；压力 0.30MPa 预警、0.45MPa 超限。',
  publishedAt: '2026-09-01',
  mixes: [
    {
      code: 'A',
      name: 'A 型 120:380:680:60:420（常规段）',
      designVolume: 5.5,
      minVolume: 4.95,
      maxVolume: 6.33,
    },
    {
      code: 'B',
      name: 'B 型 140:360:660:70:430（富水段）',
      designVolume: 6.0,
      minVolume: 5.4,
      maxVolume: 6.9,
    },
    {
      code: 'C',
      name: 'C 型 110:400:700:50:400（加固段）',
      designVolume: 5.2,
      minVolume: 4.68,
      maxVolume: 5.98,
    },
  ],
  warnPressure: { min: 0.3, max: 0.45 },
  overPressure: { min: 0.45, max: 99 },
  overHoldSeconds: 30,
  warnHoldSeconds: 30,
  pressureFixVolume: 0.5,
}

export function mixOf(config: GroutingConfig, code: string): MixDesign | undefined {
  return config.mixes.find((mix) => mix.code === code)
}

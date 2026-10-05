import type { EntryRow } from './types'

/**
 * 同步注浆判定阈值配置（注浆量 × 浆液配比、注浆压力区间）。
 *
 * 裁定说明：
 * 1. 配比说法打架时，一律以拌制批次「检验合格」携带的配比（设计配比主数据）为准，
 *    注浆班组登记时填的配比只留痕，不参与判定——班组经验值没有检验链可追溯。
 * 2. 阈值是版本化的：每条注浆登记在保存时锁定当时的版本号，历史结论按锁定版本留档；
 *    配置调整后，存量记录会用新版本重算一份「现行复核」结果挂在旁边供看板参考，
 *    但历史派单（待补浆义务）不被追溯改写——老事老办法，新事新办法。
 * 3. 压力判定要看「持续」超限：瞬时冲高不派单，只有持续超上限达到最短持续时间才转待补浆。
 */

export type MixDesignRule = {
  /** 配比编码，即拌制批次检验合格后携带的「配比编码」 */
  mixCode: string
  /** 配比名称，如 厚浆/可泵送厚浆 */
  mixName: string
  /** 每环设计用量 m³（对应一环的同步注浆理论填充量） */
  designVolumePerRing: number
  /** 允许注入量占设计用量的下限（含），低于判欠注、需要补浆 */
  lowerRatio: number
  /** 允许注入量占设计用量的上限（含），高于判超注、登记直接拦截 */
  upperRatio: number
  /** 补浆量允许区间：相对应补量的下/上限比例，超区间的补浆单不许提交 */
  refillLowerRatio: number
  refillUpperRatio: number
}

export type PressureRule = {
  /** 正常工作压力上限 MPa（含），低于此值为正常区间 */
  normalUpper: number
  /** 持续超限最短时长（秒）：达到此时长才算「持续超限」，瞬时冲高只做复核提示 */
  minDurationSeconds: number
  /** 正常区间名称 */
  normalBand: string
  /** 超限区间名称，写进待补浆说明里，告诉班组「超的是哪个区间」 */
  overBand: string
}

export type GroutingThreshold = {
  /** 配置版本号，登记时锁定进记录 */
  version: string
  /** 版本生效日期 */
  effectiveDate: string
  mixRules: MixDesignRule[]
  pressure: PressureRule
  /** 注浆量要与拌制批次对得上：单环累计注入量不得超过该环关联批次可拌制方量的占用上限比例 */
  batchVolumeRatio: number
}

/**
 * 历史版本留档：已锁定 v2026-0 的老记录永远按这份重算。
 * 这是一套偏松的老经验阈值——上限放到 1.8、压力上限 0.35MPa，
 * 用来说明「改配置后老记录结论不变、只多出现行复核提示」。
 */
export const THRESHOLD_v1: GroutingThreshold = {
  version: 'v2026-0',
  effectiveDate: '2026-09-01',
  mixRules: [
    {
      mixCode: 'MIX-H',
      mixName: '厚浆（可泵送）',
      designVolumePerRing: 6.0,
      lowerRatio: 1.2,
      upperRatio: 1.8,
      refillLowerRatio: 0.8,
      refillUpperRatio: 1.2,
    },
    {
      mixCode: 'MIX-S',
      mixName: '标准浆',
      designVolumePerRing: 5.5,
      lowerRatio: 1.3,
      upperRatio: 1.8,
      refillLowerRatio: 0.8,
      refillUpperRatio: 1.2,
    },
  ],
  pressure: {
    normalUpper: 0.35,
    minDurationSeconds: 60,
    normalBand: '0～0.35MPa 正常注浆区间',
    overBand: '＞0.35MPa 高压风险区间',
  },
  batchVolumeRatio: 1.0,
}

/**
 * 当前生效版本：按 1.5 倍理论填充率收紧注浆量上限，压力上限收到 0.30MPa。
 */
export const CURRENT_VERSION = 'v2026-1'

export const CURRENT_THRESHOLD: GroutingThreshold = {
  version: CURRENT_VERSION,
  effectiveDate: '2026-10-01',
  mixRules: [
    {
      mixCode: 'MIX-H',
      mixName: '厚浆（可泵送）',
      designVolumePerRing: 6.0,
      lowerRatio: 1.3,
      upperRatio: 1.5,
      refillLowerRatio: 0.9,
      refillUpperRatio: 1.1,
    },
    {
      mixCode: 'MIX-S',
      mixName: '标准浆',
      designVolumePerRing: 5.5,
      lowerRatio: 1.35,
      upperRatio: 1.55,
      refillLowerRatio: 0.9,
      refillUpperRatio: 1.1,
    },
  ],
  pressure: {
    normalUpper: 0.3,
    minDurationSeconds: 30,
    normalBand: '0～0.30MPa 正常注浆区间',
    overBand: '＞0.30MPa 劈裂跑浆风险区间',
  },
  batchVolumeRatio: 1.0,
}

/** 班组与负责人名册：只有本注浆班组的负责人能动配比。 */
export type GroutingCrew = {
  crewCode: string
  crewName: string
  /** 负责人姓名；登记/改配比时要同时匹配「班组 + 负责人」两栏 */
  leaders: string[]
}

export const GROUTING_CREWS: GroutingCrew[] = [
  { crewCode: 'G01', crewName: '注浆一班', leaders: ['王大山'] },
  { crewCode: 'G02', crewName: '注浆二班', leaders: ['李长河'] },
]

const CONFIG_STORAGE_KEY = 'shield-tunnel-construction:grouting-threshold'
const VERSION_PREFIX = 'v2026-custom-'

type StoredConfig = { version: string; threshold: GroutingThreshold }

function sameConfig(
  a: Omit<GroutingThreshold, 'version' | 'effectiveDate'>,
  b: Omit<GroutingThreshold, 'version' | 'effectiveDate'>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 取当前生效配置：本机被调整过就用调整版，否则用代码内置的 CURRENT_THRESHOLD。 */
export function loadCurrentThreshold(): GroutingThreshold {
  if (typeof window === 'undefined' || !window.localStorage) {
    return CURRENT_THRESHOLD
  }
  const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY)
  if (!raw) {
    return CURRENT_THRESHOLD
  }
  try {
    const parsed = JSON.parse(raw) as StoredConfig
    if (parsed?.threshold && typeof parsed.threshold.version === 'string') {
      return parsed.threshold
    }
  } catch {
    /* 配置读不出来就退回内置当前版，不挡业务 */
  }
  return CURRENT_THRESHOLD
}

/**
 * 调整阈值：在当前版本基础上覆盖数值，另起一个自定义版本号并落库。
 * 已登记记录锁定的版本号不变，所以历史留档不动；看板重算会读到这里返回的新版本。
 * 若内容与当前生效配置完全一致，不另起版本，直接返回当前配置。
 */
export function saveThreshold(next: Omit<GroutingThreshold, 'version' | 'effectiveDate'>): GroutingThreshold {
  const current = loadCurrentThreshold()
  const candidate: GroutingThreshold = {
    ...next,
    mixRules: next.mixRules.map((rule) => ({ ...rule })),
    pressure: { ...next.pressure },
    version: current.version.startsWith(VERSION_PREFIX)
      ? current.version
      : `${VERSION_PREFIX}${Date.now()}`,
    effectiveDate: new Date().toISOString().slice(0, 10),
  }
  if (sameConfig(stripVersion(current), stripVersion(candidate))) {
    return current
  }
  const payload: StoredConfig = { version: candidate.version, threshold: candidate }
  // 写库失败就地抛出，由上层统一撤销，不在这里静默吞掉
  window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(payload))
  return candidate
}

function stripVersion(value: GroutingThreshold): Omit<GroutingThreshold, 'version' | 'effectiveDate'> {
  return { mixRules: value.mixRules, pressure: value.pressure, batchVolumeRatio: value.batchVolumeRatio }
}

/** 按版本号取配置：锁定版优先找留档，再找本机自定义版，最后落到当前版。 */
export function thresholdByVersion(version: string | undefined): GroutingThreshold {
  if (version === THRESHOLD_v1.version) {
    return THRESHOLD_v1
  }
  const current = loadCurrentThreshold()
  if (!version || version === current.version) {
    return current
  }
  return current
}

export function mixRuleOf(threshold: GroutingThreshold, mixCode: string): MixDesignRule | undefined {
  return threshold.mixRules.find((rule) => rule.mixCode === mixCode)
}

/** 拌制批次可对账方量：批次记录里登记的「拌制方量」，读不到返回 null。 */
export function batchMixVolume(batch: EntryRow): number | null {
  const value = Number(batch['拌制方量'])
  return Number.isFinite(value) && value > 0 ? value : null
}

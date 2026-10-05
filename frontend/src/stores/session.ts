import { defineStore } from 'pinia'

/**
 * 当班操作人。纯前端没有登录体系，用顶栏切换身份模拟：
 * - admin（值班管理员）：能发布判定阈值新版本，但不参与注浆作业、改不了某条记录的配比；
 * - leader：本注浆班组负责人，只有他能改本班组记录的浆液配比、登记/补浆；
 * - member：本班组注浆手，能登记、补浆，但配比只能用班组默认配比，改配比一律拦下；
 * - other：跨班组/其他工种，注浆相关提交一律拦下。
 * 班组与配比说法打架时，听登记的设计配比（配置版本），不听任何人口头说法。
 */
export type SessionRole = 'admin' | 'leader' | 'member' | 'other'

export type SessionIdentity = {
  id: string
  label: string
  role: SessionRole
  /** 所属注浆班组名称；管理员与非注浆工种为空 */
  crew: string
  detail: string
}

export const SESSION_IDENTITIES: SessionIdentity[] = [
  { id: 'u-admin', label: '值班管理员', role: 'admin', crew: '', detail: '可发布阈值新版本，不能替班组登记或改配比' },
  { id: 'u-g1-leader', label: '赵建国（注浆一班·负责人）', role: 'leader', crew: '注浆一班', detail: '可改本班记录配比、登记注浆、完成补浆' },
  { id: 'u-g1-member', label: '周振国（注浆一班·注浆手）', role: 'member', crew: '注浆一班', detail: '可登记/补浆，配比用班组默认 A 型，不能改' },
  { id: 'u-g2-leader', label: '钱卫东（注浆二班·负责人）', role: 'leader', crew: '注浆二班', detail: '可改本班记录配比、登记注浆、完成补浆' },
  { id: 'u-g2-member', label: '吴海涛（注浆二班·注浆手）', role: 'member', crew: '注浆二班', detail: '可登记/补浆，配比用班组默认 B 型，不能改' },
  { id: 'u-other', label: '孙立德（综合拼装班·负责人）', role: 'other', crew: '综合拼装班', detail: '非注浆班组，注浆相关提交一律拦下' },
]

const SESSION_KEY = 'shield-tunnel-construction:session'

export const useSessionStore = defineStore('session', {
  state: () => {
    let identity = SESSION_IDENTITIES[1]
    if (typeof window !== 'undefined' && window.localStorage) {
      const savedId = window.localStorage.getItem(SESSION_KEY)
      const saved = SESSION_IDENTITIES.find((item) => item.id === savedId)
      if (saved) identity = saved
    }
    return {
      identity,
      operator: identity.label,
      shiftLabel: '白班 08:00-20:00',
      scope: '盾构隧道掘进施工管理平台',
    }
  },
  getters: {
    canOperate: (state) => state.operator.length > 0,
    role: (state) => state.identity.role,
    crew: (state) => state.identity.crew,
    isAdmin: (state) => state.identity.role === 'admin',
    /** 是某注浆班组的作业人员（负责人或注浆手） */
    isGroutingCrew: (state) =>
      (state.identity.role === 'leader' || state.identity.role === 'member') && state.identity.crew !== '',
    isLeader: (state) => state.identity.role === 'leader',
  },
  actions: {
    setIdentity(id: string) {
      const identity = SESSION_IDENTITIES.find((item) => item.id === id)
      if (!identity) return
      this.identity = identity
      this.operator = identity.label
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(SESSION_KEY, identity.id)
      }
    },
    setShift(label: string) {
      this.shiftLabel = label
    },
    /** 该身份能否替某个班组提交注浆作业；不能时给出拦截理由 */
    canSubmitFor(crewName: string): { ok: boolean; reason: string } {
      if (this.identity.role === 'admin') {
        return { ok: false, reason: '管理员不替班组登记注浆，请切换到注浆班组负责人或注浆手身份' }
      }
      if (this.identity.role === 'other' || this.identity.crew === '') {
        return { ok: false, reason: `当前身份「${this.identity.label}」不是注浆作业班组，跨工种提交一律拦下` }
      }
      if (crewName && crewName !== this.identity.crew) {
        return {
          ok: false,
          reason: `记录属于「${crewName}」，当前身份属于「${this.identity.crew}」，跨班组提交一律拦下`,
        }
      }
      return { ok: true, reason: '' }
    },
  },
})

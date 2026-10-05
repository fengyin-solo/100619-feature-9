import { defineStore } from 'pinia'

export const GROUTING_IDENTITIES = [
  { crewName: '注浆一班', leader: '王大山', label: '注浆一班 · 负责人 王大山' },
  { crewName: '注浆二班', leader: '李长河', label: '注浆二班 · 负责人 李长河' },
  { crewName: '注浆一班', leader: '张学徒', label: '注浆一班 · 班员 张学徒（无改配比权限）' },
  { crewName: '盾构一班', leader: '赵掘进', label: '盾构一班 · 赵掘进（跨班组，应被拦下）' },
] as const

export type GroutingIdentity = (typeof GROUTING_IDENTITIES)[number]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 当前注浆操作身份：登记、补浆、改配比都要按「班组 + 负责人」校验
    groutingCrew: '注浆一班' as string,
    groutingLeader: '王大山' as string,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    groutingIdentity: (state) => `${state.groutingCrew} · ${state.groutingLeader}`,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setGroutingIdentity(identity: GroutingIdentity) {
      this.groutingCrew = identity.crewName
      this.groutingLeader = identity.leader
    },
  },
})

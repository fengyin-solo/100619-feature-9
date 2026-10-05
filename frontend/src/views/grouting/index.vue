<template>
  <section class="page" data-module="grouting">
    <header class="page-head">
      <div>
        <h2>同步注浆管理</h2>
        <p class="page-desc">登记量按配比设计用量区间硬卡上限；注浆压力持续超限直接转待补浆并注明区间；补浆流水挂回原注浆编号。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = !showCreate">登记注浆记录</button>
        <button class="btn" type="button" @click="showThreshold = !showThreshold">判定阈值配置</button>
        <button class="btn" type="button" @click="exportRows">导出同步注浆清单</button>
      </div>
    </header>

    <div class="identity-bar">
      <span>当前注浆身份：</span>
      <select :value="identityKey" @change="changeIdentity(($event.target as HTMLSelectElement).value)">
        <option v-for="item in identities" :key="item.label" :value="item.label">{{ item.label }}</option>
      </select>
      <span class="history-note">只有本注浆班组负责人能登记、补浆、改配比；跨班组与非负责人提交一律拦下。</span>
    </div>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form v-if="showThreshold" class="threshold-pane" @submit.prevent="applyThreshold">
      <h3>判定阈值配置（版本化，改完全量重算，历史按锁定版本留档）</h3>
      <p class="history-note">
        当前生效版本：{{ threshold.version }}（{{ threshold.effectiveDate }}）。保存后另起自定义版本，
        已登记记录的历史派单不翻案，只更新「现行复核」列。
      </p>
      <div class="form-grid" style="margin-top:10px">
        <label>
          <span>压力正常上限 MPa</span>
          <input v-model.number="draftPressure.normalUpper" type="number" step="0.01" />
        </label>
        <label>
          <span>持续超限最短秒数</span>
          <input v-model.number="draftPressure.minDurationSeconds" type="number" min="0" />
        </label>
        <label>
          <span>批次方量对账上限倍数</span>
          <input v-model.number="draftBatchRatio" type="number" step="0.1" min="0.1" />
        </label>
      </div>
      <div class="threshold-grid">
        <div v-for="rule in draftMixRules" :key="rule.mixCode" class="threshold-card">
          <h4>{{ rule.mixCode }} {{ rule.mixName }}</h4>
          <label>每环设计用量 m³<input v-model.number="rule.designVolumePerRing" type="number" step="0.1" /></label>
          <label>下限倍数<input v-model.number="rule.lowerRatio" type="number" step="0.05" /></label>
          <label>上限倍数（超了不允许保存）<input v-model.number="rule.upperRatio" type="number" step="0.05" /></label>
          <label>补浆下限倍数<input v-model.number="rule.refillLowerRatio" type="number" step="0.05" /></label>
          <label>补浆上限倍数<input v-model.number="rule.refillUpperRatio" type="number" step="0.05" /></label>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="submit">保存并按新阈值重算存量</button>
        <button class="btn ghost" type="button" @click="resetDraft">放弃修改</button>
      </div>
      <p v-if="thresholdMessage" class="history-note" style="margin-top:8px">{{ thresholdMessage }}</p>
    </form>

    <form v-if="showCreate" class="form-panel" @submit.prevent="submitCreate">
      <h3>登记注浆记录（超配比上限、批次对不上、跨班组提交都不允许保存）</h3>
      <div class="form-grid">
        <label>
          <span>对应环号</span>
          <input v-model="form.ringNo" placeholder="如 R-108" required />
        </label>
        <label>
          <span>拌制批次编号</span>
          <select v-model="form.batchNo" required>
            <option value="" disabled>选择检验合格批次</option>
            <option v-for="batch in qualifiedBatches" :key="String(batch['批次编号'])" :value="String(batch['批次编号'])">
              {{ batch['批次编号'] }} · {{ batch['配比编码'] }} · 方量{{ batch['拌制方量'] }}m³
            </option>
          </select>
        </label>
        <label>
          <span>浆液配比（以批次为准）</span>
          <select v-model="form.mixCode" required>
            <option value="" disabled>选择配比</option>
            <option v-for="rule in threshold.mixRules" :key="rule.mixCode" :value="rule.mixCode">
              {{ rule.mixCode }} {{ rule.mixName }}
            </option>
          </select>
        </label>
        <label>
          <span>注浆量 m³</span>
          <input v-model.number="form.volume" type="number" step="0.01" min="0" required />
        </label>
        <label>
          <span>注浆压力 MPa</span>
          <input v-model.number="form.pressure" type="number" step="0.01" min="0" required />
        </label>
        <label>
          <span>超压持续秒数</span>
          <input v-model.number="form.pressureDuration" type="number" min="0" required />
        </label>
        <label>
          <span>初凝时间</span>
          <input v-model="form.setTime" placeholder="如 2026-10-05 10:00" required />
        </label>
      </div>
      <p class="judge-hint">{{ liveHint }}</p>
      <div class="form-actions">
        <button class="btn primary" type="submit" :disabled="submitting">提交登记</button>
        <span class="history-note">提交人：{{ store.groutingIdentity }}</span>
      </div>
    </form>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>对应环号</span>
        <input v-model="filters.ring" placeholder="按环号检索" />
      </label>
      <label class="filter-item">
        <span>注浆班组</span>
        <input v-model="filters.crew" placeholder="按班组检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <RefillBatchTable :groups="refillGroups" show-action @refill="openRefill" />

    <table class="data-table">
      <thead>
        <tr>
          <th>注浆编号</th>
          <th>对应环号</th>
          <th>拌制批次</th>
          <th>配比</th>
          <th>注浆量(m³)</th>
          <th>设计区间(m³)</th>
          <th>压力(MPa)</th>
          <th>所处区间</th>
          <th>注浆班组/负责人</th>
          <th>判定留档</th>
          <th>现行复核</th>
          <th>补浆流水</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['注浆编号'] }}</td>
          <td>{{ row['对应环号'] }}</td>
          <td>{{ row['批次编号'] }}</td>
          <td>
            {{ row.locked.effectiveMix }}
            <div v-if="row.locked.conflict" class="conflict-line">{{ row.locked.conflict }}</div>
          </td>
          <td :class="{ 'conflict-line': row.locked.overInjected }">{{ row.locked.volume }}</td>
          <td>{{ row.locked.lowerVolume.toFixed(2) }}～{{ row.locked.upperVolume.toFixed(2) }}<div class="cell-sub">{{ row.locked.ratio.toFixed(2) }} 倍设计</div></td>
          <td>{{ row.locked.pressure }}<div v-if="row.locked.pressureDuration" class="cell-sub">持续{{ row.locked.pressureDuration }}秒</div></td>
          <td>
            <span :class="['badge', row.locked.pressure > row.locked.pressureNormalUpper ? 'bad' : 'ok']">
              {{ row.locked.pressureBand }}
            </span>
          </td>
          <td>{{ row['注浆班组'] }}<div class="cell-sub">{{ row['班组负责人'] }}</div></td>
          <td>
            <span class="badge ok">{{ row['判定版本'] }}</span>
            <div class="reason-cell">
              <span v-for="(reason, i) in row.locked.reasons" :key="i" class="reason-line">{{ reason }}</span>
              <span v-if="!row.locked.reasons.length" class="cell-sub">合格</span>
            </div>
          </td>
          <td>
            <span class="badge" :class="currentBadge(row)">{{ row['现行复核版本'] }}</span>
            <div class="reason-cell">
              <span v-for="(reason, i) in currentWarnings(row)" :key="i" class="reason-line">{{ reason }}</span>
              <span v-if="!currentWarnings(row).length" class="cell-sub">与历史一致</span>
            </div>
          </td>
          <td>
            <ul v-if="row.refills.length" class="refill-list">
              <li v-for="item in row.refills" :key="item.seq">
                第{{ item.seq }}次 {{ item.volume }}m³ · {{ item.batchNo }} · {{ item.time }}
              </li>
            </ul>
            <span v-else class="cell-sub">—</span>
          </td>
          <td><span :class="['badge', statusBadge(row.status)]">{{ row.status }}</span></td>
          <td class="row-actions">
            <button v-if="row.pendingRefill" class="link" type="button" @click="openRefillById(Number(row.id))">完成补浆</button>
            <button class="link" type="button" @click="openMix(row)">改配比</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="14" class="empty-state">暂无同步注浆记录</td>
        </tr>
      </tbody>
    </table>

    <form v-if="refillTarget" class="form-panel" @submit.prevent="submitRefill">
      <h3>补浆登记 · 挂回原注浆编号 {{ refillTarget.groutingNo }}</h3>
      <div class="form-grid">
        <label>
          <span>拌制批次编号</span>
          <select v-model="refillForm.batchNo" required>
            <option v-for="batch in qualifiedBatches" :key="String(batch['批次编号'])" :value="String(batch['批次编号'])">
              {{ batch['批次编号'] }} · {{ batch['配比编码'] }} · 方量{{ batch['拌制方量'] }}m³
            </option>
          </select>
        </label>
        <label>
          <span>本次补浆量 m³</span>
          <input v-model.number="refillForm.volume" type="number" step="0.01" min="0" required />
        </label>
        <label>
          <span>补浆压力 MPa</span>
          <input v-model.number="refillForm.pressure" type="number" step="0.01" min="0" required />
        </label>
      </div>
      <p class="judge-hint">
        应补剩余 {{ refillTarget.remainingRefill }}m³，统一按锁定版 {{ refillTarget.lockedVersion }} 算法校验，
        超出允许区间不许提交；重复连点只记头一回。
      </p>
      <div class="form-actions">
        <button class="btn primary" type="submit" :disabled="submitting">提交补浆（挂回 {{ refillTarget.groutingNo }}）</button>
        <button class="btn ghost" type="button" @click="refillTarget = null">取消</button>
      </div>
    </form>

    <form v-if="mixTarget" class="form-panel" @submit.prevent="submitMix">
      <h3>修改浆液配比 · {{ mixTarget.groutingNo }}（仅限本班组负责人）</h3>
      <div class="form-grid">
        <label>
          <span>配比编码</span>
          <select v-model="mixForm.mixCode" required>
            <option v-for="rule in threshold.mixRules" :key="rule.mixCode" :value="rule.mixCode">
              {{ rule.mixCode }} {{ rule.mixName }}
            </option>
          </select>
        </label>
      </div>
      <p class="judge-hint">配比以检验合格拌制批次携带的编码为准；改后已登记注浆量按新配比重验，超上限不让保存。</p>
      <div class="form-actions">
        <button class="btn primary" type="submit">确认改配比</button>
        <button class="btn ghost" type="button" @click="mixTarget = null">取消</button>
      </div>
    </form>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条注浆记录 · 统计与待补浆批次均取自注浆工作区同一份数据</span>
      <span v-if="noticeMessage" class="badge ok">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import RefillBatchTable from '@/components/RefillBatchTable.vue'
import { loadCurrentThreshold, saveThreshold } from '@/data/grouting-config'
import {
  changeMix,
  getGrouting,
  groutingStats,
  listGrouting,
  pendingRefillBatches,
  recomputeWithCurrentThreshold,
  registerGrouting,
  submitRefill as submitRefillService,
} from '@/data/grouting-domain'
import type { EntryRow } from '@/data/types'
import type { GroutingRowView } from '@/data/grouting-domain'
import type { GroutingThreshold, MixDesignRule } from '@/data/grouting-config'
import { GROUTING_IDENTITIES, useSessionStore } from '@/stores/session'

const meta = moduleMeta('grouting')
const store = useSessionStore()
const identities = GROUTING_IDENTITIES
const identityKey = computed(() => identities.find((item) => item.crewName === store.groutingCrew && item.leader === store.groutingLeader)?.label ?? identities[0].label)

function changeIdentity(label: string) {
  const target = identities.find((item) => item.label === label)
  if (target) {
    store.$patch({ groutingCrew: target.crewName, groutingLeader: target.leader })
  }
}

const rows = ref<GroutingRowView[]>([])
const refillGroups = ref(pendingRefillBatches())
const errorMessage = ref('')
const noticeMessage = ref('')
const submitting = ref(false)
const showCreate = ref(false)
const showThreshold = ref(false)
const thresholdMessage = ref('')
const filters = reactive({ ring: '', crew: '' })

const stats = ref(groutingStats())
const statCards = computed(() => [
  { label: '注浆总量(m³)', value: stats.value.totalVolume },
  { label: '待补浆记录', value: stats.value.pendingCount },
  { label: '平均注浆压力(MPa)', value: stats.value.avgPressure },
  { label: '异常/冲突', value: stats.value.abnormalCount },
])

const statuses = ['已完成', '待补浆', '已补浆']
const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length })),
)

const threshold = ref<GroutingThreshold>(loadCurrentThreshold())
const qualifiedBatches = computed<EntryRow[]>(() =>
  listEntries('mortar').items.filter((row) => String(row.status) === '检验合格'),
)

const form = reactive({
  ringNo: '',
  batchNo: '',
  mixCode: '',
  volume: 8,
  pressure: 0.2,
  pressureDuration: 0,
  setTime: '',
})

const emptyForm = () => {
  form.ringNo = ''
  form.batchNo = ''
  form.mixCode = ''
  form.volume = 8
  form.pressure = 0.2
  form.pressureDuration = 0
  form.setTime = new Date().toISOString().slice(0, 16).replace('T', ' ')
}
emptyForm()

const liveHint = computed(() => {
  const rule = threshold.value.mixRules.find((item) => item.mixCode === form.mixCode)
  if (!rule || !(form.volume > 0)) {
    return '选择配比并填写注浆量后，这里实时对照设计区间。'
  }
  const lower = rule.designVolumePerRing * rule.lowerRatio
  const upper = rule.designVolumePerRing * rule.upperRatio
  if (form.volume > upper) {
    return `超上限：${form.volume}m³ > ${upper.toFixed(2)}m³，此单提交会被拦截。压力上限${threshold.value.pressure.normalUpper}MPa、持续${threshold.value.pressure.minDurationSeconds}秒以上转待补浆。`
  }
  if (form.volume < lower) {
    return `低于下限：${form.volume}m³ < ${lower.toFixed(2)}m³，登记后直接转待补浆。`
  }
  return `区间 ${lower.toFixed(2)}～${upper.toFixed(2)}m³ 内，可登记；若压力持续超 ${threshold.value.pressure.normalUpper}MPa 达 ${threshold.value.pressure.minDurationSeconds} 秒仍会转待补浆。`
})

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

let registerKey = ''
function submitCreate() {
  if (submitting.value) {
    return
  }
  errorMessage.value = ''
  submitting.value = true
  registerKey = idemKey('reg')
  const result = registerGrouting({
    ringNo: form.ringNo,
    batchNo: form.batchNo,
    mixCode: form.mixCode,
    volume: Number(form.volume),
    pressure: Number(form.pressure),
    pressureDuration: Number(form.pressureDuration),
    crewName: store.groutingCrew,
    leader: store.groutingLeader,
    setTime: form.setTime,
    operator: store.groutingLeader,
    idemKey: registerKey,
  })
  submitting.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  emptyForm()
  showCreate.value = false
  reload()
  noticeMessage.value = result.message
}

type RefillTarget = { id: number; groutingNo: string; remainingRefill: number; lockedVersion: string }
const refillTarget = ref<RefillTarget | null>(null)
const refillForm = reactive({ batchNo: '', volume: 0, pressure: 0.2 })
let refillKey = ''

function openRefill(payload: { groutingNo: string; batchNo: string; remaining: number }) {
  const row = rows.value.find((item) => String(item['注浆编号']) === payload.groutingNo)
  if (!row) {
    return
  }
  openRefillById(Number(row.id))
  refillForm.batchNo = payload.batchNo
  refillForm.volume = Number(payload.remaining.toFixed(2))
}

function openRefillById(id: number) {
  const view = getGrouting(id)
  if (!view) {
    return
  }
  refillTarget.value = {
    id,
    groutingNo: String(view['注浆编号']),
    remainingRefill: view.remainingRefill,
    lockedVersion: view.locked.version,
  }
  refillForm.batchNo = String(view['批次编号'])
  refillForm.volume = Number(view.remainingRefill.toFixed(2))
  refillForm.pressure = 0.2
  noticeMessage.value = ''
}

function submitRefill() {
  if (!refillTarget.value || submitting.value) {
    return
  }
  errorMessage.value = ''
  submitting.value = true
  refillKey = idemKey('refill')
  const result = submitRefillService({
    id: refillTarget.value.id,
    batchNo: refillForm.batchNo,
    volume: Number(refillForm.volume),
    pressure: Number(refillForm.pressure),
    leader: store.groutingLeader,
    operator: store.groutingLeader,
    idemKey: refillKey,
  })
  submitting.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  refillTarget.value = null
  reload()
  noticeMessage.value = result.message
}

type MixTarget = { id: number; groutingNo: string }
const mixTarget = ref<MixTarget | null>(null)
const mixForm = reactive({ mixCode: '' })

function openMix(row: GroutingRowView) {
  mixTarget.value = { id: Number(row.id), groutingNo: String(row['注浆编号']) }
  mixForm.mixCode = row.locked.effectiveMix
  errorMessage.value = ''
}

function submitMix() {
  if (!mixTarget.value) {
    return
  }
  const result = changeMix({ id: mixTarget.value.id, mixCode: mixForm.mixCode, leader: store.groutingLeader })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  mixTarget.value = null
  reload()
  noticeMessage.value = result.message
}

const draftPressure = reactive({ ...loadCurrentThreshold().pressure })
const draftBatchRatio = ref(loadCurrentThreshold().batchVolumeRatio)
const draftMixRules = ref<MixDesignRule[]>([])

function resetDraft() {
  const current = loadCurrentThreshold()
  Object.assign(draftPressure, current.pressure)
  draftBatchRatio.value = current.batchVolumeRatio
  draftMixRules.value = current.mixRules.map((rule) => ({ ...rule }))
  thresholdMessage.value = ''
}
resetDraft()

function applyThreshold() {
  errorMessage.value = ''
  if (draftMixRules.value.some((rule) => !(rule.lowerRatio > 0) || rule.upperRatio < rule.lowerRatio)) {
    thresholdMessage.value = '上限倍数必须大于下限倍数，且都要大于 0'
    return
  }
  if (!(draftPressure.normalUpper > 0) || draftPressure.minDurationSeconds < 0) {
    thresholdMessage.value = '压力上限要大于 0，持续秒数不能为负'
    return
  }
  try {
    const saved = saveThreshold({
      mixRules: draftMixRules.value.map((rule) => ({ ...rule })),
      pressure: { ...draftPressure },
      batchVolumeRatio: draftBatchRatio.value,
    })
    const report = recomputeWithCurrentThreshold()
    threshold.value = saved
    resetDraft()
    thresholdMessage.value = `已生效 ${report.version}，存量 ${report.total} 条全部重算，其中 ${report.changed} 条更新了现行复核；历史派单仍按各自锁定版本留档。`
    reload()
  } catch (error) {
    thresholdMessage.value = error instanceof Error ? error.message : '阈值保存失败，已撤销'
  }
}

function currentBadge(row: GroutingRowView): string {
  return row.current.needRefill || row.current.overInjected || row.current.conflict ? 'warn' : 'ok'
}

function currentWarnings(row: GroutingRowView): string[] {
  if (row.current.version === row.locked.version) {
    return []
  }
  return row.current.reasons.filter((reason) => {
    if (reason.startsWith('注浆压力') && row.current.pressureSpikeOnly) {
      return true
    }
    return row.current.underInjected || row.current.overInjected || row.current.batchOverflow || row.current.conflict.length > 0
  })
}

function statusBadge(status: string | number | boolean): string {
  if (status === '待补浆') {
    return 'bad'
  }
  if (status === '已补浆' || status === '已完成') {
    return 'ok'
  }
  return 'warn'
}

function exportRows() {
  downloadEntries(meta.key)
}

function resetFilters() {
  filters.ring = ''
  filters.crew = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const viewFilters: Record<string, string> = {}
    if (filters.ring.trim()) {
      viewFilters['对应环号'] = filters.ring.trim()
    }
    if (filters.crew.trim()) {
      viewFilters['注浆班组'] = filters.crew.trim()
    }
    rows.value = listGrouting(viewFilters)
    refillGroups.value = pendingRefillBatches()
    stats.value = groutingStats()
    threshold.value = loadCurrentThreshold()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '同步注浆列表读取失败'
  }
}

onMounted(reload)
</script>

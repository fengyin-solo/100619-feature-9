<template>
  <section class="page" data-module="grouting">
    <header class="page-head">
      <div>
        <h2>同步注浆管理</h2>
        <p class="page-desc">
          登记注浆量对照配比设计用量判定：高于上限不允许保存；注浆压力持续超限直接转待补浆并注明区间。
          补浆记录挂回原注浆编号。当前阈值
          <strong>v{{ activeConfig.version }}</strong>（{{ activeConfig.publishedAt }} 发布）。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记注浆记录</button>
        <button class="btn" type="button" @click="configOpen = true">判定阈值配置</button>
        <button class="btn" type="button" @click="exportRows">导出同步注浆清单</button>
      </div>
    </header>

    <p class="identity-banner" :class="{ muted: !store.isGroutingCrew }">
      当前身份：{{ store.identity.label }}（{{ store.identity.detail }}）
    </p>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table grouting-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr :class="{ 'makeup-row': isMakeup(row) }">
            <td v-for="column in columns" :key="column" :class="verdictCellClass(row, column)">
              <template v-if="column === '注浆编号'">
                <button v-if="archives(row).length" class="link archive-toggle" type="button" @click="toggleArchive(row)">
                  {{ expanded[row.id] ? '▾' : '▸' }}
                </button>
                <span v-else class="archive-dot">·</span>
                <span :class="{ 'makeup-code': isMakeup(row) }">{{ row[column] }}</span>
              </template>
              <template v-else-if="column === '注浆量'">
                {{ row[column] === null || row[column] === '' ? '—' : `${row[column]} m³` }}
              </template>
              <template v-else-if="column === '注浆压力'">
                {{ row[column] === null || row[column] === '' ? '—' : `${row[column]} MPa` }}
              </template>
              <template v-else-if="column === '建议补浆量'">
                {{ Number(row[column] ?? 0) > 0 ? `${row[column]} m³` : '—' }}
              </template>
              <template v-else>{{ row[column] ?? '—' }}</template>
            </td>
            <td>
              <span :class="statusClass(row)">{{ row.status }}</span>
            </td>
            <td class="row-actions">
              <button
                v-if="row.status === '待补浆' && !isMakeup(row)"
                class="link"
                type="button"
                @click="openMakeup(row)"
              >
                完成补浆
              </button>
              <button
                v-if="!isMakeup(row) && canChangeMix(row)"
                class="link"
                type="button"
                @click="openMix(row)"
              >
                改浆液配比
              </button>
              <span v-if="row.status === '待补浆' && !isMakeup(row)" class="action-hint">欠量/超限需补</span>
            </td>
          </tr>
          <tr v-if="expanded[row.id]" class="archive-row">
            <td :colspan="columns.length + 2">
              <div class="archive-box">
                <strong>判定留档（按当时阈值版本归档）：</strong>
                <ul>
                  <li v-for="item in archives(row)" :key="item.版本">
                    v{{ item.版本 }} · {{ item.时间 }} · {{ item.等级 }} — {{ item.说明 }}
                  </li>
                </ul>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无同步注浆数据，可先登记注浆记录</td>
        </tr>
      </tbody>
    </table>

    <section class="cross-panel">
      <h3>待补浆清单（与「浆液拌制」页读到的是同一份）</h3>
      <table class="data-table compact">
        <thead>
          <tr><th>注浆编号</th><th>对应环号</th><th>注浆班组</th><th>配比</th><th>拌制批次</th><th>建议补浆量</th><th>判定原因</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in pendingItems" :key="item.id">
            <td>{{ item.注浆编号 }}</td>
            <td>{{ item.对应环号 }}</td>
            <td>{{ item.注浆班组 }}</td>
            <td>{{ item.浆液配比 }}</td>
            <td>{{ item.拌制批次 || '—' }}</td>
            <td>{{ item.建议补浆量 }} m³</td>
            <td class="reason-cell">{{ item.判定说明 }}</td>
          </tr>
          <tr v-if="!pendingItems.length">
            <td colspan="7" class="empty-state">当前没有待补浆记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条同步注浆记录（补浆记录缩进挂在原注浆编号下）</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记注浆记录 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>登记注浆记录</h3>
        <p class="modal-tip">
          注浆量高于该配比上限不允许保存；低于下限或压力持续超限将自动转待补浆。
          班组说法与登记的设计配比打架时，以登记的设计配比为准。
        </p>
        <div class="form-grid">
          <label class="form-item">
            <span>对应环号 *</span>
            <input v-model="createForm.对应环号" placeholder="如 20" list="ring-options" />
            <datalist id="ring-options">
              <option v-for="ring in ringOptions" :key="ring.ring" :value="ring.ring" />
            </datalist>
          </label>
          <label class="form-item">
            <span>责任注浆班组（按环次台账）</span>
            <input :value="ringOwner || '环号未在台账中'" disabled :class="{ 'cell-warn': !!createForm.对应环号 && ringOwner !== store.crew }" />
          </label>
          <label class="form-item">
            <span>当前提交身份</span>
            <input :value="store.identity.label" disabled />
          </label>
          <label class="form-item">
            <span>浆液配比 *（{{ store.isLeader ? '负责人可改' : `仅班组默认 ${defaultMix}` }}）</span>
            <select v-model="createForm.浆液配比" :disabled="!store.isLeader">
              <option v-for="mix in activeConfig.mixes" :key="mix.code" :value="mix.code">
                {{ mix.name }}
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>拌制批次（合格且配比一致）*</span>
            <select v-model="createForm.拌制批次">
              <option value="">先选配比/未注浆可留空</option>
              <option v-for="batch in usableBatches(createForm.浆液配比)" :key="String(batch.id)" :value="String(batch['批次编号'])">
                {{ batch['批次编号'] }}（剩 {{ batch['剩余方量'] }}m³）
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>注浆量 m³（留空=待注浆计划）</span>
            <input v-model.number="createForm.注浆量" type="number" step="0.01" min="0" />
          </label>
          <label class="form-item">
            <span>峰值注浆压力 MPa</span>
            <input v-model.number="createForm.注浆压力" type="number" step="0.01" min="0" />
          </label>
          <label class="form-item">
            <span>超限持续秒数</span>
            <input v-model.number="createForm.超限持续秒数" type="number" step="1" min="0" />
          </label>
          <label class="form-item">
            <span>初凝时间/日期</span>
            <input v-model="createForm.初凝时间" type="date" />
          </label>
        </div>
        <p class="range-hint">{{ rangeHint }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">保存登记</button>
        </div>
      </div>
    </div>

    <!-- 完成补浆 -->
    <div v-if="makeupTarget" class="modal-mask" @click.self="makeupTarget = null">
      <div class="modal">
        <h3>完成补浆 — {{ makeupTarget['注浆编号'] }}（环 {{ makeupTarget['对应环号'] }}）</h3>
        <p class="modal-tip">
          补浆完成后生成 {{ makeupTarget['注浆编号'] }}-B{{ makeupSeq }} 挂回原注浆编号，不另起主记录。
          原判定：{{ makeupTarget['判定说明'] }}
        </p>
        <div class="form-grid">
          <label class="form-item">
            <span>注浆班组</span>
            <input :value="makeupTarget['注浆班组']" disabled />
          </label>
          <label class="form-item">
            <span>浆液配比</span>
            <input :value="makeupTarget['浆液配比']" disabled />
          </label>
          <label class="form-item">
            <span>补浆量 m³ *</span>
            <input v-model.number="makeupForm.注浆量" type="number" step="0.01" min="0" />
          </label>
          <label class="form-item">
            <span>拌制批次 *</span>
            <select v-model="makeupForm.拌制批次">
              <option value="">请选择</option>
              <option v-for="batch in usableBatches(String(makeupTarget['浆液配比']))" :key="String(batch.id)" :value="String(batch['批次编号'])">
                {{ batch['批次编号'] }}（剩 {{ batch['剩余方量'] }}m³）
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>补浆峰值压力 MPa</span>
            <input v-model.number="makeupForm.注浆压力" type="number" step="0.01" min="0" />
          </label>
          <label class="form-item">
            <span>超限持续秒数</span>
            <input v-model.number="makeupForm.超限持续秒数" type="number" step="1" min="0" />
          </label>
          <label class="form-item">
            <span>补浆日期</span>
            <input v-model="makeupForm.初凝时间" type="date" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="makeupTarget = null">取消</button>
          <button class="btn primary" type="button" @click="submitMakeup">确认补浆并挂回原编号</button>
        </div>
      </div>
    </div>

    <!-- 改浆液配比（仅本班组负责人） -->
    <div v-if="mixTarget" class="modal-mask" @click.self="mixTarget = null">
      <div class="modal">
        <h3>修改浆液配比 — {{ mixTarget['注浆编号'] }}</h3>
        <p class="modal-tip">只有本注浆班组负责人能改；改完按当前阈值 v{{ activeConfig.version }} 重判，越上限同样拒绝。</p>
        <div class="form-grid">
          <label class="form-item">
            <span>当前配比</span>
            <input :value="mixTarget['浆液配比']" disabled />
          </label>
          <label class="form-item">
            <span>改挂配比 *</span>
            <select v-model="mixNext">
              <option v-for="mix in activeConfig.mixes" :key="mix.code" :value="mix.code">{{ mix.name }}</option>
            </select>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="mixTarget = null">取消</button>
          <button class="btn primary" type="button" @click="submitMix">保存并重判</button>
        </div>
      </div>
    </div>

    <!-- 阈值配置（管理员发布新版本） -->
    <div v-if="configOpen" class="modal-mask modal-wide" @click.self="configOpen = false">
      <div class="modal">
        <h3>判定阈值配置</h3>
        <p class="modal-tip">
          调整后发布为新版本，已登记注浆记录照新阈值重算一遍；每次判定按当时版本留档，不改历史。
          连着点两回发布仍按头一回。
        </p>

        <table class="data-table compact">
          <thead>
            <tr><th>版本</th><th>发布日期</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in configs" :key="item.version" :class="{ 'version-active': item.version === activeConfig.version }">
              <td>v{{ item.version }}{{ item.version === activeConfig.version ? '（在用）' : '' }}</td>
              <td>{{ item.publishedAt }}</td>
              <td>{{ item.note }}</td>
            </tr>
          </tbody>
        </table>

        <template v-if="store.isAdmin">
          <h4 class="form-section">新版本草稿（基于 v{{ activeConfig.version }}）</h4>
          <label class="form-item full">
            <span>版本说明</span>
            <input v-model="configDraft.note" />
          </label>
          <table class="data-table compact">
            <thead>
              <tr><th>配比代码</th><th>配比名称</th><th>设计用量 m³</th><th>下限 m³</th><th>上限 m³</th></tr>
            </thead>
            <tbody>
              <tr v-for="(mix, index) in configDraft.mixes" :key="mix.code">
                <td><input v-model="mix.code" class="cell-input" /></td>
                <td><input v-model="mix.name" class="cell-input wide" /></td>
                <td><input v-model.number="mix.designVolume" type="number" step="0.01" class="cell-input" /></td>
                <td><input v-model.number="mix.minVolume" type="number" step="0.01" class="cell-input" /></td>
                <td><input v-model.number="mix.maxVolume" type="number" step="0.01" class="cell-input" /></td>
              </tr>
            </tbody>
          </table>
          <div class="form-grid">
            <label class="form-item">
              <span>预警下限 MPa</span>
              <input v-model.number="configDraft.warnPressure.min" type="number" step="0.01" />
            </label>
            <label class="form-item">
              <span>超限下限 MPa</span>
              <input v-model.number="configDraft.overPressure.min" type="number" step="0.01" />
            </label>
            <label class="form-item">
              <span>超限持续秒数</span>
              <input v-model.number="configDraft.overHoldSeconds" type="number" step="1" />
            </label>
            <label class="form-item">
              <span>预警持续秒数</span>
              <input v-model.number="configDraft.warnHoldSeconds" type="number" step="1" />
            </label>
            <label class="form-item">
              <span>压力超限补浆量 m³</span>
              <input v-model.number="configDraft.pressureFixVolume" type="number" step="0.05" />
            </label>
          </div>
        </template>
        <p v-else class="modal-tip">当前身份不是值班管理员，只能查看阈值，不能发布新版本。</p>

        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="configOpen = false">关闭</button>
          <button v-if="store.isAdmin" class="btn" type="button" @click="runRecompute">按当前版本重算</button>
          <button v-if="store.isAdmin" class="btn primary" type="button" @click="publishConfig">发布新版本并重算</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  activeGroutingConfig,
  changeGroutingMix,
  draftFromActive,
  downloadEntries,
  groutingStats,
  listGroutingConfigs,
  listGroutingCrews,
  listGroutingLedger,
  listPendingMakeups,
  listUsableMortarBatches,
  moduleMeta,
  publishGroutingConfig,
  recomputeWithActive,
  registerGrouting,
  submitMakeup as submitMakeupApi,
} from '@/api/local-service'
import type { ConfigDraft, GroutingFormInput, MakeupFormInput, PendingMakeupItem } from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'
import type { GroutingConfig, MixDesign } from '@/data/grouting-config'
import { mixOf } from '@/data/grouting-config'
import { useSessionStore } from '@/stores/session'
import { listRows } from '@/data/local-store'

const meta = moduleMeta('grouting')
const store = useSessionStore()

const columns = ["注浆编号", "对应环号", "浆液配比", "注浆量", "注浆压力", "超限持续秒数", "初凝时间", "注浆班组", "拌制批次", "判定等级", "判定说明", "建议补浆量", "判定配置版本"]
const statuses = ["待注浆", "注浆中", "已完成", "待补浆", "已补浆"]
const filterFields = ["注浆编号", "对应环号", "注浆班组"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const expanded = reactive<Record<number, boolean>>({})

const activeConfig = ref<GroutingConfig>(activeGroutingConfig())
const configs = ref<GroutingConfig[]>(listGroutingConfigs())
const pendingItems = ref<PendingMakeupItem[]>([])

const statCards = computed(() => {
  const stats = groutingStats()
  return [
    { label: '注浆总量（含补浆 m³）', value: stats.totalVolume },
    { label: '待补浆记录', value: stats.pendingMakeupCount },
    { label: '平均注浆压力 MPa', value: stats.avgPressure },
    { label: '待补浆涉及拌制批次', value: stats.pendingBatchCount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const ringOptions = computed(() =>
  listRows('ring').map((row) => ({ ring: String(row['环号']), crew: String(row['掘进班组'] ?? '') })).filter((item) => item.ring),
)
const ringOwner = computed(() => {
  const hit = ringOptions.value.find((item) => item.ring === String(createForm.对应环号).trim())
  return hit?.crew ?? ''
})
const groutingCrews = computed(() => listGroutingCrews())
const defaultMix = computed(() => {
  const crew = groutingCrews.value.find((row) => String(row['班组名称']) === store.crew)
  return String(crew?.['默认配比'] ?? 'A')
})

function isMakeup(row: EntryRow): boolean {
  return String(row['原注浆编号'] ?? '') !== ''
}

function archives(row: EntryRow) {
  const value = row['判定留档']
  return Array.isArray(value) ? value as { 等级: string; 说明: string; 版本: number; 建议补浆量: number; 时间: string }[] : []
}

function toggleArchive(row: EntryRow) {
  expanded[row.id] = !expanded[row.id]
}

function usableBatches(mixCode: string): EntryRow[] {
  return listUsableMortarBatches(mixCode)
}

function canChangeMix(row: EntryRow): boolean {
  return store.isLeader && store.crew === String(row['注浆班组'])
}

function statusClass(row: EntryRow): Record<string, boolean> {
  return {
    'status-badge': true,
    'status-pending': row.status === '待补浆',
    'status-done': row.status === '已完成' || row.status === '已补浆',
  }
}

function verdictCellClass(row: EntryRow, column: string): Record<string, boolean> {
  if (column === '判定等级') {
    return {
      'verdict-cell': true,
      'verdict-bad': ['欠量待补浆', '压力待补浆', '超量拒绝'].includes(String(row[column])),
      'verdict-ok': ['合格', '补浆闭环', '补浆记录'].includes(String(row[column])),
    }
  }
  if (column === '判定说明' && row.status === '待补浆') return { 'reason-cell': true }
  return {}
}

function notify(result: ActionResult): boolean {
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) reload()
  return result.ok
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  message.value = ''
  try {
    const payload = listGroutingLedger(filters.value)
    rows.value = payload.items
    total.value = payload.total
    pendingItems.value = listPendingMakeups()
    activeConfig.value = activeGroutingConfig()
    configs.value = listGroutingConfigs()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '同步注浆列表读取失败'
    messageOk.value = false
  }
}

// ── 登记 ──
const createOpen = ref(false)
const createForm = reactive<GroutingFormInput>({
  对应环号: '',
  浆液配比: 'A',
  注浆量: null,
  注浆压力: null,
  超限持续秒数: null,
  初凝时间: new Date().toISOString().slice(0, 10),
  拌制批次: '',
})

const rangeHint = computed(() => {
  const mix: MixDesign | undefined = mixOf(activeConfig.value, createForm.浆液配比)
  if (!mix) return '配比不在当前配置中'
  const range = `${mix.name}：允许注浆量区间 ${mix.minVolume} ~ ${mix.maxVolume}m³（设计 ${mix.designVolume}m³；高过 ${mix.maxVolume} 不允许保存，低于 ${mix.minVolume} 转待补浆）`
  const pressure = `压力预警 [${activeConfig.value.warnPressure.min}, ${activeConfig.value.overPressure.min})，超限 ≥${activeConfig.value.overPressure.min} 持续 ${activeConfig.value.overHoldSeconds}s 转待补浆`
  return `${range}；${pressure}`
})

function openCreate() {
  if (!store.isGroutingCrew) {
    message.value = `当前身份「${store.identity.label}」不能登记注浆，请切换到注浆班组负责人或注浆手`
    messageOk.value = false
    return
  }
  createForm.对应环号 = ''
  createForm.浆液配比 = defaultMix.value
  createForm.注浆量 = null
  createForm.注浆压力 = null
  createForm.超限持续秒数 = null
  createForm.初凝时间 = new Date().toISOString().slice(0, 10)
  createForm.拌制批次 = ''
  createOpen.value = true
}

function submitCreate() {
  if (ringOwner.value && ringOwner.value !== store.crew) {
    message.value = `环 ${createForm.对应环号} 的责任班组是「${ringOwner.value}」，当前身份属于「${store.crew}」，跨班组提交一律拦下`
    messageOk.value = false
    return
  }
  const result = registerGrouting({ ...createForm }, {
    role: store.role,
    crew: store.crew,
    label: store.identity.label,
  })
  if (notify(result)) createOpen.value = false
}

// ── 补浆 ──
const makeupTarget = ref<EntryRow | null>(null)
const makeupForm = reactive<MakeupFormInput>({ 注浆量: 0, 注浆压力: null, 超限持续秒数: null, 初凝时间: '', 拌制批次: '' })
const makeupSeq = computed(() => {
  if (!makeupTarget.value) return 1
  const parent = String(makeupTarget.value['注浆编号'])
  return listRows('grouting').filter((row) => String(row['原注浆编号'] ?? '') === parent).length + 1
})

function openMakeup(row: EntryRow) {
  const permit = store.canSubmitFor(String(row['注浆班组']))
  if (!permit.ok) {
    message.value = permit.reason
    messageOk.value = false
    return
  }
  makeupTarget.value = row
  makeupForm.注浆量 = Number(row['建议补浆量'] ?? 0)
  makeupForm.注浆压力 = null
  makeupForm.超限持续秒数 = 0
  makeupForm.初凝时间 = new Date().toISOString().slice(0, 10)
  makeupForm.拌制批次 = ''
}

function submitMakeup() {
  if (!makeupTarget.value) return
  const result = submitMakeupApi(Number(makeupTarget.value.id), { ...makeupForm }, {
    role: store.role,
    crew: store.crew,
    label: store.identity.label,
  })
  if (notify(result)) makeupTarget.value = null
}

// ── 改配比 ──
const mixTarget = ref<EntryRow | null>(null)
const mixNext = ref('A')

function openMix(row: EntryRow) {
  mixTarget.value = row
  mixNext.value = String(row['浆液配比'])
}

function submitMix() {
  if (!mixTarget.value) return
  const result = changeGroutingMix(Number(mixTarget.value.id), mixNext.value, {
    role: store.role,
    crew: store.crew,
    label: store.identity.label,
  })
  if (notify(result)) mixTarget.value = null
}

// ── 阈值配置 ──
const configOpen = ref(false)
const configDraft = reactive<ConfigDraft>(draftFromActive())

function refreshDraft() {
  const fresh = draftFromActive()
  Object.assign(configDraft, fresh)
}

function publishConfig() {
  const result = publishGroutingConfig(JSON.parse(JSON.stringify(configDraft)) as ConfigDraft, {
    role: store.role,
    crew: store.crew,
    label: store.identity.label,
  })
  notify(result)
  refreshDraft()
  configOpen.value = false
}

function runRecompute() {
  const result = recomputeWithActive({ role: store.role, crew: store.crew, label: store.identity.label })
  notify(result)
}

onMounted(() => {
  refreshDraft()
  reload()
})
</script>

<template>
  <section class="page" data-module="mortar">
    <header class="page-head">
      <div>
        <h2>浆液拌制管理</h2>
        <p class="page-desc">检验合格批次携带配比编码与拌制方量；注浆结论回写进待用清单，待补浆批次与同步注浆页同一份。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记浆液批次</button>
        <button class="btn" type="button" @click="exportRows">导出浆液拌制清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
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
      <label class="filter-item">
        <span>批次编号</span>
        <input v-model="filters.batchNo" placeholder="按批次编号检索" />
      </label>
      <label class="filter-item">
        <span>配比编码</span>
        <input v-model="filters.mixCode" placeholder="按配比检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <RefillBatchTable :groups="refillGroups" />

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>对账占用(m³)</th>
          <th>注浆结论（回写）</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ conclusionOf(String(row['批次编号'])).totalInjected }}</td>
          <td>
            <span :class="['badge', conclusionOf(String(row['批次编号'])).pendingRefill ? 'bad' : 'ok']">
              {{ conclusionOf(String(row['批次编号'])).text }}
            </span>
            <div v-if="conclusionOf(String(row['批次编号'])).linked" class="cell-sub">
              关联注浆 {{ conclusionOf(String(row['批次编号'])).linked }} 单
            </div>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无浆液拌制数据，可先登记浆液批次</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条浆液批次 · 注浆结论与待补浆批次均读取注浆工作区，不另算一遍</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import RefillBatchTable from '@/components/RefillBatchTable.vue'
import { groutingConclusionForBatch, pendingRefillBatches } from '@/data/grouting-domain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('mortar')
const columns = ["批次编号", "浆液类型", "配比编码", "水泥用量", "膨润土用量", "水灰比", "稠度", "拌制方量", "拌制日期", "批次状态"]
const actions = ["开始拌制", "提交检验", "废弃批次"]
const statuses = ["待拌制", "拌制中", "检验合格", "已废弃"]
const stats = ref([{"label": "待拌制批次", "value": 0}, {"label": "合格批次", "value": 0}, {"label": "待补浆批次", "value": 0}])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({ batchNo: '', mixCode: '' })
const refillGroups = ref(pendingRefillBatches())
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function conclusionOf(batchNo: string) {
  return groutingConclusionForBatch(batchNo)
}

function resetFilters() {
  filters.value = { batchNo: '', mixCode: '' }
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '浆液批次登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const viewFilters: Record<string, string> = {}
    if (filters.value.batchNo.trim()) {
      viewFilters['批次编号'] = filters.value.batchNo.trim()
    }
    if (filters.value.mixCode.trim()) {
      viewFilters['配比编码'] = filters.value.mixCode.trim()
    }
    const payload = listEntries(meta.key, viewFilters)
    rows.value = payload.items
    total.value = payload.total
    refillGroups.value = pendingRefillBatches()
    stats.value = [
      { label: "待拌制批次", value: rows.value.filter((row) => String(row.status) === '待拌制').length },
      { label: "合格批次", value: rows.value.filter((row) => String(row.status) === '检验合格').length },
      { label: "待补浆批次", value: refillGroups.value.length },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '浆液拌制列表读取失败'
  }
}

onMounted(reload)
</script>

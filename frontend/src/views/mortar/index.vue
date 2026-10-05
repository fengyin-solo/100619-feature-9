<template>
  <section class="page" data-module="mortar">
    <header class="page-head">
      <div>
        <h2>浆液拌制管理</h2>
        <p class="page-desc">
          维护浆液批次与待用清单。注浆结论回写进批次的待用结论，注浆量按拌制批次对账；
          待补浆批次与「同步注浆」页读到的是同一份。
        </p>
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

    <section class="cross-panel">
      <h3>待用清单（注浆结论回写，两个入口同一份）</h3>
      <table class="data-table compact">
        <thead>
          <tr><th>批次编号</th><th>配比代码</th><th>拌制方量</th><th>已用方量</th><th>剩余方量</th><th>待用结论</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="batch in rows" :key="String(batch.id)" :class="{ 'batch-pending': batch['待补浆批次'] === true }">
            <td>{{ batch['批次编号'] }}</td>
            <td>{{ batch['配比代码'] }}</td>
            <td>{{ batch['拌制方量'] }} m³</td>
            <td>{{ batch['已用方量'] }} m³</td>
            <td>{{ batch['剩余方量'] }} m³</td>
            <td>{{ batch['待用结论'] }}</td>
            <td>{{ batch.status }}</td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="7" class="empty-state">暂无浆液拌制数据</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="cross-panel">
      <h3>待补浆批次（与同步注浆页同一份口径，共 {{ pendingBatches.length }} 个批次 / {{ pendingItems.length }} 条记录）</h3>
      <table class="data-table compact">
        <thead>
          <tr><th>拌制批次</th><th>配比代码</th><th>涉及待补浆记录</th><th>建议补浆量合计</th></tr>
        </thead>
        <tbody>
          <tr v-for="batch in pendingBatches" :key="String(batch.id)">
            <td>{{ batch['批次编号'] }}</td>
            <td>{{ batch['配比代码'] }}</td>
            <td>{{ pendingOf(batch).map((item) => item.注浆编号).join('、') }}</td>
            <td>{{ pendingSumOf(batch) }} m³</td>
          </tr>
          <tr v-if="!pendingBatches.length">
            <td colspan="4" class="empty-state">当前没有待补浆批次</td>
          </tr>
        </tbody>
      </table>
    </section>

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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无浆液拌制数据，可先登记浆液批次</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条浆液拌制记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  groutingStats,
  listEntries,
  listPendingMakeupBatches,
  listPendingMakeups,
  moduleMeta,
  mortarStats,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type { PendingMakeupItem } from '@/api/local-service'

const meta = moduleMeta('mortar')
const columns = ["批次编号", "浆液类型", "配比代码", "水泥用量", "膨润土用量", "水灰比", "稠度", "拌制方量", "拌制日期", "批次状态"]
const actions = ["开始拌制", "提交检验", "废弃批次"]
const statuses = ["待拌制", "拌制中", "检验合格", "已废弃"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["批次编号", "浆液类型", "配比代码"]
const pendingItems = ref<PendingMakeupItem[]>([])
const pendingBatches = ref<EntryRow[]>([])

const stats = computed(() => {
  const g = groutingStats()
  const m = mortarStats()
  return [
    { label: '待用合格批次', value: m.usable },
    { label: '待补浆批次（与注浆同源）', value: g.pendingBatchCount },
    { label: '待补浆记录', value: g.pendingMakeupCount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function pendingOf(batch: EntryRow): PendingMakeupItem[] {
  const code = String(batch['批次编号'])
  return pendingItems.value.filter((item) => item.拌制批次 === code)
}

function pendingSumOf(batch: EntryRow): number {
  return Math.round(pendingOf(batch).reduce((sum, item) => sum + item.建议补浆量, 0) * 100) / 100
}

function resetFilters() {
  filters.value = {}
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 两份面板都来自注浆台账的回写/派生，保证两处入口读到同一份。
    pendingItems.value = listPendingMakeups()
    pendingBatches.value = listPendingMakeupBatches()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '浆液拌制列表读取失败'
  }
}

onMounted(reload)
</script>

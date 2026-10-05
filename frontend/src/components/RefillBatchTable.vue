<template>
  <section class="refill-pane">
    <header class="refill-head">
      <h3>待补浆批次（注浆侧 / 拌制侧同一份）</h3>
      <span class="refill-tip">数据由同步注浆工作区按拌制批次聚合，两个入口读到的必然一致</span>
    </header>
    <table v-if="groups.length" class="data-table">
      <thead>
        <tr>
          <th>拌制批次</th>
          <th>配比</th>
          <th>待补注浆编号</th>
          <th>对应环号</th>
          <th>注浆班组</th>
          <th>锁定阈值</th>
          <th>超限区间 / 判定原因</th>
          <th>已补/应补剩余(m³)</th>
          <th v-if="showAction">操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="group in groups" :key="group.batchNo">
          <tr v-for="(item, index) in group.items" :key="`${group.batchNo}-${item.groutingNo}`">
            <td v-if="index === 0" :rowspan="group.items.length">
              {{ group.batchNo }}
              <div class="cell-sub">占用 {{ group.occupiedVolume }} / {{ group.mixVolume ?? '—' }} m³</div>
            </td>
            <td v-if="index === 0" :rowspan="group.items.length">{{ group.mixCode }} {{ group.mixName }}</td>
            <td>{{ item.groutingNo }}</td>
            <td>{{ item.ringNo }}</td>
            <td>{{ item.crew }}</td>
            <td>{{ item.lockedVersion }}</td>
            <td class="reason-cell">
              <span v-for="(reason, ri) in item.reasons" :key="ri" class="reason-line">{{ reason }}</span>
              <span v-if="item.conflict" class="conflict-line">配比冲突：{{ item.conflict }}</span>
            </td>
            <td>{{ item.refilledVolume }} / {{ item.remainingRefill }}</td>
            <td v-if="showAction">
              <button class="link" type="button" @click="$emit('refill', { groutingNo: item.groutingNo, batchNo: group.batchNo, remaining: item.remainingRefill })">
                完成补浆
              </button>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-else class="empty-state">当前没有待补浆批次</p>
  </section>
</template>

<script setup lang="ts">
import type { RefillBatchView } from '@/data/grouting-domain'

defineProps<{ groups: RefillBatchView[]; showAction?: boolean }>()
defineEmits<{
  (event: 'refill', payload: { groutingNo: string; batchNo: string; remaining: number }): void
}>()
</script>

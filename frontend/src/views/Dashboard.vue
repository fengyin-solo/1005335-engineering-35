<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
        <button class="btn danger" type="button" :disabled="resetting" @click="resetAll">
          {{ resetting ? '复位中…' : '复位全部数据' }}
        </button>
      </div>
    </header>
    <p v-if="noticeMessage" class="status-legend">{{ noticeMessage }}</p>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>登记总量</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里；「复位全部数据」会把所有模块清单与本页条数一起恢复到种子数据（版本 {{ seedVersion }}）</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import { loadOverview, resetAllData } from '@/api/local-service'
import { onStoreChange } from '@/data/local-store'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const resetting = ref(false)
const noticeMessage = ref('')
const seedVersion = ref('bundled')

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
}

function resetAll() {
  const confirmed = window.confirm('确认把全部业务模块的清单复位到种子数据吗？当前浏览器里的改动会被覆盖。')
  if (!confirmed) return
  resetting.value = true
  noticeMessage.value = ''
  try {
    const result = resetAllData()
    seedVersion.value = result.version
    cards.value = result.overview.cards
    moduleRows.value = result.overview.modules
    const total = result.overview.cards.find((card) => card.label === '登记总量')?.value ?? 0
    noticeMessage.value = `已复位：${moduleRows.value.length} 个模块、登记总量 ${total} 条；再打开各模块清单，条数已同步变化（种子版本 ${result.version}）。`
  } finally {
    resetting.value = false
  }
}

// 其它标签页复位 / 本页动作导致数据变化时，概览条数保持一致
const unsubscribe = onStoreChange(() => refresh())

onMounted(refresh)
onUnmounted(unsubscribe)
</script>

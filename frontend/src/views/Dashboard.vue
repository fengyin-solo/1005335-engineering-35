<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
        <button class="btn primary" type="button" @click="resetAll">全部复位为种子数据</button>
      </div>
    </header>
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
      <span>种子版本 {{ version }}；复位后各模块清单与本页条数同步变化，数据保存在本机浏览器里</span>
      <span v-if="resetMessage" class="reset-note">{{ resetMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview, resetAllModules, seedVersion } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const resetMessage = ref('')
const version = seedVersion()

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
}

function resetAll() {
  const payload = resetAllModules()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  resetMessage.value = `已全部复位：登记总量 ${payload.cards.find((card) => card.label === '登记总量')?.value ?? 0} 条，切换到任意模块清单条数一致`
  refresh()
}

onMounted(refresh)
</script>

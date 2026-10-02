/**
 * 播种/复位流程的端到端校验（由 npm run verify:flow 调用）。
 * 用 Vite SSR 加载真实数据层 + virtual:seed-data，并用内存版 localStorage 模拟浏览器。
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const memory = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
    key: (index) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size
    },
  },
}

const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  server: { middlewareMode: true },
  logLevel: 'silent',
})

const store = await server.ssrLoadModule('/src/data/local-store.ts')
const service = await server.ssrLoadModule('/src/api/local-service.ts')

function counters() {
  const overview = service.loadOverview()
  const valueOf = (label) => overview.cards.find((card) => card.label === label).value
  // 各模块清单条数加总（与页面表格同源）
  const moduleCountSum = overview.modules.reduce((sum, item) => sum + item.created, 0)
  return {
    total: valueOf('登记总量'),
    pending: valueOf('待处理'),
    abnormal: valueOf('异常量'),
    moduleCountSum,
  }
}

function listCount(key) {
  return service.listEntries(key).total
}

// 1) 初始播种口径：54 / 36 / 18，概览汇总等于分模块条数之和
assert.equal(counters().total, 54, '初始登记总量应为 54')
assert.equal(counters().pending, 36)
assert.equal(counters().abnormal, 18)
assert.equal(counters().moduleCountSum, 54, '概览汇总与分模块条数必须一致')
assert.equal(listCount('trench'), 3)
assert.match(store.storageKey(), /^archaeology-field:entries:seed-[0-9a-f]+$/)

// 2) 手工新增一条：对应模块清单与概览条数同步变化
const trench = store.listRows('trench')
store.saveRows('trench', [
  ...trench,
  { id: 999, status: '发掘中', pending: true, abnormal: true, 探方编号: 'TREN-NEW' },
])
assert.equal(listCount('trench'), 4)
assert.equal(counters().total, 55, '新增 1 条后总量应为 55')
assert.equal(counters().pending, 37)
assert.equal(counters().abnormal, 19)
assert.equal(counters().moduleCountSum, 55, '改动后概览与清单仍一致')

// 3) 单模块复位：只有这一模块回到 3 条，概览跟着回到 54
service.resetModule('trench')
assert.equal(listCount('trench'), 3)
assert.equal(counters().total, 54)
assert.equal(counters().pending, 36)
assert.equal(counters().abnormal, 18)

// 4) 手工制造一条异常，再整体复位：概览卡片与清单条数同时恢复
const bone = store.listRows('bone')
store.saveRows('bone', [
  ...bone,
  { id: 888, status: '鉴定中', pending: true, abnormal: true, 标本编号: 'BONE-NEW' },
])
assert.equal(counters().abnormal, 19, '异常数据应使异常量变成 19')
const overview = service.resetAllModules()
assert.equal(counters().total, 54)
assert.equal(counters().pending, 36)
assert.equal(counters().abnormal, 18)
assert.deepEqual(
  overview.cards.map((card) => card.value),
  [18, 54, 36, 18],
  '整体复位返回的卡片应为 18/54/36/18',
)

// 5) 反复复位不产生重复条目，也不产生多余存储键
for (let i = 0; i < 5; i += 1) {
  service.resetAllModules()
}
assert.equal(counters().total, 54, '反复复位后条目数不变')
assert.equal(memory.size, 1, '反复复位不应产生多余的存储键')

// 6) 旧版本/无版本号的历史键会被清掉，避免多套数据混存
memory.set('archaeology-field:entries', JSON.stringify({ trench: [] }))
memory.set('archaeology-field:entries:seed-deadbeef', JSON.stringify({ trench: [] }))
store.resetAllRows()
assert.equal(memory.has('archaeology-field:entries'), false, '历史无版本键应被清理')
assert.equal(memory.has('archaeology-field:entries:seed-deadbeef'), false, '旧版本键应被清理')
assert.equal(memory.size, 1)

await server.close()
process.stdout.write('flow verify OK：54/36/18，概览与清单一致，复位与版本清理均符合预期\n')

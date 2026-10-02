#!/usr/bin/env node
/**
 * 本地开发播种 / 复位流水线（纯 Node 内置模块，不依赖 node_modules 也能先跑起来）。
 *
 * 一条命令串起：依赖校验（缺了自动 npm install）→ 种子校验 → 分模块装载（断点续跑）
 * → 组装运行期快照 → 回读校验。产出 frontend/public/seed-snapshot.json，
 * 前端启动时拉取它作为「复位」与「自动重灌」的统一数据源。
 *
 * 用法：
 *   node scripts/seed.mjs              常规装载；依赖缺失会自动安装，已完成的步骤直接跳过
 *   node scripts/seed.mjs --reset      强制所有浏览器下次打开时复位到种子数据
 *   node scripts/seed.mjs --no-install 依赖缺失时只报错不安装
 *   node scripts/seed.mjs --clean      忽略断点，从头重跑一遍
 *
 * 所有路径都从本文件自身位置推导，仓库克隆到任何目录都能直接跑。
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ───────────────────────── 路径与常量（不写死任何绝对路径） ─────────────────────────
// 默认按仓库布局 scripts/../frontend 推导；容器等场景可用环境变量覆盖。
// 所有默认值都是相对路径，仓库克隆到任何机器/任何目录都能直接跑。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = process.env.SEED_REPO_ROOT
  ? process.env.SEED_REPO_ROOT
  : join(SCRIPT_DIR, '..')
const FRONTEND_DIR = process.env.SEED_FRONTEND_DIR
  ? process.env.SEED_FRONTEND_DIR
  : join(REPO_ROOT, 'frontend')
const SEED_JSON = join(FRONTEND_DIR, 'src', 'data', 'seed.json')
const MODULES_TS = join(FRONTEND_DIR, 'src', 'data', 'modules.ts')
const PACKAGE_JSON = join(FRONTEND_DIR, 'package.json')
const PUBLIC_DIR = join(FRONTEND_DIR, 'public')
const SNAPSHOT_FILE = join(PUBLIC_DIR, 'seed-snapshot.json')

// 断点、暂存与日志默认放在仓库根 .dev/；容器里用可写目录覆盖。
const DEV_DIR = process.env.SEED_STATE_DIR
  ? process.env.SEED_STATE_DIR
  : join(REPO_ROOT, '.dev')
const STAGING_DIR = join(DEV_DIR, 'seed-staging')
const STATE_FILE = join(DEV_DIR, 'seed-state.json')
const LOG_FILE = join(DEV_DIR, 'seed.log')

const MIN_NODE_MAJOR = 18
const STAGE_PREFIX = 'stage:'

const args = new Set(process.argv.slice(2))
const FLAG_RESET = args.has('--reset')
const FLAG_NO_INSTALL = args.has('--no-install')
const FLAG_CLEAN = args.has('--clean')

// ───────────────────────── 日志 ─────────────────────────

function ts() {
  return new Date().toISOString()
}

function log(level, message) {
  const line = `[${ts()}] ${level.padEnd(5)} ${message}`
  if (level === 'ERROR') console.error(line)
  else console.log(line)
  try {
    mkdirSync(DEV_DIR, { recursive: true })
    writeFileSync(LOG_FILE, `${line}\n`, { flag: 'as' })
  } catch {
    // 日志写不进去不阻断主流程
  }
}

// ───────────────────────── 通用工具 ─────────────────────────

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** 稳定序列化：键排序，保证同样的数据算出同样的校验码。 */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

function fail(message) {
  log('ERROR', message)
  process.exitCode = 1
  throw new Error(message)
}

// ───────────────────────── 断点状态 ─────────────────────────

let state = { seedChecksum: '', epoch: 0, snapshotChecksum: '', steps: {} }
let currentStep = null

function loadState() {
  if (!FLAG_CLEAN && existsSync(STATE_FILE)) {
    try {
      state = readJson(STATE_FILE)
    } catch {
      log('WARN', '断点状态文件损坏，按全新装载处理')
      state = { seedChecksum: '', epoch: 0, snapshotChecksum: '', steps: {} }
    }
  }
}

function saveState() {
  writeJsonAtomic(STATE_FILE, state)
}

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 带断点的步骤执行：输入校验码没变且上次已完成，就直接跳过；
 * 步骤开始时先把状态落盘为 interrupted，只有做完才改成 done——
 * 这样跑到一半被杀掉，恢复时能准确知道断在哪一步。
 * 每步开头让出一次事件循环，保证中断信号能在两步之间被处理并记录。
 */
async function runStep(name, inputChecksum, fn) {
  const done = state.steps[name]
  if (done && done.status === 'done' && done.checksum === inputChecksum) {
    log('INFO', `跳过已完成步骤：${name}`)
    return
  }
  await yieldToEventLoop()
  currentStep = name
  state.steps[name] = { status: 'interrupted', checksum: inputChecksum, startedAt: ts() }
  saveState()
  log('INFO', `开始步骤：${name}`)
  await yieldToEventLoop()
  fn()
  state.steps[name] = { status: 'done', checksum: inputChecksum, finishedAt: ts() }
  saveState()
  log('INFO', `完成步骤：${name}`)
  currentStep = null
}

function markInterrupted(signal) {
  if (currentStep) {
    log('WARN', `步骤「${currentStep}」执行中被中断（${signal}），进度已记录，下次运行将从该步骤恢复`)
    state.steps[currentStep] = {
      ...(state.steps[currentStep] ?? {}),
      status: 'interrupted',
      interruptedAt: ts(),
      signal,
    }
    saveState()
  } else {
    log('WARN', `播种流程在两步之间被中断（${signal}），已完成的步骤不会重跑`)
  }
  process.exit(130)
}

process.on('SIGINT', () => markInterrupted('SIGINT'))
process.on('SIGTERM', () => markInterrupted('SIGTERM'))

// ───────────────────────── 步骤 0：依赖校验 ─────────────────────────

function parsePackageDeps() {
  const pkg = readJson(PACKAGE_JSON)
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
}

function missingDependencies() {
  const deps = parsePackageDeps()
  const missing = []
  for (const name of Object.keys(deps)) {
    // 先看包目录在不在
    if (!existsSync(join(FRONTEND_DIR, 'node_modules', name, 'package.json'))) {
      missing.push(name)
    }
  }
  return missing
}

/**
 * 深度校验几个关键依赖「能不能真的加载」。
 * 仅检查目录会漏掉平台不符的情况——例如 node_modules 是在别的系统上装好拷过来的，
 * rollup/esbuild 的原生二进制目录虽然在，但与当前 OS/架构不匹配，vite 一跑就崩。
 * 在独立的 node 子进程里 require，失败即视为依赖不齐全。
 */
const LOAD_PROBES = ['vite', 'vue-tsc', 'rollup']

function brokenDependencies() {
  const script =
    'for (const name of process.argv.slice(1)) { require(require.resolve(name, { paths: [process.cwd()] })) }'
  const probe = spawnSync(
    process.execPath,
    ['-e', script, ...LOAD_PROBES.filter((name) => existsSync(join(FRONTEND_DIR, 'node_modules', name, 'package.json')))],
    { cwd: FRONTEND_DIR, stdio: 'ignore' },
  )
  return probe.status === 0 ? [] : LOAD_PROBES.filter((name) => {
    if (!existsSync(join(FRONTEND_DIR, 'node_modules', name, 'package.json'))) return false
    const one = spawnSync(process.execPath, ['-e', `require(require.resolve(${JSON.stringify(name)}, { paths: [process.cwd()] }))`], {
      cwd: FRONTEND_DIR,
      stdio: 'ignore',
    })
    return one.status !== 0
  })
}

function runNpmInstall(label) {
  log('INFO', `${label}：npm install`)
  const result = spawnSync('npm', ['install'], { cwd: FRONTEND_DIR, stdio: 'inherit' })
  if (result.status !== 0) {
    fail(`npm install 失败（退出码 ${result.status ?? '未知'}），请检查网络或 npm 源后重试`)
  }
}

function installDependencies() {
  runNpmInstall('开始安装前端依赖')
}

/**
 * 原生依赖平台不符时 npm install 常常「up to date」却不补装
 * （npm optional dependencies 的已知缺陷）。此时删掉 node_modules 全新安装一次即可。
 */
function reinstallDependenciesClean() {
  log('WARN', '普通 npm install 未能修复依赖，删除 node_modules 后全新安装（命中 npm 可选依赖缺陷时的兜底处理）')
  rmSync(join(FRONTEND_DIR, 'node_modules'), { recursive: true, force: true })
  runNpmInstall('全新安装前端依赖')
}

function preflight() {
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    fail(`Node.js 版本过低：当前 ${process.versions.node}，需要 >= ${MIN_NODE_MAJOR}.0`)
  }
  const npm = spawnSync('npm', ['--version'], { stdio: 'ignore' })
  if (npm.status !== 0) {
    fail('未检测到 npm，请先安装 Node.js（自带 npm）后重试')
  }
  for (const [label, file] of [
    ['package.json', PACKAGE_JSON],
    ['模块元数据 modules.ts', MODULES_TS],
    ['种子数据 seed.json', SEED_JSON],
  ]) {
    if (!existsSync(file)) fail(`缺少必需文件：${label}（${file}）`)
  }

  const missingList = missingDependencies()
  const brokenList = missingList.length > 0 ? [] : brokenDependencies()
  const problems = [
    ...missingList.map((name) => `缺少 ${name}`),
    ...brokenList.map((name) => `${name} 已安装但无法加载（可能是跨系统/架构拷贝的原生依赖）`),
  ]

  if (problems.length > 0) {
    log('WARN', `依赖校验未通过：${problems.join('；')}`)
    if (FLAG_NO_INSTALL) {
      fail(`依赖不齐全且指定了 --no-install，请先在 frontend/ 下执行 npm install；问题：${problems.join('；')}`)
    }
    // 单纯缺包先试普通安装；原生依赖损坏（平台不符）普通 install 修不好，直接全量重装
    if (brokenList.length > 0) {
      reinstallDependenciesClean()
    } else {
      installDependencies()
      if (brokenDependencies().length > 0) {
        log('WARN', '普通安装后仍有原生依赖无法加载，改为全量重装再试一次')
        reinstallDependenciesClean()
      }
    }
    const stillMissing = missingDependencies()
    const stillBroken = stillMissing.length > 0 ? [] : brokenDependencies()
    if (stillMissing.length > 0 || stillBroken.length > 0) {
      fail(`依赖重装后仍不齐全：${[...stillMissing, ...stillBroken].join(', ')}`)
    }
  }
  log('INFO', '运行环境与依赖校验通过（node / npm / node_modules 均齐全且可加载）')
}

// ───────────────────────── 步骤 1：种子与模块元数据校验 ─────────────────────────

function extractStringArray(source, label) {
  const match = source.match(new RegExp(`${label}:\\s*\\[([^\\]]*)\\]`))
  if (!match) return null
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1])
}

function parseModulesMeta() {
  const source = readFileSync(MODULES_TS, 'utf8')
  const blocks = [...source.matchAll(/\{[^{}]*key:\s*"([^"]+)"[\s\S]*?\n\s*\}/g)]
  const metas = blocks.map((block) => ({
    key: block[1],
    fields: extractStringArray(block[0], 'fields') ?? [],
    statuses: extractStringArray(block[0], 'statuses') ?? [],
  }))
  if (metas.length === 0) fail('未能从 modules.ts 解析出任何业务模块')
  return metas
}

function validateSeed(seedRows, metas) {
  const seedKeys = Object.keys(seedRows)
  const metaKeys = metas.map((meta) => meta.key)

  const onlyInSeed = seedKeys.filter((key) => !metaKeys.includes(key))
  const onlyInMeta = metaKeys.filter((key) => !seedKeys.includes(key))
  if (onlyInSeed.length || onlyInMeta.length) {
    fail(
      `种子模块与 modules.ts 对不上：种子多出 [${onlyInSeed.join(', ')}]，元数据多出 [${onlyInMeta.join(', ')}]`,
    )
  }

  let total = 0
  let pending = 0
  let abnormal = 0
  for (const meta of metas) {
    const rows = seedRows[meta.key]
    if (!Array.isArray(rows)) fail(`模块 ${meta.key} 的种子不是数组`)
    const seenIds = new Set()
    const seenCodes = new Set()
    const codeField = meta.fields[0]
    rows.forEach((row, index) => {
      const where = `${meta.key} 第 ${index + 1} 行`
      if (typeof row.id !== 'number' || !Number.isInteger(row.id) || row.id <= 0) {
        fail(`${where} 的 id 必须是正整数`)
      }
      if (seenIds.has(row.id)) fail(`${where} 的 id=${row.id} 重复`)
      seenIds.add(row.id)
      if (typeof row.status !== 'string' || !meta.statuses.includes(row.status)) {
        fail(`${where} 的状态「${row.status}」不在 ${meta.key} 的状态集合 [${meta.statuses.join(' / ')}] 内`)
      }
      if (typeof row.pending !== 'boolean') fail(`${where} 的 pending 必须是布尔值`)
      if (typeof row.abnormal !== 'boolean') fail(`${where} 的 abnormal 必须是布尔值`)
      for (const field of meta.fields) {
        if (!(field in row)) fail(`${where} 缺少字段「${field}」`)
      }
      const code = String(row[codeField] ?? '')
      if (seenCodes.has(code)) fail(`${where} 业务编号「${code}」重复，重复装载会产生多余条目`)
      seenCodes.add(code)
      total += 1
      if (row.pending) pending += 1
      if (row.abnormal) abnormal += 1
    })
    log('INFO', `校验通过：${meta.key} ${rows.length} 条（待处理 ${rows.filter((r) => r.pending).length}，异常 ${rows.filter((r) => r.abnormal).length}）`)
  }
  return { modules: metas.length, total, pending, abnormal }
}

// ───────────────────────── 步骤 2：分模块装载到暂存区 ─────────────────────────

function stageModule(key, rows) {
  const file = join(STAGING_DIR, `${key}.json`)
  const payload = { key, rows }
  writeJsonAtomic(file, payload)
}

// ───────────────────────── 步骤 3/4：组装快照并回读校验 ─────────────────────────

function assembleSnapshot(seedRows, totals, epoch) {
  const rows = {}
  for (const file of readdirSync(STAGING_DIR).sort()) {
    if (!file.endsWith('.json')) continue
    const staged = readJson(join(STAGING_DIR, file))
    rows[staged.key] = staged.rows
  }
  return {
    version: `${state.seedChecksum.slice(0, 12)}.${epoch}`,
    seedChecksum: state.seedChecksum,
    epoch,
    generatedAt: ts(),
    totals,
    rows,
  }
}

function verifySnapshot(snapshot, seedRows, totals) {
  const reread = readJson(SNAPSHOT_FILE)
  const problems = []

  if (reread.version !== snapshot.version) problems.push('快照版本号写回后不一致')

  const seedKeys = Object.keys(seedRows).sort()
  const snapKeys = Object.keys(reread.rows).sort()
  if (JSON.stringify(seedKeys) !== JSON.stringify(snapKeys)) {
    problems.push('快照模块集合与种子不一致')
  }

  let total = 0
  let pending = 0
  let abnormal = 0
  for (const key of seedKeys) {
    const seed = seedRows[key]
    const got = reread.rows[key]
    // 逐字段比对，确保快照就是种子的原样拷贝，清单条数不会多也不会少
    if (stableStringify(got) !== stableStringify(seed)) {
      problems.push(`模块 ${key} 的快照内容与种子不一致（种子 ${seed.length} 条，快照 ${got.length} 条）`)
    }
    total += got.length
    pending += got.filter((row) => row.pending).length
    abnormal += got.filter((row) => row.abnormal).length
  }

  const actual = { modules: seedKeys.length, total, pending, abnormal }
  for (const name of ['modules', 'total', 'pending', 'abnormal']) {
    if (actual[name] !== totals[name]) {
      problems.push(`汇总「${name}」不一致：声明 ${totals[name]}，实算 ${actual[name]}`)
    }
  }
  if (JSON.stringify(reread.totals) !== JSON.stringify(totals)) {
    problems.push('快照内置 totals 与实算不一致')
  }

  if (problems.length > 0) fail(`快照校验失败：\n  - ${problems.join('\n  - ')}`)

  log('INFO', `快照回读校验通过：${actual.modules} 个模块 / 登记总量 ${actual.total} / 待处理 ${actual.pending} / 异常量 ${actual.abnormal}`)
  log('INFO', `概览条数与各模块清单条数同源，均以 ${SNAPSHOT_FILE} 为准`)
  return actual
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  mkdirSync(DEV_DIR, { recursive: true })
  log('INFO', `播种流程启动（参数：${[...args].join(' ') || '无'}）`)

  if (FLAG_CLEAN) {
    for (const file of [STATE_FILE]) {
      if (existsSync(file)) rmSync(file)
    }
    if (existsSync(STAGING_DIR)) rmSync(STAGING_DIR, { recursive: true, force: true })
    log('INFO', '已按 --clean 清掉旧断点与暂存区')
  }

  // 依赖检查每次都跑（很快），不纳入断点：环境问题必须每次暴露
  preflight()
  await yieldToEventLoop()

  loadState()

  const seedRows = readJson(SEED_JSON)
  const seedChecksum = sha256(stableStringify(seedRows))
  if (state.seedChecksum && state.seedChecksum !== seedChecksum) {
    log('INFO', `检测到 seed.json 变更（${state.seedChecksum.slice(0, 12)} → ${seedChecksum.slice(0, 12)}），仅受影响步骤会重跑`)
  }
  state.seedChecksum = seedChecksum

  if (FLAG_RESET) {
    state.epoch = (state.epoch ?? 0) + 1
    log('INFO', `--reset：运行期复位代号推进到 epoch=${state.epoch}，浏览器下次打开将统一复位`)
  }
  if (!state.epoch) state.epoch = 1
  saveState()

  const metas = parseModulesMeta()

  let totals
  await runStep('validate-seed', seedChecksum, () => {
    totals = validateSeed(seedRows, metas)
  })
  // validateSeed 是在步骤函数里赋值的，跳过步骤时也要拿到 totals
  totals = totals ?? {
    modules: metas.length,
    total: Object.values(seedRows).reduce((sum, rows) => sum + rows.length, 0),
    pending: Object.values(seedRows).flat().filter((row) => row.pending).length,
    abnormal: Object.values(seedRows).flat().filter((row) => row.abnormal).length,
  }

  mkdirSync(STAGING_DIR, { recursive: true })
  for (const meta of metas) {
    const rows = seedRows[meta.key]
    await runStep(`${STAGE_PREFIX}${meta.key}`, sha256(stableStringify(rows)), () => {
      stageModule(meta.key, rows)
    })
  }

  const stagingSignature = sha256(
    metas.map((meta) => `${meta.key}:${sha256(stableStringify(seedRows[meta.key]))}`).join('|') + `#epoch:${state.epoch}`,
  )

  await runStep(`assemble-snapshot#${state.epoch}`, stagingSignature, () => {
    const snapshot = assembleSnapshot(seedRows, totals, state.epoch)
    writeJsonAtomic(SNAPSHOT_FILE, snapshot)
    state.snapshotChecksum = sha256(stableStringify(snapshot))
    saveState()
  })

  await runStep(`verify-snapshot#${state.epoch}`, state.snapshotChecksum, () => {
    const snapshot = assembleSnapshot(seedRows, totals, state.epoch)
    verifySnapshot(snapshot, seedRows, totals)
  })

  log('INFO', `播种完成：快照 ${SNAPSHOT_FILE}（版本 ${state.seedChecksum.slice(0, 12)}.${state.epoch}）`)
  if (FLAG_RESET) {
    log('INFO', '已生成复位版本：保持 dev server 运行，刷新浏览器即会复位；或运行 npm run dev 后打开页面')
  }
}

main().catch((error) => {
  if (process.exitCode !== 1) {
    log('ERROR', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
})

/**
 * 本地播种与复位流程的核心库（Node 内置模块，零第三方依赖）。
 *
 * 职责：
 *  1. 装载前校验运行环境与依赖是否齐全（缺依赖自动 npm install）；
 *  2. 校验权威种子 seed/seed-data.json 与模块元数据 modules.ts 是否对得上；
 *  3. 逐模块原子落盘快照，并把执行进度写入检查点，中断后重跑只补未完成的步骤；
 *  4. 每一步（含中断发生时正在执行的那一步）都追加进日志 .dev/seed/seed.log。
 *
 * 浏览器侧通过 Vite 虚拟模块 virtual:seed-data 消费这里产出的快照，
 * 因此「CLI 播种」和「页面运行期复位」用的是同一份数据，概览与清单条数必然一致。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 所有路径都从本文件的位置推导，仓库克隆到任意目录都能跑，不写死绝对路径。
const here = path.dirname(fileURLToPath(import.meta.url))
export const FRONTEND_DIR = path.resolve(here, '..')
export const REPO_ROOT = path.resolve(FRONTEND_DIR, '..')
export const SEED_SOURCE = path.join(REPO_ROOT, 'seed', 'seed-data.json')
export const SEED_DIR = path.join(FRONTEND_DIR, '.dev', 'seed')
export const MODULES_DIR = path.join(SEED_DIR, 'modules')
export const CHECKPOINT_FILE = path.join(SEED_DIR, 'checkpoint.json')
export const SNAPSHOT_FILE = path.join(SEED_DIR, 'snapshot.json')
export const MANIFEST_FILE = path.join(SEED_DIR, 'manifest.json')
export const LOG_FILE = path.join(SEED_DIR, 'seed.log')

export const SEED_VERSION_PREFIX = 'seed'
const STEP_LABELS = {
  preflight: '校验依赖',
  validate: '校验种子数据',
  modules: '装载模块快照',
  manifest: '写入清单与快照',
}
// 运行时三件套 + 构建工具链：缺任一项 dev/build 都起不来，preflight 一并校验。
const REQUIRED_RUNTIME_PACKAGES = ['vue', 'vue-router', 'pinia', 'vite']

export class SeedError extends Error {}

class Logger {
  constructor(logFile) {
    this.logFile = logFile
  }

  line(level, message) {
    const entry = `${new Date().toISOString()} [${level}] ${message}`
    // 控制台与日志文件同步输出：运行期/CI 都能看到同一份记录。
    const stream = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout
    stream.write(`${entry}\n`)
    try {
      appendFileSync(this.logFile, `${entry}\n`)
    } catch {
      // 日志写不进不影响播种本身，控制台已有输出。
    }
  }

  info(message) {
    this.line('INFO', message)
  }

  warn(message) {
    this.line('WARN', message)
  }

  error(message) {
    this.line('ERROR', message)
  }
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

async function atomicWriteJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** modules.ts 是 TS 源文件，这里只做正则级轻量提取，避免引入编译器依赖。 */
export function extractModuleKeys(modulesFile) {
  const text = readFileSync(modulesFile, 'utf8')
  const keys = []
  const keyPattern = /\bkey:\s*["']([^"']+)["']/g
  let match
  while ((match = keyPattern.exec(text)) !== null) {
    keys.push(match[1])
  }
  return keys
}

export function loadSeedSource() {
  if (!existsSync(SEED_SOURCE)) {
    throw new SeedError(`找不到权威种子文件：${path.relative(REPO_ROOT, SEED_SOURCE)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(SEED_SOURCE, 'utf8'))
  } catch (cause) {
    throw new SeedError(`种子文件不是合法 JSON：${path.relative(REPO_ROOT, SEED_SOURCE)}（${cause.message}）`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SeedError('种子文件顶层必须是以模块 key 为键的对象')
  }
  return parsed
}

export function validateSeed(seed, expectedKeys) {
  const sourceKeys = Object.keys(seed)
  const missing = expectedKeys.filter((key) => !sourceKeys.includes(key))
  const extra = sourceKeys.filter((key) => !expectedKeys.includes(key))
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length ? `种子缺模块：${missing.join('、')}` : '',
      extra.length ? `种子多出未登记模块：${extra.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('；')
    throw new SeedError(`种子模块与 modules.ts 对不上：${details}`)
  }

  const modules = []
  let total = 0
  let pending = 0
  let abnormal = 0
  for (const key of expectedKeys) {
    const rows = seed[key]
    if (!Array.isArray(rows)) {
      throw new SeedError(`模块 ${key} 的种子必须是数组`)
    }
    const seenIds = new Set()
    for (const [index, row] of rows.entries()) {
      if (!row || typeof row !== 'object') {
        throw new SeedError(`模块 ${key} 第 ${index + 1} 条不是对象`)
      }
      if (typeof row.id !== 'number' || !Number.isInteger(row.id) || row.id <= 0) {
        throw new SeedError(`模块 ${key} 第 ${index + 1} 条缺少合法的数字 id`)
      }
      if (seenIds.has(row.id)) {
        throw new SeedError(`模块 ${key} 的 id=${row.id} 重复，重复播种会破坏条数`)
      }
      seenIds.add(row.id)
      if (typeof row.status !== 'string' || row.status.trim() === '') {
        throw new SeedError(`模块 ${key} id=${row.id} 缺少 status`)
      }
      if (typeof row.pending !== 'boolean' || typeof row.abnormal !== 'boolean') {
        throw new SeedError(`模块 ${key} id=${row.id} 的 pending/abnormal 必须是布尔值`)
      }
      total += 1
      if (row.pending) pending += 1
      if (row.abnormal) abnormal += 1
    }
    modules.push({ key, count: rows.length })
  }
  return { modules, total, pending, abnormal }
}

/** 装载前校验依赖：Node 版本、package.json、运行时包能否解析；缺失则自动安装一次再复检。 */
export function ensureDependencies(logger, { autoInstall = true } = {}) {
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isNaN(major) || major < 18) {
    throw new SeedError(`Node 版本过低（当前 ${process.versions.node}），需要 Node >= 18`)
  }

  const pkgFile = path.join(FRONTEND_DIR, 'package.json')
  if (!existsSync(pkgFile)) {
    throw new SeedError(`找不到 ${path.relative(REPO_ROOT, pkgFile)}，请确认仓库完整`)
  }

  const requireFromFrontend = createRequire(path.join(FRONTEND_DIR, 'package.json'))
  const missing = REQUIRED_RUNTIME_PACKAGES.filter((name) => {
    try {
      requireFromFrontend.resolve(name)
      return false
    } catch {
      return true
    }
  })

  // 包目录在、但平台原生可选依赖不匹配（例如换机器直接拷了 node_modules）时，
  // 光解析包路径发现不了；实际让 vite 与 esbuild 跑一次才能确认工具链可用
  //（rollup / esbuild 的原生二进制缺失只在真正执行时才暴露）。
  function toolchainBroken() {
    const probe = `
      const { createRequire } = require('node:module')
      const req = createRequire(${JSON.stringify(path.join(FRONTEND_DIR, 'package.json'))})
      try {
        req.resolve('vite')
        const esbuild = req('esbuild')
        esbuild.transformSync('const answer = 1', { loader: 'js' })
      } catch (error) {
        process.exit(2)
      }
    `
    const check = spawnSync(process.execPath, ['-e', probe], {
      cwd: FRONTEND_DIR,
      stdio: 'ignore',
    })
    return check.status !== 0
  }

  let broken = false
  if (missing.length === 0) {
    broken = toolchainBroken()
    if (!broken) {
      logger.info('依赖齐全，跳过安装')
      return { installed: false, missing: [] }
    }
    logger.warn('依赖目录存在但工具链无法运行（常见于跨机器拷贝 node_modules，缺少本平台原生包）')
  } else {
    logger.warn(`缺少依赖：${missing.join('、')}`)
  }
  if (!autoInstall) {
    throw new SeedError('依赖不完整，请先在 frontend 目录执行 npm install')
  }

  logger.info(`开始安装依赖（npm install，目录 ${path.relative(REPO_ROOT, FRONTEND_DIR)}）`)
  const runInstall = (args = []) =>
    spawnSync(npmCommand(), ['install', ...args], {
      cwd: FRONTEND_DIR,
      stdio: 'inherit',
    })
  let result = runInstall()
  if (result.status !== 0) {
    throw new SeedError(`npm install 失败（退出码 ${result.status ?? '未知'}），请检查网络或镜像后重试`)
  }

  const isReady = () =>
    REQUIRED_RUNTIME_PACKAGES.every((name) => {
      try {
        requireFromFrontend.resolve(name)
        return true
      } catch {
        return false
      }
    }) && !toolchainBroken()

  // npm optional-dependencies 的已知缺陷：换平台后 install 报 up to date 却不补
  // 本平台原生包（@rollup/rollup-<platform>）。依次加 --force、刷新 lockfile 重试。
  if (!isReady()) {
    logger.warn('常规安装后工具链仍不完整，使用 npm install --force 补装平台原生包')
    result = runInstall(['--force'])
    if (result.status !== 0) {
      throw new SeedError(`npm install --force 失败（退出码 ${result.status ?? '未知'}）`)
    }
  }

  if (!isReady()) {
    // lockfile 在别的平台生成时，只锁了该平台的可选依赖条目；刷新 lockfile 后才能补齐。
    const lockFile = path.join(FRONTEND_DIR, 'package-lock.json')
    if (existsSync(lockFile)) {
      logger.warn('平台原生包仍缺失（lockfile 疑似在其他平台生成），刷新 package-lock.json 后重装')
      rmSync(lockFile, { force: true })
      result = runInstall()
      if (result.status !== 0) {
        throw new SeedError(`刷新 lockfile 后的 npm install 失败（退出码 ${result.status ?? '未知'}）`)
      }
    }
  }

  if (!isReady()) {
    // 最后一档：node_modules 是从别的机器/平台整个拷过来的脏目录，按 npm 官方建议清空后干净重装。
    logger.warn('依赖目录疑似跨平台拷贝的损坏副本，清空 node_modules 后干净安装一次')
    rmSync(path.join(FRONTEND_DIR, 'node_modules'), { recursive: true, force: true })
    result = runInstall()
    if (result.status !== 0) {
      throw new SeedError(`干净安装失败（退出码 ${result.status ?? '未知'}），请检查网络后手动执行 npm install`)
    }
  }

  const stillMissing = REQUIRED_RUNTIME_PACKAGES.filter((name) => {
    try {
      requireFromFrontend.resolve(name)
      return false
    } catch {
      return true
    }
  })
  if (stillMissing.length > 0 || toolchainBroken()) {
    throw new SeedError(
      stillMissing.length > 0
        ? `依赖安装后仍无法解析：${stillMissing.join('、')}，请删除 node_modules 后重试 npm install`
        : '依赖已安装但工具链仍无法运行（本平台原生包缺失），请删除 node_modules 后重试 npm install',
    )
  }
  logger.info('依赖安装并复检通过')
  return { installed: true, missing: broken ? REQUIRED_RUNTIME_PACKAGES : missing }
}

function readCheckpoint() {
  try {
    const checkpoint = readJson(CHECKPOINT_FILE)
    if (checkpoint && checkpoint.version === undefined) return null
    return checkpoint
  } catch {
    return null
  }
}

/** 单模块快照是否与检查点登记一致；一致即视为已完成，重跑时直接跳过。 */
function moduleFragmentDone(key, checksum) {
  try {
    const fragment = readJson(path.join(MODULES_DIR, `${key}.json`))
    return fragment && fragment.checksum === checksum && Array.isArray(fragment.rows)
  } catch {
    return false
  }
}

function cleanupStagingFiles() {
  if (!existsSync(MODULES_DIR)) return
  for (const name of readdirSync(MODULES_DIR)) {
    if (name.endsWith('.tmp') || /\.tmp-\d+$/.test(name)) {
      rmSync(path.join(MODULES_DIR, name), { force: true })
    }
  }
}

/**
 * 跑完整播种流程。
 * @param {{force?: boolean, preflightOnly?: boolean, autoInstall?: boolean}} options
 *   force=true 清掉旧检查点从头跑；中断后重跑（不带 force）从断点继续。
 */
export async function runSeed(options = {}) {
  const { force = false, preflightOnly = false, autoInstall = true } = options
  await mkdir(SEED_DIR, { recursive: true })
  await mkdir(MODULES_DIR, { recursive: true })
  const logger = new Logger(LOG_FILE)
  const startedAt = new Date().toISOString()
  logger.info(`播种启动（run=${startedAt}${force ? '，force 全量重跑' : ''}）`)

  // 全量重跑：清掉检查点与旧产物（日志保留并追加）。
  if (force && existsSync(CHECKPOINT_FILE)) {
    rmSync(CHECKPOINT_FILE, { force: true })
  }
  if (force && existsSync(MODULES_DIR)) {
    rmSync(MODULES_DIR, { recursive: true, force: true })
    await mkdir(MODULES_DIR, { recursive: true })
  }
  if (force) {
    rmSync(SNAPSHOT_FILE, { force: true })
    rmSync(MANIFEST_FILE, { force: true })
  }
  cleanupStagingFiles()

  let interrupted = false
  const abort = (reason) => {
    interrupted = true
    logger.error(`播种在步骤「${reason.step ? STEP_LABELS[reason.step] : reason.stepName ?? ''}」执行过程中被中断：${reason.detail}`)
  }
  const signalHandler = (signal) => () => {
    abort({ step: currentStep, detail: `收到 ${signal} 信号` })
    process.exit(130)
  }
  const sigint = signalHandler('SIGINT')
  const sigterm = signalHandler('SIGTERM')
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)

  let currentStep = null
  const checkpoint = force ? { version: 'pending', completed: [], modules: [] } : (readCheckpoint() ?? { version: 'pending', completed: [], modules: [] })
  checkpoint.completed = Array.isArray(checkpoint.completed) ? checkpoint.completed : []
  checkpoint.modules = Array.isArray(checkpoint.modules) ? checkpoint.modules : []

  async function runStep(step, task, { always = false } = {}) {
    if (interrupted) return
    currentStep = step
    if (!force && !always && checkpoint.completed.includes(step)) {
      logger.info(`步骤「${STEP_LABELS[step]}」已完成，断点续跑跳过`)
      return
    }
    if (process.env.SEED_ABORT_AT === step) {
      abort({ step, detail: '命中 SEED_ABORT_AT，用于验证中断恢复' })
      throw new SeedError(`已按 SEED_ABORT_AT 在步骤「${STEP_LABELS[step]}」中断`)
    }
    logger.info(`开始步骤「${STEP_LABELS[step]}」`)
    try {
      const result = await task()
      if (!checkpoint.completed.includes(step)) {
        checkpoint.completed.push(step)
      }
      await atomicWriteJson(CHECKPOINT_FILE, checkpoint)
      logger.info(`步骤「${STEP_LABELS[step]}」完成`)
      return result
    } catch (error) {
      logger.error(`步骤「${STEP_LABELS[step]}」失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      currentStep = null
    }
  }

  try {
    // 1) 依赖校验：每轮启动都强制执行（不走检查点），保证「别人克隆下来直接跑」。
    //    检查点只登记它，便于观察流程完整性，但续跑时也会重新校验一遍。
    await runStep('preflight', () => ensureDependencies(logger, { autoInstall }), { always: true })
    if (preflightOnly) {
      logger.info('仅校验模式：依赖校验通过，结束')
      return { skipped: true }
    }

    // 2) 读入并校验权威种子（内存里每轮都重算；步骤是否跳过只影响是否登记检查点）
    const rawSource = await readFile(SEED_SOURCE, 'utf8')
    const checksum = hashContent(rawSource)
    const version = `${SEED_VERSION_PREFIX}-${checksum}`
    const seed = loadSeedSource()
    const expected = extractModuleKeys(path.join(FRONTEND_DIR, 'src', 'data', 'modules.ts'))
    const stats = validateSeed(seed, expected)
    // validate 每次都跑：种子或 modules.ts 可能在上次播种后被改动，必须先校验并比对版本，
    // 再决定后续步骤能否走检查点；不能让它被「已完成」跳过。
    await runStep('validate', async () => {
      if (checkpoint.version !== 'pending' && checkpoint.version !== version) {
        // 种子内容变了，旧检查点与旧分片全部作废，避免把两套数据混在一起。
        logger.warn(`种子版本由 ${checkpoint.version} 变为 ${version}，旧进度作废后重装`)
        checkpoint.completed = checkpoint.completed.filter((step) => step === 'preflight')
        checkpoint.modules = []
        rmSync(MODULES_DIR, { recursive: true, force: true })
        await mkdir(MODULES_DIR, { recursive: true })
      }
      checkpoint.version = version
      return true
    }, { always: true })
    if (interrupted) throw new SeedError('播种已中断')

    // 3) 逐模块原子落盘：已完成且 checksum 一致的模块不重写、不重复计数。
    // SEED_ABORT_AFTER=N：写完第 N 个模块后按中断处理，供验证模块级断点续跑。
    const abortAfter = Number(process.env.SEED_ABORT_AFTER ?? 0)
    const moduleDelayMs = Number(process.env.SEED_MODULE_DELAY_MS ?? 0)
    await runStep('modules', async () => {
      const done = []
      let written = 0
      for (const { key, count } of stats.modules) {
        if (!force && checkpoint.modules.some((item) => item.key === key && item.checksum === checksum) && moduleFragmentDone(key, checksum)) {
          logger.info(`模块 ${key}（${count} 条）已在检查点中，跳过不重写`)
          done.push({ key, count, skipped: true })
          continue
        }
        await atomicWriteJson(path.join(MODULES_DIR, `${key}.json`), {
          key,
          checksum,
          rows: seed[key],
        })
        checkpoint.modules = checkpoint.modules.filter((item) => item.key !== key)
        checkpoint.modules.push({ key, checksum, count })
        await atomicWriteJson(CHECKPOINT_FILE, checkpoint)
        logger.info(`模块 ${key} 已装载（${count} 条）并记入检查点`)
        done.push({ key, count, skipped: false })
        written += 1
        if (moduleDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, moduleDelayMs))
        }
        if (abortAfter > 0 && written === abortAfter) {
          throw new SeedError(`命中 SEED_ABORT_AFTER=${abortAfter}，模块「${key}」已完成后中断`)
        }
      }
      return done
    })
    if (interrupted) throw new SeedError('播种已中断')

    // 4) 汇总快照与清单（供 Vite 虚拟模块与 README/排障核对）
    await runStep('manifest', async () => {
      const rowsByKey = {}
      for (const key of stats.modules.map((item) => item.key)) {
        rowsByKey[key] = seed[key]
      }
      await atomicWriteJson(SNAPSHOT_FILE, { version, checksum, rows: rowsByKey })
      const manifest = {
        version,
        checksum,
        source: path.relative(REPO_ROOT, SEED_SOURCE).split(path.sep).join('/'),
        generatedAt: new Date().toISOString(),
        moduleCount: stats.modules.length,
        total: stats.total,
        pending: stats.pending,
        abnormal: stats.abnormal,
        modules: stats.modules,
      }
      await atomicWriteJson(MANIFEST_FILE, manifest)
      return manifest
    })

    // 断点续跑可能整步都跳过：统一以落盘清单为准，保证幂等重跑也能打印汇总。
    const summary = readJson(MANIFEST_FILE)
    logger.info(
      `播种完成：版本 ${version}，模块 ${summary.moduleCount} 个，登记总量 ${summary.total}，待处理 ${summary.pending}，异常量 ${summary.abnormal}`,
    )
    return { summary }
  } catch (error) {
    if (!interrupted) {
      logger.error(`播种终止：${error instanceof Error ? error.message : String(error)}`)
    }
    logger.warn('已完成的步骤/模块已记入检查点，重新执行本命令可从断点继续，不会重来')
    throw error
  } finally {
    process.removeListener('SIGINT', sigint)
    process.removeListener('SIGTERM', sigterm)
  }
}

/** Vite 插件用：快照或清单缺失/过期时同步补齐（仍走断点续跑逻辑）。 */
export function ensureSnapshotSync(logger = console) {
  let rawSource
  try {
    rawSource = readFileSync(SEED_SOURCE, 'utf8')
  } catch {
    return null
  }
  const checksum = hashContent(rawSource)
  let manifest = null
  try {
    manifest = readJson(MANIFEST_FILE)
  } catch {
    manifest = null
  }
  if (manifest && manifest.checksum === checksum && existsSync(SNAPSHOT_FILE)) {
    return manifest
  }
  logger.info?.('[seed] 快照缺失或种子已更新，执行播种')
  const result = spawnSync(
    process.execPath,
    [path.join(here, 'seed-cli.mjs')],
    { cwd: FRONTEND_DIR, stdio: 'inherit' },
  )
  if (result.status !== 0) {
    throw new SeedError('自动播种失败，请按上方日志排查后重试')
  }
  return readJson(MANIFEST_FILE)
}

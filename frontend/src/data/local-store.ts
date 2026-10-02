import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'archaeology-field:entries'
const META_KEY = 'archaeology-field:seed-meta'

// 运行期复位的统一数据源：scripts/seed.mjs 从 seed.json 组装而来。
// 概览与各模块清单都读这一份，两处条数必然一致。
const SNAPSHOT_URL = `${import.meta.env.BASE_URL}seed-snapshot.json`

export type SeedSnapshot = {
  version: string
  seedChecksum: string
  epoch: number
  generatedAt: string
  totals: { modules: number; total: number; pending: number; abnormal: number }
  rows: Record<string, EntryRow[]>
}

type StoredMeta = { version: string }

// 播种流水线装载完成前应用还没 mount，期间拿到的快照保存在这里。
let activeSnapshot: SeedSnapshot | null = null
let seedSource: Record<string, EntryRow[]> = clone(SEED_ROWS)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 应用启动前调用：拉取装载流水线产出的快照，版本变了就自动重灌 localStorage。 */
export async function bootstrapSeed(): Promise<void> {
  try {
    const response = await fetch(SNAPSHOT_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    activeSnapshot = (await response.json()) as SeedSnapshot
    seedSource = clone(activeSnapshot.rows)
  } catch {
    // 快照缺失（例如还没跑过 scripts/seed.mjs）：退回代码内置种子并给出可见提示
    activeSnapshot = null
    seedSource = clone(SEED_ROWS)
    console.warn(
      '[seed] 没有取到 seed-snapshot.json，已退回代码内置种子。本地开发请先执行：npm run setup（或 make setup）',
    )
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const meta = readMeta()
    const expectedVersion = activeSnapshot?.version ?? 'bundled'
    if (!raw || meta?.version !== expectedVersion) {
      // 首次打开、种子内容变化或 --reset 推进 epoch：统一整库重灌，不与旧数据做 merge
      replaceAll(seedSource, expectedVersion)
    }
  }
  cache = null
}

function readMeta(): StoredMeta | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const raw = window.localStorage.getItem(META_KEY)
    return raw ? (JSON.parse(raw) as StoredMeta) : null
  } catch {
    return null
  }
}

/** 按 id 去重，保证反复装载同一批种子不会多出条目（种子里 id 唯一，装载前已校验）。 */
function dedupe(rows: EntryRow[]): EntryRow[] {
  const seen = new Set<number>()
  const result: EntryRow[] = []
  for (const row of rows) {
    if (seen.has(Number(row.id))) continue
    seen.add(Number(row.id))
    result.push(row)
  }
  return result
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(seedSource)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = clone(seedSource)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 能走到这里说明 meta 版本与当前快照一致：直接以存储为准，
    // 不再与种子 merge（旧实现的 merge 正是「概览与清单对不上」的根源）。
    return parsed
  } catch {
    const fallback = clone(seedSource)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: dedupe(rows) }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  emitChange([key])
}

function replaceAll(rows: Record<string, EntryRow[]>, version: string): void {
  const clean: Record<string, EntryRow[]> = {}
  for (const [key, items] of Object.entries(rows)) {
    clean[key] = dedupe(clone(items))
  }
  cache = clean
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
    window.localStorage.setItem(META_KEY, JSON.stringify({ version }))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(seedSource[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 运行期整库复位：所有业务模块清单条数立即回到种子状态。 */
export function resetAllRows(): { version: string; modules: number; total: number } {
  const version = activeSnapshot?.version ?? 'bundled'
  replaceAll(seedSource, version)
  emitChange(Object.keys(seedSource))
  const total = Object.values(seedSource).reduce((sum, items) => sum + items.length, 0)
  return { version, modules: Object.keys(seedSource).length, total }
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ───────────────────────── 数据变更广播 ─────────────────────────

export const STORE_CHANGE_EVENT = 'archaeology-field:store-change'

export type StoreChangeDetail = { keys: string[] }

type StoreChangeListener = (detail: StoreChangeDetail) => void
const listeners = new Set<StoreChangeListener>()

function emitChange(keys: string[]): void {
  const detail = { keys }
  for (const listener of listeners) {
    listener(detail)
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<StoreChangeDetail>(STORE_CHANGE_EVENT, { detail }))
  }
}

export function onStoreChange(listener: StoreChangeListener): () => void {
  listeners.add(listener)
  // 其它标签页里清存储 / 复位时，本页也跟着刷新
  const storageHandler = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
      listener({ keys: Object.keys(allRows()) })
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', storageHandler)
  }
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', storageHandler)
    }
  }
}

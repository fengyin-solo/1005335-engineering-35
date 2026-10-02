import seedSnapshot from 'virtual:seed-data'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 存储键带种子版本：seed/seed-data.json 一改动，页面自动用新种子重建，
// 不会把旧版本浏览器里的残留数据并回来（重装依赖/换机器口径都一致）。
const STORAGE_KEY_PREFIX = 'archaeology-field:entries:'
const LEGACY_STORAGE_KEY = 'archaeology-field:entries'

export const SEED_VERSION = seedSnapshot.version
const STORAGE_KEY = `${STORAGE_KEY_PREFIX}${seedSnapshot.version}`

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedRows(): Record<string, EntryRow[]> {
  return clone(seedSnapshot.rows)
}

function pruneStorages() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 清掉旧版本以及无版本号的历史键，只保留当前种子版本，避免多套数据并存。
  const staleKeys = [LEGACY_STORAGE_KEY]
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key && key.startsWith(STORAGE_KEY_PREFIX) && key !== STORAGE_KEY) {
      staleKeys.push(key)
    }
  }
  for (const key of staleKeys) {
    window.localStorage.removeItem(key)
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = seedRows()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  pruneStorages()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 只按种子里登记过的模块整体取用：存储里多出来或被删掉的模块都不会混进概览。
    const merged = seedRows()
    for (const key of Object.keys(merged)) {
      if (Array.isArray(parsed[key])) {
        merged[key] = parsed[key]
      }
    }
    return merged
  } catch {
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
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(seedSnapshot.rows[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 运行期整体复位：所有模块一次性回到当前种子快照，
// 概览卡片与各模块清单读的是同一份存储，条数必然一致。
export function resetAllRows(): Record<string, EntryRow[]> {
  const rows = seedRows()
  cache = rows
  if (typeof window !== 'undefined' && window.localStorage) {
    pruneStorages()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
  }
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

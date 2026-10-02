import seedJson from './seed.json'
import type { EntryRow } from './types'

// 示例数据的唯一来源是 seed.json：scripts/seed.mjs 装载前会校验它，
// 构建快照（public/seed-snapshot.json）也由它生成，概览与各模块清单因此永远同源。
export const SEED_ROWS: Record<string, EntryRow[]> = seedJson

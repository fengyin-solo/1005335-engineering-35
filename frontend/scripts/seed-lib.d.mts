// seed-lib.mjs 的类型声明：vite.config.ts 直接引用它，需要让 vue-tsc 能解析。
export const FRONTEND_DIR: string
export const REPO_ROOT: string
export const SEED_SOURCE: string
export const SEED_DIR: string
export const MODULES_DIR: string
export const CHECKPOINT_FILE: string
export const SNAPSHOT_FILE: string
export const MANIFEST_FILE: string
export const LOG_FILE: string
export const SEED_VERSION_PREFIX: string

export class SeedError extends Error {}

export interface SeedManifest {
  version: string
  checksum: string
  source: string
  generatedAt: string
  moduleCount: number
  total: number
  pending: number
  abnormal: number
  modules: { key: string; count: number }[]
}

export function ensureDependencies(
  logger?: { info?: (message: string) => void; warn?: (message: string) => void },
  options?: { autoInstall?: boolean },
): { installed: boolean; missing: string[] }

export function ensureSnapshotSync(logger?: {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}): SeedManifest

export function runSeed(options?: {
  force?: boolean
  preflightOnly?: boolean
  autoInstall?: boolean
}): Promise<{ summary?: SeedManifest; skipped?: boolean }>

export function extractModuleKeys(modulesFile: string): string[]

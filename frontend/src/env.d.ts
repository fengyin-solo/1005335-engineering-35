/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_APP_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Vite 插件提供的种子虚拟模块：内容由 scripts/seed-cli.mjs 播种生成，
// 结构与浏览器 localStorage 里保存的键值形状保持一致。
declare module 'virtual:seed-data' {
  import type { EntryRow } from './data/types'

  const snapshot: {
    version: string
    checksum: string
    rows: Record<string, EntryRow[]>
  }
  export default snapshot
}

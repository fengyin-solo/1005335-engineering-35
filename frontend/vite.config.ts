import { statSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

import {
  LOG_FILE,
  SEED_SOURCE,
  SNAPSHOT_FILE,
  ensureSnapshotSync,
} from './scripts/seed-lib.mjs'

// 浏览器侧只允许通过虚拟模块读种子：CLI 播种产物与页面复位用的是同一份快照。
const VIRTUAL_ID = 'virtual:seed-data'
const RESOLVED_VIRTUAL_ID = '\0virtual:seed-data'

function seedPlugin(): Plugin {
  let snapshotMtime = 0

  function loadSnapshot() {
    // 快照缺失或种子更新时自动播种（内部带检查点，重复调用不会多出条目）。
    ensureSnapshotSync()
    snapshotMtime = statSync(SNAPSHOT_FILE).mtimeMs
    return readFileSync(SNAPSHOT_FILE, 'utf8')
  }

  return {
    name: 'local-seed-data',
    resolveId(id) {
      if (id === VIRTUAL_ID) {
        return RESOLVED_VIRTUAL_ID
      }
      return null
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) {
        return null
      }
      const snapshot = loadSnapshot()
      return `export default ${snapshot}`
    },
    configureServer(server) {
      // 权威种子变更：重新播种并让引用了虚拟模块的页面整页刷新。
      server.watcher.add(SEED_SOURCE)
      server.watcher.on('change', (changed) => {
        if (changed !== SEED_SOURCE) {
          return
        }
        try {
          ensureSnapshotSync()
          const updated = statSync(SNAPSHOT_FILE).mtimeMs
          if (updated === snapshotMtime) {
            return
          }
          const module = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID)
          if (module) {
            server.moduleGraph.invalidateModule(module)
          }
          server.ws.send({ type: 'full-reload', path: '*' })
        } catch (error) {
          server.config.logger.error(`重新播种失败，详见 ${LOG_FILE}: ${String(error)}`)
        }
      })
    },
  }
}

// 纯前端应用：没有后端，也就没有 /api 代理，数据全部走 src/api/local-service.ts。
export default defineConfig({
  plugins: [seedPlugin(), vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 关掉自动打开页面：起服务时只打印地址，不拉起浏览器
    open: false,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})

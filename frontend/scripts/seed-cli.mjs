#!/usr/bin/env node
/**
 * 播种 / 复位流程的命令行入口。
 *
 *   node scripts/seed-cli.mjs             依赖校验 + 播种（幂等，中断后再跑从断点继续）
 *   node scripts/seed-cli.mjs --force      忽略检查点全量重跑
 *   node scripts/seed-cli.mjs --preflight  只校验环境与依赖是否齐全，不写快照
 */
import { SeedError, runSeed } from './seed-lib.mjs'

const args = new Set(process.argv.slice(2))
const force = args.has('--force') || args.has('-f')
const preflightOnly = args.has('--preflight')

runSeed({ force, preflightOnly, autoInstall: !args.has('--no-install') })
  .then((result) => {
    if (result?.summary) {
      const { total, pending, abnormal, moduleCount, version } = result.summary
      process.stdout.write(
        `\n种子快照就绪：${version}\n模块 ${moduleCount} 个 · 登记总量 ${total} · 待处理 ${pending} · 异常量 ${abnormal}\n`,
      )
    } else if (result?.skipped) {
      process.stdout.write('\n依赖校验通过。\n')
    }
    process.exit(0)
  })
  .catch((error) => {
    if (error instanceof SeedError) {
      process.stderr.write(`\n播种失败：${error.message}\n`)
    } else {
      process.stderr.write(`\n播种失败：${error?.stack ?? error}\n`)
    }
    process.exit(1)
  })

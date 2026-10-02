# 考古发掘现场记录与出土物整理工作台

面向探方发掘进度、地层堆积编录、遗迹单位登记、出土物整理与检测送样的一体化田野考古记录工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── scripts/seed-cli.mjs  播种/复位 CLI：依赖校验 → 种子校验 → 原子装载 → 断点检查点
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、复位、导出
│   ├── src/data/             模块元数据 / localStorage 持久化
│   ├── .dev/seed/            播种产物（快照/分片/检查点/日志，已 gitignore，可随时重生）
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理，内置种子虚拟模块）
├── seed/seed-data.json       唯一权威种子（受版本管理，18 模块 / 54 条）
├── Makefile
└── docker-compose.yml
```

## 一条命令的本地开发流程

克隆到任意目录后，不需要手工清浏览器存储，也不用先记得装依赖：

```bash
make dev          # 等价于：校验依赖（缺失自动安装）→ 播种 → 起 dev server
```

单独执行各阶段：

```bash
make install      # npm install 后再跑一遍依赖校验
make seed         # 只播种（幂等；中断后再跑从断点继续）
make seed-force   # 忽略检查点，全量重新播种
make preflight    # 只校验 Node 版本与依赖是否齐全，不写快照
make build        # 类型检查 + 播种 + 生产构建
```

不用 make 时等价的 npm 命令（在 `frontend/` 下）：`npm install` → `npm run seed` → `npm run dev`。

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

### 播种流程做了什么

1. **装载前校验依赖**：检查 Node ≥ 18、`package.json` 存在、`vue/vue-router/pinia/vite` 能否解析，
   并实际执行一次 esbuild 转译确认平台原生包可用；缺失或损坏（含跨机器/跨平台拷贝了
   `node_modules` 的情况）会依次尝试 `npm install` → `--force` → 刷新 lockfile → 清空重装。
2. **校验种子**：`seed/seed-data.json` 必须与 `src/data/modules.ts` 里登记的 18 个模块一一对应，
   每条记录必须有唯一数字 `id`、合法 `status` 与布尔 `pending/abnormal`，否则拒绝播种。
3. **逐模块原子装载**：每个模块写一个分片（先写临时文件再 rename），写一个登记一个检查点；
   快照、清单（manifest）最后汇总生成。
4. **浏览器侧同源**：Vite 通过 `virtual:seed-data` 虚拟模块把快照喂给前端，运行期复位与 CLI
   播种用的是同一份数据，因此运营概览与各模块清单的条数必然一致。

### 幂等、断点与日志

- **反复装载不会多出条目**：重跑时检查点中且 checksum 一致的模块直接跳过；种子内容没变，结果不变。
- **中断恢复**：Ctrl-C / kill 后重新执行同一命令，已完成的步骤和模块不再重来，只补未完成部分。
  可设 `SEED_ABORT_AT=<步骤>`、`SEED_ABORT_AFTER=<N>` 人工制造中断，或设
  `SEED_MODULE_DELAY_MS=<毫秒>` 放慢装载速度，便于用真实 Ctrl-C 验证。
- **种子改版自动重播**：`seed-data.json` 内容一变 checksum 就变，CLI 与 dev server 都会自动按
  新种子重建；浏览器 localStorage 的键也带版本号（`archaeology-field:entries:seed-<checksum>`），
  旧版本和无版本号的历史键会被自动清掉，不会出现两套数据混存。
- **日志**：每一步（包括中断发生时正在执行的那一步）都追加在
  `frontend/.dev/seed/seed.log`。

### 运行期复位

- 运营概览页有「全部复位为种子数据」：一次把 18 个模块全部复位，概览卡片与各模块清单条数同步
  回到 54 / 36 / 18。
- 每个业务模块页有「复位本模块」：只把当前模块的清单条数复位，概览随后重算，对得上。
- 复位写入的还是同一个带版本的 localStorage 键，刷新、重开浏览器都保持复位结果。

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 探方登记 | `trench` | 探方 | 探方编号、所属发掘区、布方面积 |
| 地层堆积 | `stratum` | 地层堆积 | 层位编号、所属探方、土质 |
| 遗迹单位 | `feature` | 遗迹单位 | 单位编号、遗迹类型、所属探方 |
| 出土物登记 | `find` | 出土物 | 器物编号、出土探方、出土层位 |
| 陶片拼对 | `sherd` | 拼对记录 | 拼对编号、所属单位、陶系 |
| 骨骼标本 | `bone` | 骨骼标本 | 标本编号、出土单位、种属 |
| 浮选样品 | `flotation` | 浮选样品 | 样品编号、采样单位、样品重量 |
| 测年送检 | `dating` | 测年送检单 | 送检编号、样品来源、承接实验室 |
| 测绘控制点 | `survey` | 测绘控制点 | 点位编号、控制等级、北坐标 |
| 影像资料 | `photo` | 影像资料 | 影像编号、拍摄对象、拍摄方向 |
| 发掘日记 | `diary` | 发掘日记 | 日记编号、记录日期、记录人 |
| 用工派工 | `labor` | 出工记录 | 派工编号、作业区域、用工类别 |
| 工具领用 | `tool` | 工具领用单 | 领用单号、领用人、工具名称 |
| 安全巡查 | `safety` | 安全巡查记录 | 巡查编号、巡查区域、巡查类别 |
| 样品封装 | `packing` | 封装记录 | 封装编号、所属单位、封装材料 |
| 标本修复 | `conserve` | 修复单 | 修复单号、修复对象、病害描述 |
| 简报校核 | `briefing` | 发掘简报 | 简报编号、涉及探方、编写人 |
| 探方验收 | `acceptance` | 探方验收单 | 验收单号、验收探方、验收类别 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；**唯一权威种子**是
  `seed/seed-data.json`，模块或种子条目有改动后重跑 `make seed`（dev server 开着时会自动重播）。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：概览页「全部复位」、模块页「复位本模块」，或命令行 `make seed-force`；
  不再需要手工清浏览器存储。

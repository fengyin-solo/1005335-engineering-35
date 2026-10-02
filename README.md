# 考古发掘现场记录与出土物整理工作台

面向探方发掘进度、地层堆积编录、遗迹单位登记、出土物整理与检测送样的一体化田野考古记录工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

种子数据与「复位」已经做成一条本地开发流水线（`scripts/seed.mjs`）：依赖校验 → 种子装载 →
运行期快照 → 回读校验，支持断点续跑与中断日志；运营概览与各业务模块清单读同一份快照，两处条数
始终一致，复位后清单条数会跟着变，反复装载也不会多出条目。

## 一条命令跑起来

```bash
# 在仓库根目录：校验依赖（缺了/坏了会自动 npm install）→ 校验种子 → 分模块装载 → 生成运行期快照
make setup          # 等价于 cd frontend && npm run setup

# 然后启动开发服务（predev 钩子会再跑一遍装载：已完成的步骤秒跳过）
make frontend       # 等价于 cd frontend && npm run dev
```

不想用 make，直接用 npm 脚本也行（跨平台，Windows 也能跑）：

```bash
cd frontend
npm run setup       # npm install + 播种一条龙，克隆下来第一次跑它即可
npm run dev         # 启动前自动续跑播种流水线
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建（`prebuild` 钩子同样会先装载种子）：

```bash
make build          # 等价于 cd frontend && npm run build
```

### 播种 / 复位命令

| 命令 | 作用 |
| --- | --- |
| `make setup` / `npm run setup` | 依赖安装 + 种子校验与装载，新机器克隆后的入口 |
| `make seed` / `npm run seed` | 只跑播种流水线（依赖已装好时） |
| `make reset` / `npm run seed:reset` | 推进复位代号，浏览器下次打开/刷新时概览与全部清单统一回到种子 |
| 概览页「复位全部数据」按钮 | 运行期立即整库复位，所有模块清单条数当场回到种子状态 |

播种脚本的参数（直接用 node 调用时）：

- `node scripts/seed.mjs`：常规装载，依赖缺失会自动安装，已完成步骤直接跳过
- `--reset`：生成新的复位版本（epoch +1），驱动所有浏览器重新播种
- `--no-install`：只校验不安装，供 `npm run dev/build` 的钩子使用
- `--clean`：忽略断点从头重跑

### 断点续跑与日志

- 断点状态、分模块暂存与日志放在仓库根 `.dev/`（已在 `.gitignore` 中忽略）：
  - `seed-state.json`：每个步骤的完成/中断状态与输入校验码
  - `seed-staging/<模块>.json`：按模块装载的中间产物
  - `seed.log`：完整流水线日志，**中断在某一步时会把步骤名与信号记进日志**
- 跑到一半被 `Ctrl+C` / kill：已完成的步骤不会重来，下次运行从断在的那一步继续。
- `seed.json` 内容变化时，只有受影响（校验码变化）的模块步骤会重跑，其余跳过。
- 运行期快照产出在 `frontend/public/seed-snapshot.json`（生成物，已忽略，勿手工编辑）；
  唯一需要维护的种子来源是 `frontend/src/data/seed.json`。

### 装载前校验了什么

- Node >= 18、npm 可用、`node_modules` 关键依赖（vite/vue-tsc/rollup）**真的能加载**——
  能识别「在别的系统/架构上装好拷过来的原生依赖」这种目录在但不可用的情况并自动全量重装。
- 种子模块集合与 `modules.ts` 元数据完全一致；每条记录 id 唯一、状态在合法状态集内、
  字段齐全、业务编号不重复（重复编号会导致反复装载多出条目，装载前直接拦下）。
- 快照组装后回读逐模块比对，并核对「登记总量 / 待处理 / 异常量」汇总，保证概览与清单同源。

### 路径约定

脚本所有路径默认从自身位置推导（`scripts/../frontend`），不写死任何绝对路径。
容器等非标准布局可用环境变量覆盖：`SEED_FRONTEND_DIR`（前端目录）、`SEED_STATE_DIR`（状态目录）、
`SEED_REPO_ROOT`（仓库根）。


## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出、整库复位
│   ├── src/data/             模块元数据 / seed.json 种子 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   ├── public/seed-snapshot.json  播种流水线产出的运行期快照（生成物，已忽略）
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── scripts/seed.mjs          播种 / 复位流水线（依赖校验、装载、断点续跑、回读校验）
├── .dev/                     断点状态 / 暂存 / 日志（生成物，已忽略）
├── Makefile                  setup / seed / reset / frontend / build 入口
├── .gitignore
└── docker-compose.yml
```

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
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；**种子数据的唯一来源是
  `frontend/src/data/seed.json`**（`seed.ts` 只做再导出），运行期快照由 `scripts/seed.mjs` 生成。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 回到初始数据的正规方式：概览页「复位全部数据」按钮（运行期立即生效），或 `make reset`
  / `npm run seed:reset` 后刷新浏览器。清掉浏览器里 `archaeology-field:entries` 也可以，
  下次打开会按当前快照重新播种；`resetModule(模块)` 仍只复位单个模块。


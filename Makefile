.PHONY: setup seed reset frontend build

# 一条命令的本地开发初始化：依赖校验/安装 → 种子校验与装载（可断点续跑）。
# 路径全部相对本文件所在目录，仓库克隆到任何位置都能直接跑。
setup:
	cd frontend && npm run setup

# 只跑播种流水线（依赖已装好时用）；已完成的步骤会跳过
seed:
	cd frontend && npm run seed

# 推进复位代号：浏览器下次打开（或刷新）时，概览与全部模块清单统一回到种子数据
reset:
	cd frontend && npm run seed:reset

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

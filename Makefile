.PHONY: install seed seed-force setup dev frontend build preflight

# 一条命令的本地开发流程：装依赖（带装载前依赖校验）→ 播种 → 起 dev server
dev frontend: setup
	cd frontend && npm run dev

# 装依赖后再校验一遍是否齐全
install:
	cd frontend && npm install && npm run preflight

# 播种（幂等；中断后再跑从断点继续，已完成的模块不重来）
seed setup:
	cd frontend && npm run seed

# 忽略检查点，全量重新播种
seed-force:
	cd frontend && npm run seed:force

# 只校验环境与依赖是否齐全，不写种子快照
preflight:
	cd frontend && npm run preflight

build:
	cd frontend && npm run build

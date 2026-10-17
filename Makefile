# ForkPanel 前端门禁——一条命令跑完全部门禁。
#
# 背景：此前 6 个 UI 守卫 + 类型检查 + 构建 + 单测全靠人记得逐个跑，
# 没有任何东西把它们串起来（审计 P1-3）。本 Makefile 与
# .github/workflows/ci.yml 共用同一份目标，本地提交前与 CI 跑的是同一套。
#
# 一律走 node_modules/.bin 下的二进制，不依赖 npm/pnpm/yarn 哪一种包管理器。

.PHONY: check typecheck test build ui size

# 提交前 / CI 跑这个。
# 注意 build 自身已含 vue-tsc --noEmit，故不另跑 typecheck（省一次全量类型检查）；
# typecheck 保留为独立目标，供改动中快速单跑。
check: test build ui

typecheck:
	./node_modules/.bin/vue-tsc --noEmit

test:
	./node_modules/.bin/vitest run

build:
	./node_modules/.bin/vue-tsc --noEmit && ./node_modules/.bin/vite build

ui:
	node scripts/check-sidenav.mjs && \
	node scripts/check-page-head.mjs && \
	node scripts/check-modal.mjs && \
	node scripts/check-icon-names.mjs && \
	node scripts/check-overlay-teleport.mjs && \
	node scripts/check-subtitles.mjs

# 产物体积报告（不进 check：目前无阈值断言，仅观测用）
size:
	node scripts/size-report.mjs

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
# size 放在最后：它校验的是 build 的产物，必须等构建出来才有意义（审计 P2-2）。
check: test build ui size

typecheck:
	./node_modules/.bin/vue-tsc --noEmit

test:
	./node_modules/.bin/vitest run

build:
	./node_modules/.bin/vue-tsc --noEmit && ./node_modules/.bin/vite build && \
		node scripts/check-no-comments.mjs

ui:
	node scripts/check-sidenav.mjs && \
	node scripts/check-page-head.mjs && \
	node scripts/check-modal.mjs && \
	node scripts/check-icon-names.mjs && \
	node scripts/check-overlay-teleport.mjs && \
	node scripts/check-subtitles.mjs

# 产物体积门禁（审计 P2-2）：对照 ci/budgets.json 判首屏 / 全量 / 单 chunk 三项，
# 任一项超预算即 exit 1。此前这条目标只有报告、没有门禁，体积只能靠人眼看。
size:
	node scripts/size-report.mjs

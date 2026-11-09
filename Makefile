# ForkPanel 前端门禁——一条命令跑完全部门禁。
#
# 背景：此前 UI 守卫 + 类型检查 + 构建 + 单测全靠人记得逐个跑，
# 没有任何东西把它们串起来（审计 P1-3）。本 Makefile 与
# .github/workflows/ci.yml 共用同一份目标，本地提交前与 CI 跑的是同一套。
#
# 一律走 node_modules/.bin 下的二进制，不依赖 npm/pnpm/yarn 哪一种包管理器。

.PHONY: check typecheck test coverage contract build ui size

# 提交前 / CI 跑这个。
# 注意 build 自身已含 vue-tsc --noEmit，故不另跑 typecheck（省一次全量类型检查）；
# typecheck 保留为独立目标，供改动中快速单跑。
# size 放在最后：它校验的是 build 的产物，必须等构建出来才有意义（审计 P2-2）。
check: test contract build ui size

typecheck:
	./node_modules/.bin/vue-tsc --noEmit

test:
	./node_modules/.bin/vitest run

# 行覆盖率（报告 §3.9 / G10 的基线）。**刻意不进 `check`**：
#   ① 一次约 70s，是 `make check` 里最慢的一环，而它不产生通过/失败判据；
#   ② 基线一接就设阈值只会逼人抬阈值（见 ci/budgets.json 的同类取舍）。
# 口径与当前数字记录在后端仓 docs/coverage.md，改这里要同步那份文档。
coverage:
	./node_modules/.bin/vitest run --coverage

# 契约一致性（与后端 docs/api/openapi.yaml 对齐）：前端静态调用路径必须已在
# 契约声明、且不得绕过 api/client.ts 直接 fetch。
# ⚠ 报告 §3.9 P1：此前 `package.json` 有 `check:contract` 入口、脚本也自带
#   「扫到空集即失败」自检，但 `make check` 与本仓 .github/workflows/ci.yml
#   都不调用 ⇒ **孤儿守卫**：写好了、没人跑，而「守卫存在」很容易被当成
#   「守卫在跑」。挂进 check 后，本地与前端 CI 跑的是同一套。
contract:
	bash ci/check-contract.sh

build:
	./node_modules/.bin/vue-tsc --noEmit && ./node_modules/.bin/vite build && \
		node scripts/check-no-comments.mjs

# 清单只在 scripts/run-ui-guards.mjs 里维护一份：Makefile 与 package.json
# 都转发到它，避免"本地跑一套、CI 跑另一套"的静默缺口（守卫条数以该文件为准）。
ui:
	node scripts/run-ui-guards.mjs

# 产物体积门禁（审计 P2-2）：对照 ci/budgets.json 判三项，**两硬一软**——
#   首屏（硬，dist/index.html 实际引用的 js/css）/ 单 chunk（硬，raw 体积）超预算即 exit 1；
#   全量（软）过 420 只警告、过 460 才失败（贴近现状的硬门禁只会逼人抬额度，见 budgets.json 注释）。
# 缺预算键或解析不出首屏资源 ⇒ exit 2，不允许"没预算/没解析到"变成静默通过。
# 此前这条目标只有报告、没有门禁，体积只能靠人眼看。
size:
	node scripts/size-report.mjs

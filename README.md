# ForkPanel（叉叉面板）· 轻量 Linux 服务器管理面板 · 前端

**技术栈**：Vue 3 `<script setup>` + TypeScript + Vite 6 + Pinia + vue-router 4
**形态**：构建期产出 `dist/`（带内容哈希），由后端（`panel-backend`）编译期内嵌进单文件二进制，运行期零 Node 依赖。

---

## 本仓库职责（与后端彻底分离）

| 关注点 | 归属 |
|---|---|
| 界面与交互、能力矩阵驱动的菜单/按钮、SSE 消费、表单校验（前端侧） | **本仓库（前端）** |
| 业务逻辑、数据持久化、鉴权/RBAC/CSRF、OS 能力探测 | panel-backend（后端） |

> **通信边界**：本仓库**只**通过 `https://<host>/api/v1/*`（REST + SSE）与后端通信，
> 不持有任何后端实现代码。两端唯一的"接口契约"是后端产出的
> [`src/api/openapi.yaml`](src/api/openapi.yaml)（OpenAPI 3.1，后端事实源的副本）。

## 关键纪律（CI 门禁校验）

1. **禁止平台判断**：前端不得写 `if (isLinux)` / `navigator.platform` / `target_os`。
   一切平台差异读后端下发的 `capabilities` 位（见 `src/api/types.ts` 的 `CAP` 与 `unsupportedReason`）。
2. **禁止 `v-html`**：后端内容一律用文本插值，杜绝 XSS。
3. **统一 HTTP 客户端**：所有请求走 `src/api/client.ts`（自动附加 `X-CSRF-Token`、处理 401/CSRF 失效、错误码映射）。
   禁止绕过 client 直接 `fetch`（门禁 `ci/check-contract.sh` 校验）。
4. **能力矩阵驱动 UI**：能力位 `supported=false` 时，对应菜单/按钮置灰（tooltip 显示原因），而非渲染成 0 或假数据。

## 目录

```
index.html
package.json  vite.config.ts  tsconfig.json
src/
  main.ts            启动 + API 版本协商（与后端 /api/v1/version 比对）
  api/
    openapi.yaml     ★ 接口契约（来自后端 docs/api/openapi.yaml 的副本）
    client.ts        fetch 封装（CSRF / 401 / 错误码）
    types.ts         CapabilityMap / PlatformInfo / 错误码分段
  router/            路由（懒加载，requiresAuth 守卫）
  stores/            auth / system / ui / task（仅 3~4 个）
  components/        自研 ~15 个基础组件（Button/Table/Modal/Tabs/...）
  layouts/           MainLayout（侧边栏按能力矩阵渲染）
  views/             ~27 个页面（路由总览见下方「页面 / 路由」）
  styles/            原生 CSS + 设计 token（CSS 变量）
scripts/size-report.mjs   构建体积预算报告
ci/check-contract.sh      前端调用路径 ⊆ openapi.yaml 校验
```

## 开发

```bash
pnpm i          # 或 npm i
pnpm dev        # Vite dev server，/api 代理到后端 127.0.0.1:2083
pnpm build      # vue-tsc 类型检查 + vite build → dist/
pnpm size       # 体积预算报告（首屏 JS+CSS ≤150KB gzip）
```

## 页面 / 路由

登录后左侧菜单按 `capabilities` 渲染；下列为全部前端路由（≈27 个），标题来自 `route.meta.title`：

| 路由 | 标题 | 视图组件 |
|---|---|---|
| `/login` | 登录 | LoginView |
| `/` | 概览 | DashboardView |
| `/system` | 实时趋势 | SystemView（宿主 MonitorView） |
| `/system/pro` | 专业快照 | ProfessionalView |
| `/system/procs` | 进程管理 | ProcessesView |
| `/services/software` | 软件 | ServicesView |
| `/services/units` | 服务 | ServicesView |
| `/services/:unit` | 服务详情 | ServiceDetailView |
| `/sites` | 网站 | SitesView |
| `/apps` | 应用 | AppsView |
| `/waf` | WAF | WafView |
| `/certs` | 证书 | CertsView |
| `/files` | 文件 | FilesView |
| `/databases` | 数据库 | DatabasesView |
| `/containers` | 容器 | ContainersView |
| `/backups` | 备份 | BackupsView |
| `/firewall` | 防火墙规则 | FirewallView（宿主 SecurityCenterView） |
| `/firewall/baseline` | 安全基线 | SecurityView |
| `/cron` | 计划任务 | CronView（宿主 TaskCenterView） |
| `/cron/tasks` | 任务中心 | TasksView |
| `/logs` | 系统日志 | LogsView（宿主 LogCenterView） |
| `/logs/audit` | 审计日志 | AuditView |
| `/notifications` | 通知 | NotificationsView |
| `/terminal` | 终端 | TerminalView |
| `/assistant` | AI 助手 | AssistantView |
| `/settings` | 设置 | SettingsView |
| `/users` | 用户 | UsersView |

> 各路由截图见仓库外 `.workbuddy/tmp/screenshots/`（本地开发资产，不入库）。

## 契约同步规则

- 后端是契约**事实源**（`forkpanel-backend/docs/api/openapi.yaml`）。
- 后端改契约后，需把最新 `openapi.yaml` 同步到本仓库 `src/api/openapi.yaml`。
- 前端 `types.ts` 中的 TS 类型须与 openapi 的 schema 保持一致（手工同步；接入 openapi-typescript 后可自动生成）。

## 已知约束

- 构建验证：本环境已具备 Node ≥ 22 + pnpm，`pnpm i && pnpm build`（vue-tsc 类型检查 + vite build）可正常通过；提交前务必跑通。
- `pnpm dev` 依赖后端 `panel serve --bind 127.0.0.1:2083`（或 mock 实例 2085）提供 `/api/v1`；纯前端改动走 Vite HMR，无需重启后端。

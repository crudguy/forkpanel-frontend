import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 单测配置与 vite.config.ts **刻意分离**：构建配置（manualChunks / rust-embed
// 产物约束 / 代理）不该影响测试，测试也不必为了复用 alias 把整套 build 配置拖进来。
// 别名在此重复声明一份——它是唯一需要共享的东西。
export default defineConfig({
  // 只借 SFC 编译能力（`.vue` → 可 import 的组件），不引入任何构建产物约束。
  // `@vitejs/plugin-vue` 本来就是 devDependency（`vite build` 需要它），
  // 在测试侧启用不新增依赖。
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // 默认 node 环境：绝大多数用例是纯逻辑 / composable，快且不需要 DOM。
    // 需要真实 DOM 的组件用例在文件头单独声明 `// @vitest-environment jsdom`
    // （jsdom 已是 devDependency），只让那几个文件付环境开销。
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 不用 globals：显式 import，与项目「不靠魔法全局注入」的一贯偏好一致，
    // 也让 TS 无需额外引入 vitest/globals 类型。
    globals: false,
    // 行覆盖率基线（报告 §3.9 / G10）：`vitest run --coverage` 复现。
    // ⚠ `include` 必须显式钉住 src 全域。缺省时 v8 provider 只统计「被测试
    //   import 到的文件」，一个从未被任何测试引用的模块会**完全不进分母**——
    //   覆盖率因此虚高，而数字看起来还挺像回事（本项目「空集恒真」的同族）。
    //   反向也要小心：`include` 若写错成匹配不到任何文件，分母塌成 0、
    //   百分比回到 100%，必须靠「看不出文件数」这一点来识别。
    coverage: {
      provider: 'v8',
      // text-summary 给人看；json-summary 给脚本取 total（coverage/coverage-summary.json）
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.{ts,vue}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        // 测试基建：mount 辅助与 apiFake 只在测试里被用，计入分母没有意义
        'src/test/**',
        // 由 openapi.yaml 生成的契约类型，行数随接口增长，不代表手写复杂度
        // （与 ci/check-frontend-loc.sh 的豁免清单同一理由）
        'src/api/types.ts',
      ],
    },
  },
})

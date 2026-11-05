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
  },
})

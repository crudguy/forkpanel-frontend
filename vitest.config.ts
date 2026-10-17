import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// 单测配置与 vite.config.ts **刻意分离**：构建配置（manualChunks / rust-embed
// 产物约束 / 代理）不该影响测试，测试也不必为了复用 alias 把整套 build 配置拖进来。
// 别名在此重复声明一份——它是唯一需要共享的东西。
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // 现阶段只有纯逻辑 / composable 用例，无需 DOM。将来补组件测试时按文件加
    // `// @vitest-environment jsdom` 或改这里，不必现在就引入 jsdom 依赖。
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 不用 globals：显式 import，与项目「不靠魔法全局注入」的一贯偏好一致，
    // 也让 TS 无需额外引入 vitest/globals 类型。
    globals: false,
  },
})

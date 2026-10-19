import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 构建期产物会被 rust-embed 内嵌进二进制，因此：
//  1. 资源名必须带内容哈希（长期缓存 + ETag 由后端用内容哈希提供）
//  2. 不做 base 路径改写（面板总是从根路径提供服务）
//  3. 关闭 sourcemap 产出（单独归档用于排错，不进二进制）
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // 构建产物只保留代码：连 esbuild 默认保留的 `/*! */` / `@license` 法务注释也去掉。
  // 面板的 dist 会被 rust-embed 内嵌进二进制，产物里的注释纯属无谓体积；
  // 由 scripts/check-no-comments.mjs 在 build 末尾复核，防配置被改回。
  esbuild: { legalComments: 'none' },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    // 体积预算：首屏 JS+CSS ≤150KB gzip（CI 门禁）
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // xterm 只被懒加载的 TerminalView 引用：返回 undefined 走默认分包，
            // 跟随视图进懒加载 chunk。若打进 vendor，全站每个页面都会下载终端库。
            if (id.includes('@xterm')) return undefined
            if (id.includes('vue-router') || id.includes('pinia')) return 'vendor-vue'
            return 'vendor'
          }
        },
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]',
      },
    },
  },
  server: {
    // 开发期代理到 Rust 后端；生产由二进制内嵌提供，无 Node
    // ws:true 让 Vite 把 WebSocket 升级（/api/v1/terminal）也转发到后端；
    // changeOrigin 保持 false：浏览器带的是 localhost:5173 的 Origin/Host，
    // 后端同源校验需 Origin == scheme://Host 才放行，改 Host 会判跨站 403。
    proxy: { '/api': { target: 'http://127.0.0.1:2083', changeOrigin: false, ws: true } },
  },
})

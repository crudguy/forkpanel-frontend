<script setup lang="ts">
import { computed } from 'vue'
import { QR_QUIET_ZONE, qrMatrix, qrPath } from '@/utils/qrcode'

/**
 * otpauth URI 的二维码（纯本地生成，不发任何网络请求）。
 *
 * 为什么不调在线二维码服务：URI 里带 TOTP 共享密钥，发给第三方等于把
 * 二次验证的钥匙直接送人。编码器见 `@/utils/qrcode`。
 */
const props = withDefaults(defineProps<{ text: string; size?: number }>(), { size: 168 })

/**
 * 内容超出容量时返回 null 而不是让组件抛错：SecurityView 里还有密钥文本可抄，
 * 一个渲染失败不该把整个「启用 MFA」流程打断（Vue 渲染期抛错会冒到 ErrorBoundary）。
 */
const matrix = computed(() => {
  try {
    return qrMatrix(props.text)
  } catch {
    return null
  }
})

const path = computed(() => (matrix.value ? qrPath(matrix.value) : ''))
const box = computed(() => (matrix.value ? matrix.value.size + QR_QUIET_ZONE * 2 : 0))
</script>

<template>
  <svg
    v-if="matrix"
    class="qr"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${box} ${box}`"
    role="img"
    aria-label="两步验证二维码，可用验证器 App 扫码"
    shape-rendering="crispEdges"
  >
    <rect class="qr-bg" :width="box" :height="box" />
    <path class="qr-fg" :d="path" />
  </svg>
  <p v-else class="qr-overflow">内容超出二维码容量，请手动录入下面的密钥</p>
</template>

<style scoped>
/* 扫码图固定黑白（token 在两套主题同值）：反相二维码只有部分解码器认 */
.qr { display: block; border-radius: var(--radius-xs); }
.qr-bg { fill: var(--qr-bg); }
.qr-fg { fill: var(--qr-fg); }
.qr-overflow { margin: 0; font-size: var(--fs-12); color: var(--c-warn); }
</style>

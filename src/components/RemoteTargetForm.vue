<script setup lang="ts">
/**
 * 远端备份目标配置表单。
 *
 * 抽成独立组件是因为它出现在**两处**（新建计划、给已有计划补/改远端）。两处必须
 * 给出完全一致的字段与提示——复制一份必然漂移，而漂移的那份会让人按错误的字段名
 * 提交，然后收到一个看不懂的 400。
 *
 * 类型与空值构造器放在 `@/api/types`（`<script setup>` 不允许具名导出，
 * 而且它本来就是跨视图共享的定义）。
 *
 * 两条与后端严格对齐的约定：
 * 1. **凭据永不回显**（后端只回 `remote_has_secret`），所以凭据框永远是空的；
 *    空值语义 = "不改动"。要改就直接输新的；要改回匿名访问请清空用户名。
 * 2. 真正的注入 / SSRF / 凭据配对校验都在后端。**前端做安全判断等于没有安全判断**，
 *    这里只求少跑一趟 400。
 */
import type { RemoteConfig } from '@/api/types'

const props = defineProps<{
  modelValue: RemoteConfig
  disabled?: boolean
  /** 该计划是否**已存**凭据（只用来改提示文案；凭据值本身永远拿不到） */
  hasSecret?: boolean
  /** 并入宿主的 .row 表单行（display:contents）；「改远端」那处保持独立分区 */
  inline?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [RemoteConfig] }>()

function set<K extends keyof RemoteConfig>(k: K, v: RemoteConfig[K]) {
  emit('update:modelValue', { ...props.modelValue, [k]: v })
}
</script>

<template>
  <div class="remote" :class="{ inline }">
    <label>远端副本
      <select :value="modelValue.kind" :disabled="disabled"
        @change="set('kind', ($event.target as HTMLSelectElement).value as RemoteConfig['kind'])">
        <option value="">不使用（仅本地）</option>
        <option value="webdav">WebDAV</option>
        <option value="s3">S3 兼容对象存储</option>
      </select>
    </label>

    <template v-if="modelValue.kind">
      <label class="wide">
        {{ modelValue.kind === 's3' ? 'Endpoint' : '目标目录 URL' }}
        <input :value="modelValue.url" :disabled="disabled"
          :placeholder="modelValue.kind === 's3' ? 'https://s3.example.com' : 'https://dav.example.com/backups/'"
          @input="set('url', ($event.target as HTMLInputElement).value)" />
      </label>

      <template v-if="modelValue.kind === 's3'">
        <label>Bucket
          <input :value="modelValue.bucket" :disabled="disabled" placeholder="my-bucket"
            @input="set('bucket', ($event.target as HTMLInputElement).value)" />
        </label>
        <label>Key 前缀（可空）
          <input :value="modelValue.prefix" :disabled="disabled" placeholder="panel/prod"
            @input="set('prefix', ($event.target as HTMLInputElement).value)" />
        </label>
        <label>Region
          <input :value="modelValue.region" :disabled="disabled" placeholder="us-east-1"
            @input="set('region', ($event.target as HTMLInputElement).value)" />
        </label>
      </template>

      <label>{{ modelValue.kind === 's3' ? 'Access Key' : '用户名' }}（留空 = 匿名）
        <input :value="modelValue.user" :disabled="disabled" autocomplete="off"
          @input="set('user', ($event.target as HTMLInputElement).value)" />
      </label>

      <label>{{ modelValue.kind === 's3' ? 'Secret Key' : '密码' }}{{ hasSecret ? '（已保存）' : '' }}
        <input :value="modelValue.secret" :disabled="disabled || !modelValue.user" type="password"
          autocomplete="new-password"
          :placeholder="hasSecret ? '留空 = 沿用已保存的凭据' : '必填（匿名访问请清空用户名）'"
          @input="set('secret', ($event.target as HTMLInputElement).value)" />
      </label>
    </template>
  </div>
</template>

<style scoped>
/* 与 BackupsView 的 .row 保持同一套排布（label 纵向、自动换行），
   免得"新建"与"改远端"两处的表单长得不一样 */
.remote { display: flex; flex-wrap: wrap; gap: 10px 14px; margin-top: 10px; }
.remote label { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-12); color: var(--c-text-dim); }
.remote label.wide { flex: 1 1 280px; }
/* 字号与宿主 .row > label 对齐（12px），避免 select/input 行高不同显得高低不齐。
   高度由 main.css 的 .row 规则统一兜底。 */
/* 并入宿主 .row 时根盒子不生成，内部 label 直接成为表单行的 flex item，
   随父级 flex-wrap 自然折行，不再独占一行；「改远端」那处不加 inline，保持独立分区。
   ⚠ display:contents 只改渲染层，`.row > label` 的 flex 契约命中不到子 label，
   这里自己补齐；.wide（URL 字段）保留更宽的基值，不一起压成 140px。 */
.remote.inline { display: contents; }
/* 与全局 `.row > label`（flex:1 = 1 1 0%）同基值，避免内联字段比同行宽。
   .wide（URL 字段）保留更宽基值，不一起压成 140px。 */
.remote.inline label:not(.wide) { flex: 1; min-width: 140px; }
</style>

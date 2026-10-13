<script setup lang="ts">
/**
 * 只读 SQL 控制台。
 *
 * 定位：给人一个"看一眼库里到底有什么"的窗口，**不是**数据库客户端。因此：
 * 1. 只有只读语句能进来——后端两层校验（首关键词白名单 + 写关键词黑名单），
 *    并且 SQLite 的连接是以只读模式打开的（物理兜底）。前端这里只做
 *    "提示怎么写"，不做安全判断：安全判断在前端做等于没有。
 * 2. 默认只对 SQLite 开放。mysql/pg 的连接不是只读的，后端会诚实 501，
 *    前端如实展示原因，而不是把按钮藏起来假装没这个功能。
 */
import { ref } from 'vue'
import { api, errorText } from '@/api/client'
import { API } from '@/api/endpoints'
import Icon from '@/components/Icon.vue'
import { useModal } from '@/composables/useModal'

const props = defineProps<{ conn: { id: number; name: string; engine?: string | null } }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface QueryResp {
  columns: string[]
  rows: (string | null)[][]
  truncated: boolean
  limit: number
}

const sql = ref("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
const limit = ref(200)
const result = ref<QueryResp | null>(null)
const error = ref('')
const busy = ref(false)
const elapsed = ref(0)

const SAMPLES: { label: string; sql: string }[] = [
  { label: '表清单', sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" },
  { label: '表结构', sql: "SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name" },
  { label: '索引', sql: "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name" },
  { label: '库信息', sql: 'PRAGMA database_list' },
  { label: '完整性', sql: 'PRAGMA integrity_check' },
]

async function run() {
  if (!sql.value.trim() || busy.value) return
  busy.value = true
  error.value = ''
  const t0 = performance.now()
  try {
    result.value = await api.post<QueryResp>(API.db.query(props.conn.id), {
      sql: sql.value,
      limit: limit.value,
    })
  } catch (e) {
    error.value = errorText(e)
    result.value = null
  } finally {
    elapsed.value = Math.round(performance.now() - t0)
    busy.value = false
  }
}

function useSample(s: string) {
  sql.value = s
}

// Esc 关闭 + Tab 焦点陷阱 + 打开聚焦 + 关闭后焦点返还（此前本面板三者皆无）。
// 与回收站面板一样**没有 open prop**（父级 v-if 控制挂载）→ 传 () => true。
const box = ref<HTMLElement | null>(null)
const { close: modalClose } = useModal(() => true, box, () => emit('close'))
</script>

<template>
  <!-- 二级浮层（从数据库连接卡片里展开）→ .level-2；遮罩外观统一取公共 .mask -->
  <div class="mask level-2" @click.self="modalClose">
    <div ref="box" class="sql-panel">
      <div class="modal-head">
        <Icon name="database" :size="16" />
        <span class="modal-title">只读 SQL · {{ conn.name }}</span>
        <span class="badge">{{ conn.engine ?? 'sqlite' }}</span>
        <span class="spacer" />
        <!-- 关闭只留右上角 X（与全站弹窗一致） -->
        <button class="modal-close" type="button" aria-label="关闭" @click="modalClose">
          <Icon name="close" :size="16" />
        </button>
      </div>

      <div class="sp-samples">
        <button v-for="s in SAMPLES" :key="s.label" class="btn-ghost btn-sm" @click="useSample(s.sql)">{{ s.label }}</button>
        <span class="spacer" />
        <label class="lim">上限
          <input v-model.number="limit" type="number" min="1" max="2000" class="lim-input" />
          行
        </label>
      </div>

      <textarea
        v-model="sql"
        class="sp-sql"
        spellcheck="false"
        placeholder="只读语句：SELECT / WITH / EXPLAIN / PRAGMA / VALUES"
        @keydown.ctrl.enter="run"
        @keydown.meta.enter="run"
      />

      <div class="sp-actions">
        <button class="btn-primary btn-sm" :disabled="busy || !sql.trim()" @click="run">
          <Icon name="play" :size="13" /> {{ busy ? '执行中…' : '执行' }}
        </button>
        <span class="muted">Ctrl/⌘ + Enter 执行</span>
        <span class="spacer" />
        <span v-if="result" class="muted">{{ result.rows.length }} 行 · {{ elapsed }} ms</span>
      </div>

      <!-- 错误 / 截断提示统一用公共 .err-bar / .hint-note.is-warn
           （此前 .err 纯红字、.warn 无图标，与弹窗里的提示条两套长相） -->
      <p v-if="error" class="err-bar" role="alert">{{ error }}</p>

      <template v-if="result">
        <p v-if="result.truncated" class="hint-note is-warn">
          <Icon name="alert" :size="14" class="ic" />
          <span>已达返回上限 {{ result.limit }} 行，结果被截断（收窄 WHERE 或调大上限）</span>
        </p>
        <div v-if="result.columns.length" class="sp-scroll">
          <table>
            <thead>
              <tr><th v-for="(c, i) in result.columns" :key="i">{{ c }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, ri) in result.rows" :key="ri">
                <!-- 结果单元格是等宽 nowrap + ellipsis，长文本最容易被截断；
                     完整值一律挂 title，否则看不到具体内容（NULL 也保持可读） -->
                <td v-for="(v, ci) in r" :key="ci" :title="String(v ?? 'NULL')">
                  <span v-if="v === null" class="null">NULL</span>
                  <template v-else>{{ v }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else-if="!result.rows.length" class="muted">语句执行成功，无返回列（如 PRAGMA 的某些形式）</p>
        <p v-else class="muted">0 行</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩（.mask.level-2）与标题行 / 关闭按钮统一取 main.css；这里只留面板自身尺寸，
   并通过 --modal-py/--modal-px 告诉公共 .modal-head 本面板的内边距。 */
.sql-panel {
  --modal-py: 16px;
  --modal-px: 18px;
  width: min(920px, 100%); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--c-surface-2); border: 1px solid var(--c-border);
  border-radius: var(--radius-lg); padding: var(--modal-py) var(--modal-px);
}
.sp-samples .spacer, .sp-actions .spacer { flex: 1; }
.badge {
  font-size: var(--fs-12); padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--c-border); color: var(--c-text-mute);
}
.sp-samples { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 9px; }
.lim { font-size: 12px; color: var(--c-text-mute); display: flex; align-items: center; gap: 4px; }
.lim-input { width: 66px; padding: 3px 6px; font-size: 12px; }
.sp-sql {
  width: 100%; min-height: 118px; resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
  line-height: 1.5; padding: 9px 11px;
  background: var(--c-surface-2, rgba(255, 255, 255, .03));
  border: 1px solid var(--c-border); border-radius: 9px; color: var(--c-text);
}
.sp-actions { display: flex; align-items: center; gap: 8px; margin: 9px 0; }
.sp-actions .muted { font-size: 12px; color: var(--c-text-mute); }
.sp-scroll { overflow: auto; max-height: 46vh; border: 1px solid var(--c-border); border-radius: 9px; }
.sp-scroll table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.sp-scroll th, .sp-scroll td {
  text-align: left; padding: 5px 9px; border-bottom: 1px solid var(--c-border);
  white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis;
}
.sp-scroll th { position: sticky; top: 0; background: var(--c-surface-2, #22242a); font-weight: 600; }
.sp-scroll td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.null { color: var(--c-text-mute); font-style: italic; }
</style>

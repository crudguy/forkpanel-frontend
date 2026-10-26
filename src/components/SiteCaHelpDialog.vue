<script setup lang="ts">
/**
 * 「安装面板根证书」指引弹窗。
 *
 * 从 SiteFormDialog 搬出来的边界：**只讲一件事**——怎么把本地根 CA 装进信任库。
 * 它没有表单、没有请求、没有错误态，唯一的入参是「开没开」，唯一出参是「关」，
 * 唯一副作用是下载 ca.crt。——这类纯静态说明页留在 1600 行的站点表单里，只会让
 * 「改证书文案」这件事变成要在整张表单里定位。
 *
 * ⚠️ 遮罩用 `.mask.level-2`（z-index 60）：本浮层**永远**叠在「编辑站点」弹窗（50）
 *    之上，用默认的 `.mask` 会与主弹窗同级，谁在上面取决于 DOM 顺序（碰运气）。
 *    层级总表见 main.css。
 *
 * ⚠️ 它是**独立顶层浮层**：由宿主组件的 `v-if` 控制挂载，必须放在主弹窗
 *    `v-if="open"` 块**之外**，否则主弹窗一关它也跟着消失（而它自己并不依赖主弹窗
 *    任何字段——从「SSL 证书」区点开、关掉主弹窗后它本可以还开着，现在统一随主
 *    弹窗关闭，因为宿主只在编辑态才展示入口）。
 */
import { ref } from 'vue'
import { useModal } from '@/composables/useModal'
import { api } from '@/api/client'
import { API } from '@/api/endpoints'
import Icon from '@/components/Icon.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

/** 根证书安装指引弹窗。自签证书能被浏览器信任的**唯一**前提是把根 CA 装进信任库。 */
const box = ref<HTMLElement | null>(null)
// 统一关闭出口（Esc / 焦点陷阱 / 离场动画），与全站弹窗同规
const { close } = useModal(() => props.open, box, () => { emit('update:open', false) })

/**
 * 下载面板根证书（ca.crt）。
 *
 * 用 location 直下而非 fetch——与 FilesView 下载同范式：GET + cookie 认证即可，
 * 不需要（也不能）带 CSRF 头，响应流交给浏览器原生处理（自动落到下载目录）。
 */
function downloadCa() {
  window.location.href = API.certs.ca()
}
</script>

<template>
  <!-- 根证书安装指引：自签 leaf 由面板本地根 CA 签发，不把根装进信任库浏览器必然报不可信。
       这是「自签证书没法在本地用」的正解——不是换证书，而是装根。 -->
  <div v-if="open" class="mask level-2" @click.self="close">
    <div ref="box" class="modal wide" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 class="modal-title">安装面板根证书</h3>
        <button class="modal-close" type="button" aria-label="关闭" @click="close">
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p class="modal-lead">
        面板自签的站点证书，全部由<b>本机这一张根 CA</b> 签发。浏览器只信任「已装进信任库的根 CA」，
        所以直接访问会提示「不受信任 / 非私密连接」——这是证书链原理，不是面板坏了。
        <b>导入一次</b>即可：这张 CA 签发的全部本地站点（含以后新建的）都直接受信，无需再点「继续前往」。
      </p>
      <!-- 公共 .hint-note.is-warn（此前 .ca-warn 私有复刻了一版警告样式） -->
      <p class="hint-note is-warn">
        <Icon name="alert" :size="14" class="ic" />
        <span>根证书仅用于本机开发。<b>不要</b>把它装到不受你控制的机器上——装上等于信任该 CA 签发的任何证书。</span>
      </p>

      <div class="ca-actions">
        <button class="btn-primary" @click="downloadCa()"><Icon name="download" :size="14" /> 下载根证书（ca.crt）</button>
      </div>

      <div class="ca-steps">
        <div class="ca-step">
          <div class="ca-step-h">① 下载</div>
          <p class="dim">点上方按钮，浏览器会保存 <code>forkpanel-local-ca.crt</code>（PEM 格式的 X.509 证书）。</p>
        </div>
        <div class="ca-step">
          <div class="ca-step-h">② 装入信任库</div>
          <p class="dim"><b>Debian / Ubuntu 系统级</b>（curl、wget 与部分 Chromium 读系统库）：</p>
          <pre class="ca-code">sudo cp forkpanel-local-ca.crt /usr/local/share/ca-certificates/forkpanel-local-ca.crt
sudo update-ca-certificates</pre>
          <p class="dim"><b>Firefox</b> 用的是自带信任库，系统级导入对它无效：设置 → 隐私与安全 → 证书 →
            查看证书 → 证书颁发机构 → 导入，选中该文件并勾选<b>「信任由此 CA 标识的网站」</b>。</p>
          <p class="dim"><b>Chrome / Chromium</b>：设置 → 隐私和安全 → 安全 → 管理证书 →
            受信任的根证书颁发机构 → 导入（Linux 上通常装完系统级后重启浏览器即可）。</p>
        </div>
        <div class="ca-step">
          <div class="ca-step-h">③ 验证</div>
          <pre class="ca-code">curl --cacert forkpanel-local-ca.crt -I https://127.0.0.1</pre>
          <p class="dim">返回 <code>HTTP/2 200</code> 且无证书告警即导入成功。浏览器需<b>完全退出后重开</b>才会重读信任库。</p>
        </div>
      </div>

      <div class="modal-foot">
        <div class="modal-actions">
          <button class="btn-ghost" @click="close">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ⚠️ 这几个类原先住在 SiteFormDialog 的 scoped 样式里。scoped 只作用于**本组件渲染的**
   元素，搬到子组件后若不随模板一起带过来，样式就会静默失效（`vue-tsc` / build /
   单测全绿，只有真机看得见）——所以一律原样搬，不做「反正差不多」的合并。 */
.ca-actions { display: flex; gap: 10px; margin: 0 0 18px; }
.ca-steps { display: flex; flex-direction: column; gap: 14px; }
.ca-step-h { font-weight: 600; font-size: var(--fs-13); margin-bottom: 6px; color: var(--c-primary); }
.ca-step p { margin: 0 0 6px; font-size: var(--fs-12-5); line-height: 1.65; }
.ca-code { margin: 6px 0; padding: 9px 11px; border-radius: 8px; font-size: var(--fs-12); line-height: 1.6;
  overflow-x: auto; background: var(--c-bg); border: 1px solid var(--c-border); color: var(--c-text); }
</style>

<script setup lang="ts">
/**
 * 帮助中心。
 *
 * 定位：常驻的「查阅处」，不占首屏、不打断工作流（取代原概览页首启上手清单）。
 * 内容全部来自 `helpContent.ts`：模块说明与导航项同源，常用操作只指向真实页面，
 * 终端命令按运维流程分组，权限不足/环境不支持的入口在渲染前被过滤。
 *
 * 页内不写标题（顶栏标题取自 route.meta.title，见 check-page-head.mjs），
 * 也不再硬编码菜单标签/图标/命令文案——那几样各有单一事实源，
 * 在 .vue 里另写一份会静默漂移（构建与单测都不报错）。
 */
import { computed } from 'vue'
import PageLayout from '@/components/PageLayout.vue'
import Icon from '@/components/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { CLI_GLOBALS, CLI_GROUPS, FAQS, MODULE_DOCS, pickQuickTasks } from '@/composables/helpContent'
import { whyDisabledForPath } from '@/composables/navPolicy'

const auth = useAuthStore()

// 常用操作按「能力位 AND 权限点」过滤：只留下点得进去的入口。
const quick = computed(() => pickQuickTasks(auth.whyDisabled, (to) => whyDisabledForPath(auth, to)))
</script>

<template>
  <PageLayout>
    <p class="intro dim">
      这里汇总常用操作、模块说明、panel 终端命令与常见问题，可随时从侧边栏「帮助」回到本页。
    </p>

    <!-- 常用操作：新手最常问的「这件事到底在哪做」，直达对应页面 -->
    <section class="card">
      <div class="sec-head"><Icon name="bolt" :size="16" /> 常用操作</div>
      <p class="lead dim">只列出当前账号可以进入的入口，点开即可操作。</p>
      <div class="quick-grid">
        <RouterLink v-for="t in quick" :key="t.to" :to="t.to" class="quick">
          <Icon :name="t.icon" :size="18" class="quick-ico" />
          <span class="quick-txt">
            <span class="quick-title">{{ t.title }}</span>
            <span class="quick-desc">{{ t.desc }}</span>
          </span>
          <Icon name="chevron" :size="14" class="quick-go" />
        </RouterLink>
      </div>
      <p v-if="!quick.length" class="empty-inline empty-tip">
        当前账号没有可直接进入的常用模块，请从左侧菜单进入有权限的页面。
      </p>
    </section>

    <!-- 模块速览：标签/图标/顺序直接取自导航项，这里只补说明 -->
    <section class="card">
      <div class="sec-head"><Icon name="list" :size="16" /> 模块速览</div>
      <p class="lead dim">每项说明「能做什么、什么时候用、要注意什么」；灰色菜单可悬停查看不可用原因。</p>
      <div class="mod-grid">
        <div v-for="m in MODULE_DOCS" :key="m.to" class="mod">
          <Icon :name="m.icon" :size="18" class="mod-ico" />
          <span class="mod-txt">
            <span class="mod-label">{{ m.label }}</span>
            <span class="mod-desc">{{ m.desc }}</span>
          </span>
        </div>
      </div>
    </section>

    <!-- 终端命令：覆盖面板自身的安装、配置、备份、安全与公网运维 -->
    <section class="card">
      <div class="sec-head"><Icon name="terminal" :size="16" /> panel 终端命令</div>
      <p class="lead dim">
        以下命令在服务器终端执行；面板内置终端页与 SSH 权限等价。标 ⚠ 的操作会影响数据、
        密钥或整台服务器，先读完「注意」再执行。每条都写明用途、适用场景、关键参数、前置条件与异常提示。
      </p>
      <div class="cli-globals">
        <div v-for="g in CLI_GLOBALS" :key="g" class="cli-global">{{ g }}</div>
      </div>

      <div v-for="grp in CLI_GROUPS" :key="grp.title" class="cli-group">
        <div class="cli-group-title">{{ grp.title }}</div>
        <p class="cli-group-lead dim">{{ grp.lead }}</p>
        <div v-for="c in grp.commands" :key="c.cmd" class="cli-item" :class="{ risk: c.risk }">
          <div class="cli-cmd">
            <Icon v-if="c.risk" name="alert" :size="13" class="cli-risk-ico" />
            <code>{{ c.cmd }}</code>
          </div>
          <p class="cli-purpose">{{ c.purpose }}</p>
          <dl class="cli-meta">
            <div class="cli-row"><dt>场景</dt><dd>{{ c.when }}</dd></div>
            <div v-if="c.params.length" class="cli-row">
              <dt>参数</dt>
              <dd><span v-for="p in c.params" :key="p" class="cli-param">{{ p }}</span></dd>
            </div>
            <div class="cli-row"><dt>前置</dt><dd>{{ c.requires }}</dd></div>
            <div class="cli-row"><dt>注意</dt><dd>{{ c.caution }}</dd></div>
          </dl>
        </div>
      </div>
    </section>

    <!-- 常见问题：现象层问答，与上面的命令表分工 -->
    <section class="card">
      <div class="sec-head"><Icon name="help" :size="16" /> 常见问题</div>
      <div v-for="f in FAQS" :key="f.q" class="faq">
        <div class="faq-q"><Icon name="help" :size="14" class="faq-ico" />{{ f.q }}</div>
        <p class="faq-a dim">{{ f.a }}</p>
      </div>
    </section>
  </PageLayout>
</template>

<style scoped>
.intro { margin: 0 2px 16px; font-size: var(--fs-13); line-height: 1.7; }

/* 常用操作：整卡可点，右侧箭头提示「会跳走」 */
.quick-grid {
  display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
}
.quick {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 13px; border: 1px solid var(--c-border); border-radius: var(--radius-sm);
  background: var(--c-surface-2); color: inherit; text-decoration: none;
  transition: border-color .15s, background .15s;
}
.quick:hover { border-color: var(--c-primary); background: var(--c-surface); }
.quick:hover .quick-title { color: var(--c-primary); }
.quick-ico { color: var(--c-primary); margin-top: 1px; flex: none; }
.quick-txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.quick-title { font-weight: 600; font-size: var(--fs-13-5); }
.quick-desc { font-size: var(--fs-12-5); color: var(--c-text-dim); line-height: 1.55; }
.quick-go { color: var(--c-text-mute); margin-top: 2px; margin-left: auto; flex: none; }

/* 模块速览：响应式网格，每格 = 图标 + 标题 + 描述 */
.mod-grid {
  display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
}
.mod {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 11px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-sm);
  background: var(--c-surface-2);
}
.mod-ico { color: var(--c-primary); margin-top: 1px; flex: none; }
.mod-txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mod-label { font-weight: 600; font-size: var(--fs-13-5); }
.mod-desc { font-size: var(--fs-12-5); color: var(--c-text-dim); line-height: 1.5; }

.lead { margin: -6px 0 14px; font-size: var(--fs-12-5); line-height: 1.6; }
.empty-tip { margin: 10px 0 0; }

/* 终端命令：全局参数 → 分组 → 单条命令（用途 + 场景/参数/前置/注意） */
.cli-globals {
  display: flex; flex-direction: column; gap: 5px;
  padding: 10px 12px; margin-bottom: 18px;
  border: 1px solid var(--c-border); border-radius: var(--radius-sm);
  background: var(--c-surface-2);
}
.cli-global { font-size: var(--fs-12-5); line-height: 1.6; color: var(--c-text-dim); }

.cli-group { margin-top: 18px; }
.cli-group:first-of-type { margin-top: 0; }
.cli-group-title {
  font-weight: 600; font-size: var(--fs-13-5); color: var(--c-text);
  padding-bottom: 6px; border-bottom: 1px solid var(--c-border);
}
.cli-group-lead { margin: 6px 0 10px; font-size: var(--fs-12-5); line-height: 1.6; }

.cli-item {
  padding: 11px 12px; margin-bottom: 9px;
  border: 1px solid var(--c-border); border-left: 3px solid var(--c-border);
  border-radius: var(--radius-sm); background: var(--c-surface-2);
}
.cli-item.risk { border-left-color: var(--c-danger); }
.cli-cmd { display: flex; align-items: flex-start; gap: 6px; }
.cli-risk-ico { color: var(--c-danger); margin-top: 2px; flex: none; }
.cli-cmd code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--fs-12-5); color: var(--c-text);
  white-space: pre-wrap; word-break: break-word;
}
.cli-purpose { margin: 6px 0 8px; font-size: var(--fs-12-5); line-height: 1.65; color: var(--c-text); }
.cli-meta { margin: 0; display: flex; flex-direction: column; gap: 5px; }
.cli-row { display: flex; align-items: flex-start; gap: 8px; }
.cli-row dt {
  flex: 0 0 30px; margin: 0; font-size: var(--fs-12); color: var(--c-text-mute);
}
.cli-row dd {
  flex: 1; min-width: 0; margin: 0;
  font-size: var(--fs-12-5); line-height: 1.6; color: var(--c-text-dim);
}
.cli-param { display: block; }
.cli-row:last-child dd { color: var(--c-text); }

.faq { padding: 12px 0; border-top: 1px solid var(--c-border); }
.faq:first-of-type { border-top: none; padding-top: 2px; }
.faq-q { display: flex; align-items: flex-start; gap: 7px; font-weight: 600; font-size: var(--fs-13-5); margin-bottom: 6px; }
.faq-ico { color: var(--c-primary); margin-top: 2px; flex: none; }
.faq-a { margin: 0; font-size: var(--fs-13); line-height: 1.7; }
</style>

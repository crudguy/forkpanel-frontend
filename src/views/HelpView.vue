<script setup lang="ts">
/**
 * 帮助中心。
 *
 * 定位：常驻的「查阅处」，不占首屏、不打断工作流（取代原概览页首启上手清单）。
 * 内容全部来自 `helpContent.ts`：模块说明与导航项同源，常用操作只指向真实页面，
 * 权限不足/环境不支持的入口在渲染前被过滤，不摆点不动的按钮。
 *
 * 页内不写标题（顶栏标题取自 route.meta.title，见 check-page-head.mjs），
 * 也不再硬编码菜单标签/图标——那两样在 navItems.ts 里是单一事实源。
 */
import { computed } from 'vue'
import PageLayout from '@/components/PageLayout.vue'
import Icon from '@/components/Icon.vue'
import { useAuthStore } from '@/stores/auth'
import { FAQS, MODULE_DOCS, pickQuickTasks } from '@/composables/helpContent'

const auth = useAuthStore()

// 常用操作按「能力位 AND 权限点」过滤：只留下点得进去的入口。
const quick = computed(() => pickQuickTasks(auth.whyDisabled))
</script>

<template>
  <PageLayout>
    <p class="intro dim">
      欢迎使用 ForkPanel。这里汇总常用操作、模块说明与排障提示；侧边栏底部「帮助」可随时回到本页。
    </p>

    <!-- 常用操作：新手最常问的「这件事在哪做」，直达对应页面 -->
    <section class="card">
      <div class="sec-head"><Icon name="bolt" :size="16" /> 常用操作</div>
      <p class="lead dim">按当前账号权限列出可直接进入的入口；未列出的模块要么没有对应权限，要么这台机器暂不支持。</p>
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
      <p v-if="!quick.length" class="dim empty-tip">
        当前账号没有可直接进入的常用模块，请从左侧菜单进入有权限的页面。
      </p>
    </section>

    <!-- 模块速览：标签/图标/顺序直接取自导航项，这里只补一句说明 -->
    <section class="card">
      <div class="sec-head"><Icon name="list" :size="16" /> 模块速览</div>
      <p class="lead dim">侧边栏各模块的一句说明；灰着的菜单把鼠标悬停上去，会显示具体原因。</p>
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

    <!-- 快捷键：与 layouts/MainLayout.vue 的实际监听保持一致 -->
    <section class="card">
      <div class="sec-head"><Icon name="key" :size="16" /> 快捷键</div>
      <ul class="kbd-list">
        <li>
          <kbd>⌘ K</kbd><span class="kbd-or">/</span><kbd>Ctrl K</kbd>
          <span class="dim">打开命令面板，搜索并跳转任意页面</span>
        </li>
        <li>
          <kbd>Esc</kbd>
          <span class="dim">关闭弹层、抽屉或命令面板</span>
        </li>
      </ul>
    </section>

    <!-- 账户与安全 -->
    <section class="card">
      <div class="sec-head"><Icon name="shield" :size="16" /> 账户与安全</div>
      <ul class="faq-list">
        <li>面板采用<strong>基于角色的访问控制（RBAC）</strong>：不同角色看到的菜单与可执行的操作用权限点区分，遵循最小权限原则。</li>
        <li>修改登录密码在「设置」页完成；建议为每位管理员分配独立账户，而不是共用一个账号。</li>
        <li>登录会话与操作审计可被管理员查看，请妥善保管自己的账户。</li>
      </ul>
    </section>

    <!-- 备份与恢复 -->
    <section class="card">
      <div class="sec-head"><Icon name="archive" :size="16" /> 备份与恢复</div>
      <ul class="faq-list">
        <li>面板内置备份（SQLite 在线备份 + tar 打包），建议<strong>定期建立备份计划</strong>，而不是等出事再补救。</li>
        <li>修改关键配置（站点、防火墙、计划任务）前，可先手动执行一次备份，便于回滚。</li>
        <li>从产物恢复会覆盖现有数据，需要手输确认词；<strong>面板自身的库</strong>不能在线恢复，须停服后在服务器上用命令行处理。</li>
      </ul>
    </section>

    <!-- 安全提示：与风险横幅同级的高危提醒，常驻可见 -->
    <section class="card risk">
      <div class="sec-head"><Icon name="alert" :size="16" /> 安全提示</div>
      <ul class="faq-list">
        <li><strong>终端是高危操作面</strong>：直接执行系统命令，误操作可能影响整台服务器。请确认命令无误，优先使用对应功能模块而不是手敲命令。</li>
        <li><strong>公网访问会向外部开放服务</strong>：开启前务必确认防火墙白名单与 TLS 已配置，避免把管理端口直接暴露到公网。</li>
        <li><strong>防火墙规则变更可能影响现有连接</strong>：修改入站 / 出站规则时谨慎，避免把自己挡在服务器之外。</li>
        <li>遵循最小权限：仅在需要时授予管理类权限，日常巡检使用只读角色即可。</li>
      </ul>
    </section>

    <!-- 常见问题 -->
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
  padding: 12px 13px; border: 1px solid var(--c-border); border-radius: 10px;
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
  padding: 11px 12px; border: 1px solid var(--c-border); border-radius: 10px;
  background: var(--c-surface-2);
}
.mod-ico { color: var(--c-primary); margin-top: 1px; flex: none; }
.mod-txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mod-label { font-weight: 600; font-size: var(--fs-13-5); }
.mod-desc { font-size: var(--fs-12-5); color: var(--c-text-dim); line-height: 1.5; }

.lead { margin: -6px 0 14px; font-size: var(--fs-12-5); line-height: 1.6; }
.empty-tip { margin: 10px 0 0; font-size: var(--fs-13); }

.kbd-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.kbd-list li { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13-5); flex-wrap: wrap; }
kbd {
  font-family: var(--mono); font-size: var(--fs-12);
  background: var(--c-surface-2); border: 1px solid var(--c-border);
  border-bottom-width: 2px; border-radius: 6px; padding: 2px 8px; color: var(--c-text);
}
.kbd-or { color: var(--c-text-mute); }
.kbd-list .dim { font-size: var(--fs-12-5); }

.faq-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 9px; }
.faq-list li { font-size: var(--fs-13); line-height: 1.65; color: var(--c-text); }
.faq-list strong { color: var(--c-text); font-weight: 600; }

/* 安全提示卡片：用危险色描边与图标提亮，与常驻风险横幅同级提醒强度 */
.risk { border-color: color-mix(in srgb, var(--c-danger) 35%, var(--c-border)); }
.risk .sec-head { color: var(--c-danger); }
.risk .sec-head .icon { color: var(--c-danger); }

.faq { padding: 12px 0; border-top: 1px solid var(--c-border); }
.faq:first-of-type { border-top: none; padding-top: 2px; }
.faq-q { display: flex; align-items: flex-start; gap: 7px; font-weight: 600; font-size: var(--fs-13-5); margin-bottom: 6px; }
.faq-ico { color: var(--c-primary); margin-top: 2px; flex: none; }
.faq-a { margin: 0; font-size: var(--fs-13); line-height: 1.7; }
</style>

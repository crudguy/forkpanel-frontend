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
      这里汇总常用操作、模块说明与常见问题，可随时从侧边栏「帮助」回到本页。
    </p>

    <!-- 常用操作：新手最常问的「这件事在哪做」，直达对应页面 -->
    <section class="card">
      <div class="sec-head"><Icon name="bolt" :size="16" /> 常用操作</div>
      <p class="lead dim">只列出当前账号可以进入的入口。</p>
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
      <p class="lead dim">把鼠标悬停在灰色菜单上，可查看不可用原因。</p>
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

    <!-- 账户与安全 -->
    <section class="card">
      <div class="sec-head"><Icon name="shield" :size="16" /> 账户与安全</div>
      <ul class="faq-list">
        <li>面板按角色分配权限，不同角色看到的菜单和可做的操作不同。</li>
        <li>在「设置」页修改登录密码；建议每位管理员使用独立账号。</li>
        <li>请妥善保管账号，操作记录可供管理员查看。</li>
      </ul>
    </section>

    <!-- 备份与恢复 -->
    <section class="card">
      <div class="sec-head"><Icon name="archive" :size="16" /> 备份与恢复</div>
      <ul class="faq-list">
        <li>建议<strong>定期建立备份计划</strong>，不要等出问题再补救。</li>
        <li>修改站点、防火墙等重要配置前，可先手动备份以便回滚。</li>
        <li>恢复备份会覆盖现有数据，需输入确认词；面板自身的数据需在服务器上恢复。</li>
      </ul>
    </section>

    <!-- 安全提示：与风险横幅同级的高危提醒，常驻可见 -->
    <section class="card risk">
      <div class="sec-head"><Icon name="alert" :size="16" /> 安全提示</div>
      <ul class="faq-list">
        <li><strong>终端可直接执行系统命令</strong>，误操作可能影响整台服务器，请优先使用对应功能页面。</li>
        <li>开放公网访问前，请确认访问白名单与 HTTPS 已配置，避免暴露管理端口。</li>
        <li>修改防火墙规则要谨慎，避免阻断自己的连接。</li>
        <li>按需授予管理权限，日常巡检使用只读账号即可。</li>
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
.empty-tip { margin: 10px 0 0; font-size: var(--fs-13); }

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

<script setup lang="ts">
import SideNav from '@/components/SideNav.vue'
import TaskDrawer from '@/components/TaskDrawer.vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
</script>

<template>
  <div class="shell">
    <SideNav />
    <main>
      <div class="topbar">
        <span class="spacer" />
        <span v-if="auth.me" class="user">{{ auth.me.user }}（{{ auth.me.role }}）</span>
        <button v-if="auth.loggedIn" @click="auth.logout()">退出</button>
      </div>
      <div class="content">
        <RouterView />
      </div>
    </main>
    <TaskDrawer />
  </div>
</template>

<style scoped>
.shell { display: flex; min-height: 100vh; }
main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar { display: flex; align-items: center; gap: 12px; padding: 10px 20px;
          border-bottom: 1px solid var(--c-border); }
.spacer { flex: 1; }
.user { font-size: 13px; color: var(--c-text-dim); }
.content { padding: 20px; flex: 1; }
</style>

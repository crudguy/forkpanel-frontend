<script setup lang="ts">
/**
 * 轻量内联 SVG 图标集（线性风格，currentColor 着色）。
 * 不引入图标库以保首屏体积预算；新增图标在 ICONS 里追加 path 即可。
 */
defineProps<{ name: string; size?: number }>()

const ICONS: Record<string, string> = {
  dashboard: '<rect x="3" y="3" width="7.5" height="9" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5" rx="1.6"/><rect x="13.5" y="11" width="7.5" height="10" rx="1.6"/><rect x="3" y="15" width="7.5" height="6" rx="1.6"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="16.5" x2="7.01" y2="16.5"/>',
  process: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M8.2 6.6c3 .8 4 2.8 7.2 4.6M8.2 17.4c3-.8 4-2.8 7.2-4.6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M5 19l2.1-2.1M16.9 7.1 19 5"/>',
  docker: '<rect x="5" y="4.2" width="2.4" height="2.4" rx=".4"/><rect x="8.1" y="4.2" width="2.4" height="2.4" rx=".4"/><rect x="11.2" y="4.2" width="2.4" height="2.4" rx=".4"/><rect x="6.6" y="6.9" width="2.4" height="2.4" rx=".4"/><rect x="9.7" y="6.9" width="2.4" height="2.4" rx=".4"/><path d="M3 11.6c0-1.6 1.2-2.9 2.8-3h8.4c1.5 0 2.8.9 3.4 2.3.4 1 .2 2.1-.5 2.9-1.4 1.9-3.8 2.8-6.4 2.8H6.4C4.4 16.6 3 14.9 3 13z"/><path d="M20.6 13.6c.6-.4 1-.9 1-1.5"/>',
  fork: '<circle cx="6" cy="6" r="2.4" fill="currentColor" stroke="none"/><circle cx="18" cy="6" r="2.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="2.4" fill="currentColor" stroke="none"/><path d="M12 15.6V11c-2 .2-4-.2-6-2.6M12 15.6V11c2 .2 4-.2 6-2.6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9z"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  firewall: '<path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6z"/><path d="M9 11h6M9 14.5h6"/>',
  shield: '<path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.6 6h.01M3.6 12h.01M3.6 18h.01"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6L19 15z"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.4a3 3 0 0 1 0 5.4M17 14a5.5 5.5 0 0 1 3.5 5"/>',
  audit: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
  moon: '<path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10z"/>',
  logout: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M16 17l5-5-5-5M21 12H9"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-4M4 5v3h3M4 13a8 8 0 0 0 14 4M20 19v-3h-3"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  key: '<circle cx="8" cy="8" r="4"/><path d="M11 11l8 8M16 16l2-2M19 19l2-2"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  disk: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18M8 4v5h4"/>',
  network: '<circle cx="12" cy="12" r="2.4"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M6.5 6.5 9.6 9.6M17.5 6.5l-3.1 3.1M6.5 17.5l3.1-3.1M17.5 17.5l-3.1-3.1"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  edit: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 5l3 3"/>',
  'user-plus': '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M18 8v6M15 11h6"/>',
  check: '<path d="M5 12l4.5 4.5L19 7"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7 14l3-4 3 2 4-6"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 14l4-4"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
}
</script>

<template>
  <svg
    class="icon"
    :width="size || 20"
    :height="size || 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    v-html="ICONS[name] || ''"
  />
</template>

<style scoped>
.icon { display: inline-block; vertical-align: middle; flex: none; }
</style>

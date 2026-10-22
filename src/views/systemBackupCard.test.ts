/**
 * 系统自动备份卡的**实际值纪律**守卫（源码级）。
 *
 * 为什么需要它：卡片原本写死一句「保留份数由 config.toml [db] backup_keep 控制」——
 * 看起来诚实，其实什么都没说：用户在自己机器上把 `backup_keep` 改成 3 或 30，
 * 页面永远显示同一句话。这类"说了配置名却不说值"的文案最容易骗过评审：
 * 字面上都对，信息量为零。
 *
 * 修法是后端把**进程里实际生效**的值回出来（`/backups/system` 的 `keep` /
 * `daily_backup`），前端只负责显示。于是两端各有一段必须钉住：
 * - 后端：`system_endpoint_reports_effective_keep_and_switch`（值来自 AppState，不是常量）
 * - 前端：本文件——卡片必须读 `r.keep` 并显示，且不得退回写死文案。
 *
 * 三层各自守住一段：任一层单独失效（后端不回字段 / 前端写死 / 类型里没有该字段）
 * 都不会静默通过。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

// 测试文件位于 src/views/，故 '..' 即 src/
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8')

/** 剥掉注释行：注释里合法地会出现 `backup_keep` 等字样，不剥就会把
 *  「注释在讲这件事」误判成「代码真这么写了」——恒绿陷阱的经典形态。 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l))
    .join('\n')
}

describe('系统自动备份卡：显示实际生效值', () => {
  const view = stripComments(read('views/BackupsView.vue'))

  it('卡头渲染的是后端下发的实际保留份数', () => {
    expect(view).toContain('{{ sysKeep }}')
    expect(view).toContain('sysKeep.value = r.keep')
  })

  it('不得退回「只提配置名、不显示值」的写死文案', () => {
    expect(view).not.toContain('保留份数由 config.toml [db] backup_keep 控制')
  })

  it('区分「每日备份已关闭」与「还没生成」', () => {
    // 两者处置完全不同：关了要提醒用户没有自动兜底，没生成只需等待
    expect(view).toContain('sysDailyOn.value = r.daily_backup')
    expect(view).toContain('每日自动备份已关闭')
  })

  it('类型里必须带 keep / daily_backup（否则前端只能自己编一个默认值）', () => {
    const t = stripComments(read('api/types.ts'))
    expect(t).toMatch(/interface SystemBackupsResp[\s\S]*?keep: number/)
    expect(t).toMatch(/interface SystemBackupsResp[\s\S]*?daily_backup: boolean/)
  })
})

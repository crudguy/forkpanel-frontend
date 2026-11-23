// @vitest-environment jsdom
// 计划任务「新建」的字段完整性 + 前置校验。
//
// 背景：后端 `CreateReq` 收 8 个字段，而新建卡片此前只发 name/expr/user/command，
// 于是新建出来的任务一律「默认启用、超时 30 分钟、无 Webhook」，想改只能先建再编辑。
// 这里断言的是**实际 POST 出去的 body**，而不是源码里有没有出现字段名——
// 后者在类型声明、注释、表单 v-model 里都能命中，属于恒绿写法。
import { describe, it, expect } from 'vitest'
import CronView from './CronView.vue'
import { API } from '@/api/endpoints'
import { mountView, capsAllOk } from '@/test/mount'

const PERMS = ['cron.view', 'cron.manage', 'system.view']

function job(over: Record<string, unknown> = {}) {
  return {
    id: 'backup-db', expr: '0 3 * * *', command: '/usr/local/bin/backup.sh',
    user: 'root', enabled: true, timeout_sec: 1800,
    last_run_at: null, last_status: null, next: [], ...over,
  }
}

/**
 * 按标签文字定位输入框。
 *
 * ⚠ 本页有两种结构：`.row > label`（文字与 input 同在 label 内）与
 *   `.field > label + input`（兄弟节点）。只写 `label.querySelector('input')`
 *   在「命令」上会取到 null——这也是为什么选择器要兼容两种。
 */
function inputByLabel(host: HTMLElement, label: string): HTMLInputElement | null {
  for (const el of Array.from(host.querySelectorAll('label'))) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim()
    if (!own.startsWith(label)) continue
    const inside = el.querySelector('input')
    if (inside) return inside as HTMLInputElement
    // 兄弟结构：label 紧邻的下一个 input
    let sib = el.nextElementSibling
    while (sib && sib.tagName !== 'INPUT') sib = sib.nextElementSibling
    if (sib) return sib as HTMLInputElement
  }
  return null
}

async function fillForm(m: { host: HTMLElement }) {
  const set = (label: string, v: string) => {
    const input = inputByLabel(m.host, label)
    expect(input, `找不到「${label}」输入框`).toBeTruthy()
    input!.value = v
    input!.dispatchEvent(new Event('input'))
  }
  set('名称', 'backup-db')
  set('表达式', '0 3 * * *')
  set('命令', '/usr/local/bin/backup.sh')
}

function postBody(m: { fake: { calls: { url: string; method: string; body: unknown }[] } }) {
  return m.fake.calls.find((c) => c.method === 'POST' && c.url.includes('/api/v1/cron/jobs'))?.body
}

describe('计划任务 · 新建表单字段完整性', () => {
  it('POST 出去的面包含 timeout_sec / enabled / webhook_url（与编辑弹窗对齐）', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [] },
    })
    await fillForm(m)

    const btn = Array.from(m.host.querySelectorAll('button')).find((b) => b.textContent?.trim() === '创建')
    expect(btn, '找不到「创建」按钮').toBeTruthy()
    btn!.click()
    await m.flush()

    const body = postBody(m) as Record<string, unknown>
    expect(body, '没有发出 POST /cron/jobs').toBeTruthy()
    expect(body.name).toBe('backup-db')
    expect(body.expr).toBe('0 3 * * *')
    expect(body.command).toBe('/usr/local/bin/backup.sh')
    // 这三项是本次补齐的：缺任意一项，新建出来的任务就只能去编辑页补配置
    expect(body).toHaveProperty('timeout_sec')
    expect(body.timeout_sec).toBe(1800)
    expect(body).toHaveProperty('enabled')
    expect(body.enabled).toBe(true)
    expect(body).toHaveProperty('webhook_url')
    m.fake.assertClean(); m.cleanup()
  })

  it('名称含空格/中文：前端先拦，一个请求都不发（不是等后端 400）', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [] },
    })
    await fillForm(m)
    // 覆盖成非法名称
    const input = inputByLabel(m.host, '名称')!
    input.value = '备份 数据库'
    input.dispatchEvent(new Event('input'))
    await m.flush()

    // 提示在用户输入后就出现，不必等到点创建
    expect(m.host.textContent).toContain('只允许字母、数字、下划线与连字符')

    const btn = Array.from(m.host.querySelectorAll('button')).find((b) => b.textContent?.trim() === '创建')
    btn!.click()
    await m.flush()
    expect(postBody(m), '非法名称不该发出创建请求').toBeUndefined()
    m.fake.assertClean(); m.cleanup()
  })
})

describe('计划任务 · 列表信息组织', () => {
  it('「上次执行」显示成败徽标（ok / exit N）', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: {
        [API.cron.jobs()]: [
          job({ id: 'a-ok', last_run_at: 1700000000, last_status: 'ok' }),
          job({ id: 'b-fail', last_run_at: 1700000001, last_status: 'exit 127' }),
        ],
      },
    })
    const badges = Array.from(m.host.querySelectorAll('.last-status')).map((e) => ({
      text: e.textContent?.trim(),
      cls: e.className,
    }))
    expect(badges.length).toBe(2)
    expect(badges[0].text).toBe('ok')
    expect(badges[0].cls).toContain('badge-ok')
    expect(badges[1].text).toBe('exit 127')
    expect(badges[1].cls, '失败必须红色，不能落到 badge-warn 的黄').toContain('badge-danger')
    m.fake.assertClean(); m.cleanup()
  })

  it('从未执行过的任务不显示空徽标', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [job({ last_run_at: null, last_status: null })] },
    })
    expect(m.host.querySelectorAll('.last-status').length).toBe(0)
    m.fake.assertClean(); m.cleanup()
  })
})

describe('计划任务 · 执行后跳转任务中心是可点的链接', () => {
  it('提交执行后出现带 ?task=id 的 RouterLink，而不是纯文本提示', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: {
        [API.cron.jobs()]: [job()],
        [API.cron.run('backup-db')]: { task_id: 42, created: true },
      },
    })
    // ⚠ 必须精确比对「执行」：`includes('执行')` 会先命中「预览执行时刻」，
    //   那个按钮在没有表达式时是 disabled 的，点了什么也不会发生——测试会静默假绿。
    const runBtn = Array.from(m.host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '执行',
    ) as HTMLButtonElement
    expect(runBtn, '找不到行内「执行」按钮').toBeTruthy()
    runBtn.click()
    await m.flush()

    const link = m.host.querySelector('.note-link') as HTMLAnchorElement | null
    expect(link, '提示条里必须有一个真链接（纯文本「任务中心」点不了）').toBeTruthy()
    expect(link!.getAttribute('href')).toContain('/cron/tasks')
    expect(link!.getAttribute('href')).toContain('task=42')
    m.fake.assertClean(); m.cleanup()
  })
})

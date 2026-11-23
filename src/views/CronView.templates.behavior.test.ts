// @vitest-environment jsdom
// 任务模板：填充行为 + 无模板时的降级 + 管理弹窗的增删改。
//
// 断言的是**真机 DOM 与真发出去的请求**，不是源码字符串：
// - 「选中模板后字段被灌进表单」只能靠读 input.value 验证；
// - 「没有模板时整条模板栏不渲染」只能靠查 DOM，写 `v-if` 存在是恒绿的；
// - 「填充后名称必须留空」是本功能最容易做错的一条（照抄模板名 → 第二次撞重名）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import CronView from './CronView.vue'
import { API } from '@/api/endpoints'
import { mountView, capsAllOk } from '@/test/mount'
import { fakeError } from '@/test/apiFake'

const PERMS = ['cron.view', 'cron.manage', 'system.view']

interface Tpl {
  id: number; name: string; description: string
  expr: string; command: string; user: string
  timeout_sec: number; webhook_url: string | null
  created_at: number; updated_at: number
}

function tpl(over: Partial<Tpl> = {}): Tpl {
  return {
    id: 1, name: '每日备份', description: '每天凌晨备份数据库',
    expr: '0 3 * * *', command: '/usr/local/bin/backup.sh', user: 'www-data',
    timeout_sec: 3600, webhook_url: 'https://example.com/hook',
    created_at: 1700000000, updated_at: 1700000000, ...over,
  }
}

/** 与 CronView.create.behavior.test.ts 同一套定位法（本页两种 label 结构都兼容） */
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
    let sib = el.nextElementSibling
    while (sib && sib.tagName !== 'INPUT') sib = sib.nextElementSibling
    if (sib) return sib as HTMLInputElement
  }
  return null
}

function btnByText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
}

const CREATE_BODY = (m: { fake: { calls: { url: string; method: string; body: unknown }[] } }) =>
  m.fake.calls.find((c) => c.method === 'POST' && c.url === API.cron.jobs())?.body as
    Record<string, unknown> | undefined

describe('任务模板 · 从模板填充', () => {
  it('选中模板后把字段灌进新建表单（名称刻意留空）', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [], [API.cron.templates()]: [tpl()] },
    })

    // 模板栏必须真的渲染出来（否则下面的下拉框 selection 是空跑）
    const sel = m.host.querySelector('select.tpl-pick-sel, .tpl-bar select') as HTMLSelectElement | null
    expect(sel, '有模板时「从模板填充」下拉框未渲染').toBeTruthy()
    expect(sel!.options.length, '选项应为「不使用模板」+ 1 个模板').toBe(2)

    sel!.value = '1'
    sel!.dispatchEvent(new Event('change'))
    await m.flush()

    expect(inputByLabel(m.host, '表达式')!.value).toBe('0 3 * * *')
    expect(inputByLabel(m.host, '命令')!.value).toBe('/usr/local/bin/backup.sh')
    expect(inputByLabel(m.host, '执行用户')!.value).toBe('www-data')
    expect(inputByLabel(m.host, '超时(秒)')!.value).toBe('3600')
    expect(inputByLabel(m.host, 'Webhook URL')!.value).toBe('https://example.com/hook')
    // ⚠ 关键：名称不能跟着填。任务名唯一，照抄模板名第二次创建必撞重名。
    expect(inputByLabel(m.host, '名称')!.value, '填充模板后名称必须留空，由用户给这一次起名').toBe('')
    expect(m.host.textContent).toContain('请填写任务名称')

    m.fake.assertClean(); m.cleanup()
  })

  it('填充后仍可修改，提交出去的 body 用的是改过的值（模板不绑定）', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [], [API.cron.templates()]: [tpl()] },
    })
    const sel = m.host.querySelector('.tpl-bar select') as HTMLSelectElement
    sel.value = '1'
    sel.dispatchEvent(new Event('change'))
    await m.flush()

    const set = (label: string, v: string) => {
      const i = inputByLabel(m.host, label)!
      i.value = v
      i.dispatchEvent(new Event('input'))
    }
    set('名称', 'backup-this-time')       // 用户自己起的名
    set('命令', '/opt/custom.sh')          // 覆盖模板里的命令
    set('超时(秒)', '120')
    // ⚠ 必须 flush：:disabled 依赖 v-model 的值，DOM 属性要等一次重渲染才更新，
    // 不等就 click 会被 disabled 的按钮静默吞掉（表现为「一个请求都没发」）。
    await m.flush()

    btnByText(m.host, '创建')!.click()
    await m.flush()

    const body = CREATE_BODY(m)
    expect(body, '没有发出 POST /cron/jobs').toBeTruthy()
    expect(body!.name).toBe('backup-this-time')
    expect(body!.command).toBe('/opt/custom.sh')
    expect(body!.timeout_sec).toBe(120)
    // 未改的字段沿用模板值
    expect(body!.expr).toBe('0 3 * * *')
    expect(body!.user).toBe('www-data')
    expect(body!.webhook_url).toBe('https://example.com/hook')

    m.fake.assertClean(); m.cleanup()
  })
})

describe('任务模板 · 没有模板时照常手动创建', () => {
  it('模板为空：不渲染模板下拉，手动填表仍能创建成功', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [], [API.cron.templates()]: [] },
    })

    expect(m.host.querySelector('.tpl-bar'), '没有模板时不该出现下拉栏').toBeNull()
    // 但必须留一个建模板的入口，否则第一次永远建不了
    expect(m.host.textContent).toContain('还没有任务模板')

    const set = (label: string, v: string) => {
      const i = inputByLabel(m.host, label)!
      i.value = v
      i.dispatchEvent(new Event('input'))
    }
    set('名称', 'manual-job')
    set('表达式', '*/5 * * * *')
    set('命令', '/bin/true')
    await m.flush()

    btnByText(m.host, '创建')!.click()
    await m.flush()

    const body = CREATE_BODY(m)
    expect(body, '无模板时手动创建被阻断（回归）').toBeTruthy()
    expect(body!.name).toBe('manual-job')
    expect(body!.expr).toBe('*/5 * * * *')
    m.fake.assertClean(); m.cleanup()
  })

  it('模板接口挂了：降级为手动创建，页面不进入错误态', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: {
        [API.cron.jobs()]: [],
        // 用假件返回非 2xx：模板是锦上添花，不该把整页打成红条。
        // ⚠ 必须用 fakeError()——随手写 `{ __status: 500 }` 会被当成**正常数据**
        //   包进 `{data:…}` 以 200 返回，组件根本不进 catch，用例就永远绿跑。
        [API.cron.templates()]: fakeError(500, 90001, 'boom'),
      },
    })
    // ⚠ mountView 内部只 flush 一次，而 load() 与 loadTemplates() 是两条独立异步链：
    // 模板那条的 fetch reject 可能晚于返回，这里必须多 flush 一次才看得到最终态。
    await m.flush()

    expect(m.host.querySelector('.tpl-bar')).toBeNull()
    // 页面级错误条不该被模板加载失败点亮。
    // ⚠ 只断言「没有 .err 元素」是**会假绿**的：load() 内部 run() 的 finally 会清
    //   error，两者交织时即使 loadTemplates 写了 error 也会被抹掉。所以这里补一条
    //   行为断言——降级的真正价值是「手动创建照常可用」，这条不依赖时序巧合。
    expect(m.host.querySelector('.err'), '模板加载失败不应污染页面错误态').toBeNull()

    const set = (label: string, v: string) => {
      const i = inputByLabel(m.host, label)!
      i.value = v
      i.dispatchEvent(new Event('input'))
    }
    set('名称', 'still-works')
    set('表达式', '0 1 * * *')
    set('命令', '/bin/true')
    await m.flush()

    btnByText(m.host, '创建')!.click()
    await m.flush()
    const body = CREATE_BODY(m)
    expect(body, '模板加载失败后手动创建被阻断（降级失效）').toBeTruthy()
    expect(body!.name).toBe('still-works')
    m.fake.assertClean(); m.cleanup()
  })
})

describe('任务模板 · 管理弹窗', () => {
  it('新建模板：POST body 字段齐全', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [], [API.cron.templates()]: [] },
    })

    btnByText(m.host, '创建一个')!.click()
    await m.flush()

    // 弹窗 Teleport 到 body：必须能在 document 里找到，host 里找不到
    const modal = document.querySelector('[aria-label="任务模板管理"]') as HTMLElement | null
    expect(modal, '模板管理弹窗未渲染（浮层是否被塞进了条件块？）').toBeTruthy()

    const set = (label: string, v: string) => {
      const i = inputByLabel(modal!, label)!
      i.value = v
      i.dispatchEvent(new Event('input'))
    }
    set('模板名', '每周清理')
    set('说明', '清 7 天前的日志')
    set('表达式', '0 4 * * 0')
    set('命令', '/usr/bin/find /var/log -mtime +7 -delete')
    set('超时(秒)', '600')
    await m.flush()   // 同上：按钮 :disabled 依赖 v-model，需一次重渲染才解除

    btnByText(modal!, '创建模板')!.click()
    await m.flush()

    const call = m.fake.calls.find((c) => c.method === 'POST' && c.url === API.cron.templates())
    expect(call, '没有发出 POST /cron/templates').toBeTruthy()
    const body = call!.body as Record<string, unknown>
    expect(body.name).toBe('每周清理')
    expect(body.description).toBe('清 7 天前的日志')
    expect(body.expr).toBe('0 4 * * 0')
    expect(body.command).toBe('/usr/bin/find /var/log -mtime +7 -delete')
    expect(body.timeout_sec).toBe(600)
    expect(body.user).toBe('root')
    m.fake.assertClean(); m.cleanup()
  })

  it('编辑模板：走 PUT /cron/templates/{id} 且带上被改的值', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [], [API.cron.templates()]: [tpl()] },
    })

    btnByText(m.host, '管理模板')!.click()
    await m.flush()

    const modal = document.querySelector('[aria-label="任务模板管理"]') as HTMLElement
    // 列表项里的「编辑」——用 .tpl-item 限定，避免命中表单区
    const editBtn = modal.querySelector('.tpl-item .btn-ghost') as HTMLButtonElement
    editBtn.click()
    await m.flush()

    const nameInput = inputByLabel(modal, '模板名')!
    expect(nameInput.value, '进入编辑态应回填现有模板名').toBe('每日备份')
    nameInput.value = '每日备份-改'
    nameInput.dispatchEvent(new Event('input'))
    await m.flush()

    btnByText(modal, '保存修改')!.click()
    await m.flush()

    const call = m.fake.calls.find((c) => c.method === 'PUT')
    expect(call, '没有发出 PUT 请求').toBeTruthy()
    expect(call!.url).toBe(API.cron.template(1))
    expect((call!.body as Record<string, unknown>).name).toBe('每日备份-改')
    m.fake.assertClean(); m.cleanup()
  })

  it('删除模板：确认后 DELETE /cron/templates/{id}', async () => {
    const m = await mountView({
      component: CronView,
      perms: PERMS,
      caps: capsAllOk(),
      routes: { [API.cron.jobs()]: [], [API.cron.templates()]: [tpl()] },
    })

    btnByText(m.host, '管理模板')!.click()
    await m.flush()

    const modal = document.querySelector('[aria-label="任务模板管理"]') as HTMLElement
    // 第二个按钮是「删除」
    const delBtn = modal.querySelectorAll('.tpl-item .btn-ghost')[1] as HTMLButtonElement
    delBtn.click()
    await m.flush()

    // 确认框是 ConfirmDialog，点确认才真删（防误删）
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '确认执行',
    ) as HTMLButtonElement | undefined
    expect(confirm, '删除确认框未出现').toBeTruthy()
    confirm!.click()
    await m.flush()

    const call = m.fake.calls.find((c) => c.method === 'DELETE')
    expect(call, '没有发出 DELETE 请求').toBeTruthy()
    expect(call!.url).toBe(API.cron.template(1))
    m.fake.assertClean(); m.cleanup()
  })
})


describe('任务模板 · 开关列对齐（样式契约）', () => {
  /**
   * 为什么这条必须是样式断言而不是行为断言：
   *
   * `.switch-row` 自带 `display:inline-flex`，字段名与开关会**横排**，于是这一列
   * 比相邻的「字段名 + input」少一个字高（实测 53px vs 61px），标签基线高 9px。
   * 这个错位在 vue-tsc / vite build / 所有行为单测下**全绿**，只有真机量 rect 才看得见。
   *
   * jsdom 不做布局，所以这里断言的是「正确实现所必需的那条规则存在且方向正确」，
   * 且判据是**能区分实现**的：把 flex-direction 改回 row、或删掉这条规则，都会红。
   */
  it('.row > .switch-row 必须显式声明 flex-direction: column', () => {
    // ⚠ jsdom 下 import.meta.url 不是 file: 协议，`new URL('./x', import.meta.url)`
    //   会抛 "The URL must be of scheme file"（本项目已有先例）。用 cwd 拼绝对路径。
    const src = readFileSync(resolve(process.cwd(), 'src/views/CronView.vue'), 'utf8')
    const style = src.slice(src.indexOf('<style'))
    // 锚定选择器本身（含 `.row >` 前缀），避免命中裸 `.switch-row` 那条 inline-flex
    const idx = style.indexOf('.row > .switch-row {')
    expect(idx, '缺少 `.row > .switch-row` 规则：开关列会退回 inline-flex 横向排布').toBeGreaterThan(-1)
    const block = style.slice(idx, style.indexOf('}', idx))
    expect(block, '该规则必须把方向改成 column，否则标签与开关仍横排').toMatch(/flex-direction:\s*column/)
    expect(block, '该规则必须把 display 改成 flex（inline-flex 会保持横排基线）').toMatch(/display:\s*flex;/)
  })
})

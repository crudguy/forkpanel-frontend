import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 设置页重构守卫（2026-10-30 定位改为「配置与开关中心」）。
 *
 * 断言读 SettingsView.vue 的真实模板/脚本锚点（不是注释措辞）：
 * - 已移除的只读系统信息展示不得复活（运行环境卡 / 部署配置键值表 / 面板与安装
 *   键值表 / 预留项卡 / 独立权限徽章卡）——复活即回到"两处信息互相冲突"的老路。
 * - 可编辑 / 可操作锚点仍在：LLM 保存、角色创建、重启、升级、能力矩阵 #caps
 *   （topbar 系统徽标深链的唯一落点，锚点丢失 = 徽标点击 404 到页顶）。
 * - 「我的权限」徽章并入角色卡（顺序断言），不再独立成卡。
 */
const SRC = readFileSync(new URL('./SettingsView.vue', import.meta.url), 'utf8')
const ML = readFileSync(new URL('../layouts/MainLayout.vue', import.meta.url), 'utf8')

describe('设置页重构守卫：只读系统信息不复活', () => {
  it('运行环境卡（平台/发行版/内核/档位/用户）已删除', () => {
    expect(SRC.includes('运行环境</div>')).toBe(false)
    expect(SRC.includes('auth.platform?.os')).toBe(false)
    expect(SRC.includes('auth.me?.tier')).toBe(false)
  })
  it('部署配置 / 面板与安装键值表已删除（listenLabel、kv 行、安装落点行）', () => {
    expect(SRC.includes('部署配置（只读）')).toBe(false)
    expect(SRC.includes('listenLabel')).toBe(false)
    expect(SRC.includes('kv-row')).toBe(false)
    expect(SRC.includes('安装位置')).toBe(false)
    expect(SRC.includes('服务状态')).toBe(false)
  })
  it('预留项（未接线）卡已删除（report.reserved 无任何消费者）', () => {
    expect(SRC.includes('report.reserved')).toBe(false)
    expect(SRC.includes('预留项（未接线）</div>')).toBe(false)
  })
  it('独立「权限」徽章卡已删除（并入角色卡）', () => {
    expect(SRC.includes('name="key" :size="16" /> 权限')).toBe(false)
  })
})

describe('设置页重构守卫：可编辑与可操作锚点保持', () => {
  it('能力矩阵 #caps 锚点恰好一处（topbar 徽标深链落点）', () => {
    expect(SRC.match(/id="caps"/g)?.length).toBe(1)
  })
  it('四类操作/保存入口各就位', () => {
    expect(SRC.includes('API.settings.patch()')).toBe(true)
    expect(SRC.match(/API\.roles\.create\(\)/g)?.length).toBe(1)
    expect(SRC.match(/API\.system\.restart\(\)/g)?.length).toBe(1)
    expect(SRC.match(/API\.system\.upgrade\(\)/g)?.length).toBe(1)
    expect(SRC.includes('class="restart-row"')).toBe(true)
  })
  it('「我的权限」徽章并入角色卡：位于角色卡标题之后', () => {
    expect(SRC.match(/class="myperms"/g)?.length).toBe(1)
    const role = SRC.indexOf('角色与权限（RBAC）')
    const mine = SRC.indexOf('myperms')
    expect(role).toBeGreaterThan(-1)
    expect(mine).toBeGreaterThan(role)
  })
  it('顶栏副标题反映新定位（配置与开关中心）', () => {
    expect(ML.includes("settings: '面板与功能模块的配置与开关中心'")).toBe(true)
    expect(ML.includes('运行环境与能力矩阵排查')).toBe(false)
  })
})

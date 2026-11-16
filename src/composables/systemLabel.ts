import type { PlatformInfo } from '@/api/types'

/**
 * 概览「系统信息」卡的系统行文案（唯一纯逻辑源，便于单测）。
 *
 * 两个概念各留一份信息、但只占一行：`os` 是系统族（本面板恒 linux），
 * `distro` 才是发行版（debian:12 / debian:forky）。此前把 distro 为空时
 * 回落到 os 塞进「发行版」字段，显示为「发行版：linux」——名不副实。
 *
 * `distro` 保留后端的 `ID[:VERSION]` 契约格式；这里只做展示层首字母
 * 大写与 `id:ver → id ver` 的美化，不解释、不发明平台信息。
 */
function humanize(v: string): string {
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : v
}

/**
 * 后端 `distro` 的契约格式是 `id[:version]`（openapi 示例 `debian:12`）。
 * 展示层只做「首字母大写 + 冒号换空格」，不解释、不发明平台信息；
 * 已经被后端回退成 `PRETTY_NAME` 的可读名称原样返回。
 */
export function distroLabel(distro: string | null | undefined): string {
  const v = (distro ?? '').trim()
  if (!v) return ''
  const i = v.indexOf(':')
  if (i === -1) return humanize(v)
  const id = v.slice(0, i)
  const ver = v.slice(i + 1).trim()
  return humanize(ver ? `${id} ${ver}` : id)
}

export function systemLabel(p: PlatformInfo | null): string {
  if (!p) return '—'
  const os = humanize(p.os)
  const distro = distroLabel(p.distro)
  if (!distro) return os || '—'
  // PRETTY_NAME 回退值本身可能含 "Linux"，再拼系统族前缀会重复。
  if (distro.toLowerCase().includes('linux')) return distro
  return os ? `${os} · ${distro}` : distro
}

/**
 * 口令工具：强口令生成 + 本地策略校验（与后端 check_password_policy 同规则镜像）。
 *
 * 生成用 Web Crypto（crypto.getRandomValues）保证不可预测；策略与后端保持一致，
 * 避免前端放行、后端拒绝的不一致。纯逻辑抽在此处以便 vitest 覆盖（vue 组件内联逻辑不可测）。
 */

// 去掉易混字符：l/I、1、O/0、| 等，降低手抄/口述出错概率
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGIT = '23456789'
const SYMBOL = '!@#$%^&*()-_=+[]{};:,.<>?'

const POOLS = [LOWER, UPPER, DIGIT, SYMBOL]
const ALL = POOLS.join('')

function randIndex(max: number): number {
  // 32 位无符号随机 → 取模；max 远小于 2^32，偏置可忽略，足够口令用途
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % max
}

/**
 * 生成强口令：默认 16 位，保证四类字符各至少一个（天然满足后端 ≥10 位且 ≥2 类的策略），
 * 末位洗牌避免「固定位置出现固定类别」的可预测性。
 */
export function generateStrongPassword(len = 16): string {
  if (len < POOLS.length) len = POOLS.length
  const out: string[] = []
  for (const pool of POOLS) out.push(pool[randIndex(pool.length)])
  for (let i = out.length; i < len; i++) out.push(ALL[randIndex(ALL.length)])
  // Fisher–Yates 洗牌
  for (let i = out.length - 1; i > 0; i--) {
    const j = randIndex(i + 1)
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out.join('')
}

/**
 * 与后端 check_password_policy 一致的本地镜像：≥10 位且包含至少两类字符。
 * 用于首启向导实时强度提示，避免「前端放过、后端拒绝」的体验断层。
 */
export function passwordPolicyOk(p: string): boolean {
  if (p.length < 10) return false
  const classes =
    (/[a-z]/.test(p) ? 1 : 0) +
    (/[A-Z]/.test(p) ? 1 : 0) +
    (/\d/.test(p) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(p) ? 1 : 0)
  return classes >= 2
}

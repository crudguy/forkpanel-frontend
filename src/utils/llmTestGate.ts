/**
 * F-02①：测试连接只允许使用已保存的 API Endpoint。
 *
 * 后端有同口径的硬拒绝（绕过 API 也拦得住），这里只负责提前给出可操作的提示，
 * 免得用户改完 Endpoint 点「测试连接」只看到一句 400。
 */
export function llmTestBlockReason(saved: string, current: string): string | null {
  if (current.trim() !== saved.trim()) {
    return 'API Endpoint 已修改：测试连接只使用已保存的 Endpoint，请先保存再测试'
  }
  return null
}

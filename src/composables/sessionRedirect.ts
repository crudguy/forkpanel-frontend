/**
 * 会话过期（全局 `panel:unauthorized`）跳登录时的回跳目标。
 *
 * 抽成纯函数的理由：`main.ts` 顶层有 `app.mount` 等副作用，没法真挂载测；
 * 而「登录后回到哪一页」是纯字符串判据，抽出来就能直接用行为测试钉住，
 * 不必退化成「读 main.ts 源码断言有没有 redirect 字样」的文本镜像。
 *
 * 与 `router/index.ts` 的 `beforeEach` 同口径：深链 / 会话过期登录后回到原页，
 * 而不是一律落概览丢掉编辑态与过滤条件。
 */

export interface LoginTarget {
  name: 'login'
  query: { redirect?: string }
}

/**
 * 由当前 `fullPath` 生成登录路由目标。
 *
 * ⚠ 排除 `/login*`：登录请求本身带 `skipAuthRedirect`，正常不会触发 401；
 *   但若将来有别的路径漏配，带 `redirect=/login` 会让刚登录的用户被送回登录页，
 *   表现为「账号密码对却一直登不进去」的死循环。
 * ⚠ 排除 `//host`：`LoginView.safeRedirect` 会兜住，但这里也不该制造外链形状的回跳。
 */
export function loginRedirect(fullPath: string | undefined): LoginTarget {
  const p = (fullPath ?? '').trim()
  const safe = p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/login')
  return safe ? { name: 'login', query: { redirect: p } } : { name: 'login', query: {} }
}

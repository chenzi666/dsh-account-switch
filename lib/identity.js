/**
 * 平台身份查询：拿一个 grant token 去问平台「你是谁」。
 *
 * 用途只有一个——**给历史记录补上 userId**。早期版本按 token 指纹去重，而每次重新登录
 * 都会换新 token，于是同一个账号在库里留下多条记录；这些老记录没有 userId，本地无从
 * 判断哪几条是同一个人。问一次平台就有答案了。
 *
 * 这是纯读操作：`GET /auth-api/v0/users/current` 只回账号资料，不改任何东西。
 *
 * @module dsh-account-switch/identity
 */

/** 平台 API 的默认 origin。 */
const DEFAULT_ORIGIN = 'https://platform.deepseek.com'

/** 与官方 `platformClientHeaders` 对齐的客户端标识。 */
const CLIENT_VERSION = '0.2.0-rc.2'

/**
 * 组装平台请求头。缺了 `x-dsh-auth-token` 会被当成未登录，缺了 `x-client-*` 可能被拒。
 * @param token - grant token。
 * @returns 请求头对象。
 */
function platformHeaders(token) {
  return {
    'x-dsh-auth-token': token,
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    'x-client-version': CLIENT_VERSION,
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  }
}

/**
 * 从平台响应里剥出用户对象。
 *
 * 平台的接口统一包了一层信封：`{ code, msg, data: { biz_code, biz_msg, biz_data } }`，
 * 用户数据在 `data.biz_data`。自建或旧版部署可能直接返回用户对象本身，所以逐层试，
 * 认出「像用户对象」的那一层（带 id 或 id_profile）就返回。
 * @param payload - 解析后的响应体。
 * @returns 用户对象，或 null。
 */
function extractUser(payload) {
  const candidates = [payload?.data?.biz_data, payload?.data, payload]
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    if ('id' in candidate || 'id_profile' in candidate) return candidate
  }
  return null
}

/**
 * 查询一个 token 对应的平台账号身份。
 *
 * 永不抛错：失败返回 `{ ok: false, reason }`，调用方按「这条记录补不上身份」处理即可——
 * token 过期、网络不通、平台改版都会走到这里，而它们都不该让整个补全流程中断。
 *
 * @param token - grant token。
 * @param options - `origin` 覆盖平台 origin；`timeoutMs` 单次请求超时。
 * @returns `{ ok: true, userId, name, avatarUrl, contact }` 或 `{ ok: false, reason }`。
 */
export async function fetchPlatformIdentity(token, options = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'token 为空' }
  }
  const origin = options.origin ?? DEFAULT_ORIGIN
  const timeoutMs = options.timeoutMs ?? 10_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${origin}/auth-api/v0/users/current`, {
      method: 'GET',
      headers: platformHeaders(token),
      signal: controller.signal,
    })
    if (response.status === 401) return { ok: false, reason: 'token 已失效（401）' }
    if (!response.ok) return { ok: false, reason: `平台返回 HTTP ${String(response.status)}` }
    const payload = await response.json()
    const user = extractUser(payload)
    if (user === null) return { ok: false, reason: '响应里找不到用户对象' }
    const userId = typeof user.id === 'string' && user.id.length > 0 ? user.id : null
    if (userId === null) return { ok: false, reason: '用户对象里没有 id' }
    const identity = user.id_profile ?? {}
    const name = typeof identity.name === 'string' && identity.name.length > 0 ? identity.name : null
    const avatarUrl = typeof identity.picture === 'string' && identity.picture.length > 0 ? identity.picture : null
    const contact = user.mobile ?? user.mobile_number ?? user.email ?? null
    return { ok: true, userId, name, avatarUrl, contact }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String(error?.message ?? error)
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

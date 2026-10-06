/**
 * 凭证 key 语法与账号身份工具。
 *
 * 内核的约束（`@deepseek-ai/dsh-credentials`）：
 *   - key 形如 `<scope>/<id>`，恰好两段；
 *   - 每一段必须匹配 /^[a-z][a-z0-9-]*$/ —— 小写字母开头，只含小写字母、数字、连字符；
 *   - scope 是占有该 key 的插件名，本插件复用官方的 `deepseek-account-platform`
 *     scope，因为账号 grant 的所有权属于那个插件，我们只是替它多存几份。
 *
 * 官方已占用的两个 id：`default`（活跃账号）与 `device`（设备指纹）。本插件只写
 * `default` 与 `account-*`，绝不动 `device`。
 *
 * @module dsh-account-switch/keys
 */

import { createHash, randomBytes } from 'node:crypto'

/** 官方账号平台的 scope 段。 */
export const SCOPE = 'deepseek-account-platform'

/** 活跃账号槽位：官方登录流程唯一会写入的 key。 */
export const DEFAULT_KEY = `${SCOPE}/default`

/** 设备指纹槽位：官方持有，本插件只读不改。 */
export const DEVICE_KEY = `${SCOPE}/device`

/** 存档槽位的前缀。 */
export const SLOT_PREFIX = 'account-'

/** 与内核 KEY_SEGMENT_PATTERN 同构，用于在拼 key 之前先判合法性。 */
const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/** grant payload 的版本号，与官方 `grant` schema 对齐。 */
const GRANT_VERSION = 1

/**
 * 单个 key 段是否合法。任何来自外部的字符串（CLI 参数、注册表文件）都要先过这里，
 * 因为非法的段永远不可能存过记录，应当读作「没有这个账号」而不是抛错。
 * @param value - 待校验的段。
 * @returns 是否可用作 scope 或 id。
 */
export function isValidSegment(value) {
  return typeof value === 'string' && SEGMENT_PATTERN.test(value)
}

/**
 * 由账号 id 拼出存档槽位 key。
 * @param id - 账号 id，形如 `acct-9f2c1a4b`。
 * @returns 完整的 `<scope>/<id>` key。
 * @throws TypeError 当 id 不是合法段时。
 */
export function slotKeyFor(id) {
  if (!isValidSegment(id)) {
    throw new TypeError(`account id "${id}" 不是合法的凭证 key 段（需匹配 ${String(SEGMENT_PATTERN)}）`)
  }
  return `${SCOPE}/${SLOT_PREFIX}${id}`
}

/**
 * 这个 key 是否指向本插件维护的存档槽位。
 * @param key - 完整 key。
 * @returns 是存档槽位则为 true。
 */
export function isSlotKey(key) {
  if (typeof key !== 'string' || !key.startsWith(`${SCOPE}/${SLOT_PREFIX}`)) return false
  return isValidSegment(key.slice(SCOPE.length + 1))
}

/**
 * 从存档槽位 key 反解账号 id。
 * @param key - 完整 key。
 * @returns 账号 id；key 不是存档槽位时返回 null。
 */
export function slotIdFromKey(key) {
  if (!isSlotKey(key)) return null
  return key.slice(SCOPE.length + 1 + SLOT_PREFIX.length)
}

/**
 * token 的稳定指纹。账号 id 直接由它派生，于是「同一个 grant 永远映射到同一个账号」
 * 成为结构保证，而不是需要维护的映射表。
 * @param token - grant token 明文。
 * @returns 16 位十六进制指纹。
 */
export function fingerprintOfToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token 必须是非空字符串')
  }
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 由指纹派生账号 id。指纹是纯十六进制，可能以数字开头，而 key 段必须以字母开头，
 * 因此固定加 `acct-` 前缀；`acct-` 本身也满足段语法。
 * @param fingerprint - {@link fingerprintOfToken} 的输出。
 * @returns 账号 id。
 */
export function accountIdFromFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint)) {
    throw new TypeError(`fingerprint "${fingerprint}" 必须是 16 位十六进制`)
  }
  return `acct-${fingerprint.slice(0, 8)}`
}

/**
 * 为一次登录分配一个候选账号 id。仅在拿不到 token（因此算不出指纹）时才用得到，
 * 例如 CLI 在登录前预占一个位置。
 * @returns 账号 id。
 */
export function randomAccountId() {
  return `acct-${randomBytes(4).toString('hex')}`
}

/**
 * 构造一条 grant record，形态与官方 `grant` schema 一致。
 * @param token - 平台下发的 grant token。
 * @param issuer - 签发方 origin，例如 `https://platform.deepseek.com`。
 * @returns `{ kind: 'grant', payload: { version, token, issuer } }`。
 */
export function makeGrant(token, issuer) {
  return {
    kind: 'grant',
    payload: { version: GRANT_VERSION, token, issuer },
  }
}

/**
 * 从严读出 record 里的 grant。三种失败各自可诊断：不是 grant、payload 形状不对、
 * 版本不认识。任何一条都意味着**不要**拿它去覆盖 `default`，因为官方
 * `PlatformAccount` 读到坏 record 时会抛 `PlatformAuthError('storage')`，
 * 那是把账号页打挂，不是一次干净的失败。
 * @param record - `ctx.credentials.readRecord` 的返回值。
 * @returns `{ token, issuer }`，record 缺失时返回 null。
 * @throws Error 当 record 存在但不可用时。
 */
export function readGrant(record) {
  if (record === undefined || record === null) return null
  if (record.kind !== 'grant') {
    throw new Error(`凭证记录不是 grant（实际 kind=${JSON.stringify(record.kind)}）`)
  }
  const payload = record.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('grant payload 必须是对象')
  }
  if (payload.version !== GRANT_VERSION) {
    throw new Error(`grant payload 版本 ${JSON.stringify(payload.version)} 不被支持（期望 ${GRANT_VERSION}）`)
  }
  if (typeof payload.token !== 'string' || payload.token.length === 0) {
    throw new Error('grant payload 缺少非空 token')
  }
  if (typeof payload.issuer !== 'string' || payload.issuer.length === 0) {
    throw new Error('grant payload 缺少非空 issuer')
  }
  return { token: payload.token, issuer: payload.issuer }
}

/**
 * 只读地取出 record 里的 token 指纹，record 不可用时返回 null 而不抛错。
 * 事件监听器走这条路径：一条坏记录不该让监听器把事件分发打歪。
 * @param record - 凭证记录。
 * @returns 指纹或 null。
 */
export function fingerprintOfRecord(record) {
  try {
    const grant = readGrant(record)
    return grant === null ? null : fingerprintOfToken(grant.token)
  } catch {
    return null
  }
}

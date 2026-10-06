/**
 * 账号注册表：`$DSH_HOME/accounts/registry.json`。
 *
 * 之所以不复用 `.credentials.yaml`：`credentials-local` 的解析器对文档做严格白名单
 * 校验——顶层只允许 `version`/`refs`/`records`，每条 record 只允许 `kind`/`payload`，
 * 多一个字段就让整个文档解析失败。那是启动级故障。所以 token 进凭证库，元数据进这里。
 *
 * 本文件只存**指纹**，不存 token 明文；token 明文只在凭证库里，跟官方行为一致。
 * 读入路径对坏条目一律降级（跳过并记告警），因为注册表坏了不该阻止 Harness 启动。
 *
 * @module dsh-account-switch/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountsDir } from './home.js'
import { withLock } from './lock.js'

/** 注册表结构版本。 */
export const REGISTRY_VERSION = 1

/** 账号 id 的形状：`acct-` 加十六进制指纹前缀。 */
const ACCOUNT_ID_PATTERN = /^acct-[0-9a-z-]+$/

/** token 指纹的形状：16 位十六进制。 */
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/

/**
 * 注册表文件路径。
 * @param home - DSH home 目录。
 * @returns 绝对路径。
 */
export function registryPath(home) {
  return join(accountsDir(home), 'registry.json')
}

/**
 * 一张空注册表。
 * @returns `{ version, activeId: null, accounts: [] }`。
 */
export function emptyRegistry() {
  return { version: REGISTRY_VERSION, activeId: null, accounts: [] }
}

/**
 * 一条账号记录的形状校验。宽松到只拦真正会引发下游错误的输入：id 与指纹必须存在且
 * 形状正确，其余字段缺失时补默认值。
 * @param raw - 来自磁盘的候选对象。
 * @returns 规整后的账号记录，不可用时返回 null。
 */
function normalizeAccount(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : null
  const fingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint : null
  if (id === null || fingerprint === null) return null
  if (!ACCOUNT_ID_PATTERN.test(id)) return null
  if (!FINGERPRINT_PATTERN.test(fingerprint)) return null
  return {
    id,
    fingerprint,
    // 平台侧的用户 id。这条记录真正的「账号身份」——token 会在每次重新登录时换新，
    // 指纹跟着变，只有它不变，所以去重必须靠它。老记录里可能没有（那时还没采集）。
    userId: typeof raw.userId === 'string' && raw.userId.length > 0 ? raw.userId : null,
    label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : id,
    issuer: typeof raw.issuer === 'string' ? raw.issuer : null,
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : null,
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
    switchCount: Number.isSafeInteger(raw.switchCount) && raw.switchCount >= 0 ? raw.switchCount : 0,
  }
}

/**
 * 解析注册表文本。
 * @param text - 文件内容。
 * @returns `{ registry, warnings }`；整体不可解析时返回空表并带上原因。
 */
export function parseRegistry(text) {
  const warnings = []
  let root
  try {
    root = JSON.parse(text)
  } catch (error) {
    return { registry: emptyRegistry(), warnings: [`registry.json 不是合法 JSON：${error.message}`] }
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return { registry: emptyRegistry(), warnings: ['registry.json 顶层必须是对象'] }
  }
  if (root.version !== REGISTRY_VERSION) {
    warnings.push(`registry.json 声明 version ${JSON.stringify(root.version)}，本版本读 ${REGISTRY_VERSION}`)
  }
  const accounts = []
  const seen = new Set()
  for (const raw of Array.isArray(root.accounts) ? root.accounts : []) {
    const account = normalizeAccount(raw)
    if (account === null) {
      warnings.push(`跳过一条形状不合法的账号记录：${JSON.stringify(raw)?.slice(0, 120)}`)
      continue
    }
    if (seen.has(account.id)) {
      warnings.push(`账号 id ${account.id} 重复，保留首次出现的记录`)
      continue
    }
    seen.add(account.id)
    accounts.push(account)
  }
  const activeId = typeof root.activeId === 'string' && seen.has(root.activeId) ? root.activeId : null
  if (typeof root.activeId === 'string' && activeId === null) {
    warnings.push(`activeId ${root.activeId} 指向不存在的账号，已置空`)
  }
  return { registry: { version: REGISTRY_VERSION, activeId, accounts }, warnings }
}

/**
 * 稳定序列化：账号按加入时间排序，键顺序固定，便于人眼 diff 与版本控制。
 * @param registry - 注册表。
 * @returns JSON 文本。
 */
export function serializeRegistry(registry) {
  const ordered = {
    version: REGISTRY_VERSION,
    activeId: registry.activeId ?? null,
    accounts: [...registry.accounts].sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt))),
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/**
 * 读注册表。文件缺失是正常状态（第一次运行），不是错误。
 * @param home - DSH home 目录。
 * @returns `{ registry, warnings }`。
 */
export function loadRegistry(home) {
  let text
  try {
    text = readFileSync(registryPath(home), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { registry: emptyRegistry(), warnings: [] }
    return { registry: emptyRegistry(), warnings: [`读 registry.json 失败：${error.message}`] }
  }
  return parseRegistry(text)
}

/**
 * 原子写注册表：先写同目录临时文件，再改名覆盖。改名在 Windows 上同样具备替换语义，
 * 因此读者永远看不到半截文件。
 * @param home - DSH home 目录。
 * @param registry - 要落盘的注册表。
 */
export function writeRegistrySync(home, registry) {
  mkdirSync(accountsDir(home), { recursive: true, mode: 0o700 })
  const target = registryPath(home)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, serializeRegistry(registry), { mode: 0o600 })
  renameSync(tmp, target)
}

/**
 * 在锁内完成一次读-改-写。DSH 插件与 CLI 是不同进程，都走这条路径，因此彼此不会
 * 用陈旧的快照互相覆盖。
 * @param home - DSH home 目录。
 * @param mutate - 收到当前注册表，返回新注册表（返回 undefined 表示不改）。
 * @returns mutate 的返回值，未改动时为 undefined。
 */
export async function updateRegistry(home, mutate) {
  mkdirSync(accountsDir(home), { recursive: true, mode: 0o700 })
  return withLock(`${registryPath(home)}.lock`, async () => {
    const { registry } = loadRegistry(home)
    const next = await mutate(registry)
    if (next !== undefined) writeRegistrySync(home, next)
    return next
  })
}

/* ── 纯逻辑：以下函数不碰文件系统，便于单测 ───────────────────────────── */

/**
 * 按指纹查账号。
 * @param registry - 注册表。
 * @param fingerprint - token 指纹。
 * @returns 账号记录或 null。
 */
export function findByFingerprint(registry, fingerprint) {
  return registry.accounts.find((account) => account.fingerprint === fingerprint) ?? null
}

/**
 * 按平台用户 id 查账号——**去重时的首选依据**。
 *
 * 同一个账号重新登录会拿到全新的 token，指纹随之改变，而 userId 不变。只按指纹去重
 * 会让每登录一次就多出一条记录，这正是「账号会重复」的成因。
 * @param registry - 注册表。
 * @param userId - 平台侧用户 id。
 * @returns 账号记录或 null；userId 为空时一律返回 null。
 */
export function findByUserId(registry, userId) {
  if (typeof userId !== 'string' || userId.length === 0) return null
  return registry.accounts.find((account) => account.userId === userId) ?? null
}

/**
 * 同一平台账号下的全部记录。用于合并历史遗留的重复条目。
 * @param registry - 注册表。
 * @param userId - 平台侧用户 id。
 * @returns 账号记录数组，可能为空。
 */
export function findAllByUserId(registry, userId) {
  if (typeof userId !== 'string' || userId.length === 0) return []
  return registry.accounts.filter((account) => account.userId === userId)
}

/**
 * 按 id 查账号。
 * @param registry - 注册表。
 * @param id - 账号 id。
 * @returns 账号记录或 null。
 */
export function findById(registry, id) {
  return registry.accounts.find((account) => account.id === id) ?? null
}

/**
 * 按 id 或昵称查账号。昵称匹配只在唯一命中时生效，避免歧义。
 * @param registry - 注册表。
 * @param selector - id 或昵称。
 * @returns `{ account }` 或 `{ account: null, reason }`。
 */
export function resolveSelector(registry, selector) {
  const byId = findById(registry, selector)
  if (byId !== null) return { account: byId }
  const byLabel = registry.accounts.filter((account) => account.label === selector)
  if (byLabel.length === 1) return { account: byLabel[0] }
  if (byLabel.length > 1) return { account: null, reason: `昵称「${selector}」对应 ${byLabel.length} 个账号，请改用 id` }
  return { account: null, reason: `找不到账号「${selector}」` }
}

/**
 * 插入或更新一条账号记录（按 id 去重）。
 * @param registry - 注册表。
 * @param account - 账号记录。
 * @returns 新注册表。
 */
export function upsertAccount(registry, account) {
  const index = registry.accounts.findIndex((item) => item.id === account.id)
  if (index === -1) {
    return { ...registry, accounts: [...registry.accounts, account] }
  }
  const merged = { ...registry.accounts[index], ...account }
  const accounts = [...registry.accounts]
  accounts[index] = merged
  return { ...registry, accounts }
}

/**
 * 删除一条账号记录，并把悬空的 activeId 一并清掉。
 * @param registry - 注册表。
 * @param id - 账号 id。
 * @returns 新注册表。
 */
export function removeAccount(registry, id) {
  return {
    ...registry,
    activeId: registry.activeId === id ? null : registry.activeId,
    accounts: registry.accounts.filter((account) => account.id !== id),
  }
}

/**
 * 改昵称。
 * @param registry - 注册表。
 * @param id - 账号 id。
 * @param label - 新昵称。
 * @returns 新注册表。
 */
export function renameAccount(registry, id, label) {
  const account = findById(registry, id)
  if (account === null) return registry
  return upsertAccount(registry, { ...account, label })
}

/**
 * 记录一次切换。
 * @param registry - 注册表。
 * @param id - 目标账号 id。
 * @param now - ISO 时间戳。
 * @returns 新注册表。
 */
export function markSwitched(registry, id, now) {
  const account = findById(registry, id)
  if (account === null) return registry
  return {
    ...upsertAccount(registry, { ...account, lastUsedAt: now, switchCount: account.switchCount + 1 }),
    activeId: id,
  }
}

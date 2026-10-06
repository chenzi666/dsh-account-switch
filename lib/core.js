/**
 * 与后端无关的账号编排逻辑。插件与 CLI 共用这一份，因此两条入口对同一批文件
 * 永远给出同一套结果。
 *
 * 核心不变式，全部围绕官方只认一个槽位（`deepseek-account-platform/default`）这一事实：
 *
 *   1. **写 default 之前先存档。** 官方登录流程把新 token 直接覆盖到 default，
 *      所以任何时刻 default 里装着的那份 grant 都必须已经存在于某个存档槽位，
 *      否则一次重新登录就会让上一个账号的 token 永久消失。
 *   2. **账号 id 由 token 指纹派生。** 同一个 grant 永远映射到同一个 id，于是
 *      「归档」天然幂等，不需要一张需要维护的映射表，也不会重复入库。
 *   3. **活跃账号以 default 的实际内容为准，而不是注册表里的 activeId。**
 *      activeId 只是给人看的提示；真相只有一处，就是 default 里那个 token。
 *
 * @module dsh-account-switch/core
 */

import { accountIdFromFingerprint, fingerprintOfToken, makeGrant, readGrant } from './keys.js'
import { fetchPlatformIdentity } from './identity.js'
import {
  findById,
  findAllByUserId,
  findByFingerprint,
  findByUserId,
  loadRegistry,
  markSwitched,
  removeAccount as removeRegistryAccount,
  renameAccount as renameRegistryAccount,
  resolveSelector,
  updateRegistry,
  upsertAccount,
} from './store.js'

/** 账号 id 的指纹前缀长度上下限。 */
const MIN_ID_LEN = 8
const MAX_ID_LEN = 16

/**
 * 在已有注册表上分配一个不与别人冲突的账号 id。指纹取前 n 位做 id，撞了就多取一位，
 * 直到 16 位用尽——那意味着两个不同的 sha256 前 16 位相同，实际不可能发生。
 * @param registry - 现有注册表。
 * @param fingerprint - token 指纹。
 * @returns 账号 id。
 * @throws Error 当 16 位前缀仍然冲突时（说明注册表被污染）。
 */
export function assignAccountId(registry, fingerprint) {
  for (let length = MIN_ID_LEN; length <= MAX_ID_LEN; length += 1) {
    const candidate = accountIdFromFingerprint(fingerprint).slice(0, 5 + length)
    const existing = findById(registry, candidate)
    if (existing === null || existing.fingerprint === fingerprint) return candidate
  }
  throw new Error(`无法为指纹 ${fingerprint} 分配唯一账号 id：已有账号占满了全部前缀`)
}

/**
 * 读出 default 槽位并给出可诊断的解读，不抛错。
 * @param backend - 槽位后端。
 * @returns state 为 `empty`（没有记录）/ `grant`（可用）/ `broken`（记录存在但形状不对）。
 */
export async function inspectActive(backend) {
  const record = await backend.readDefault()
  if (record === undefined) {
    return { state: 'empty', record: undefined, grant: null, fingerprint: null, reason: null }
  }
  try {
    const grant = readGrant(record)
    return { state: 'grant', record, grant, fingerprint: fingerprintOfToken(grant.token), reason: null }
  } catch (error) {
    return { state: 'broken', record, grant: null, fingerprint: null, reason: error.message }
  }
}

/**
 * 把一条 grant record 归档进账号库（幂等）。这是唯一落盘存档的地方，
 * 其余入口都收敛到这里。
 *
 * **去重的依据是平台用户 id，不是 token 指纹。** 同一个账号每次重新登录都会拿到全新的
 * token，指纹随之改变——只按指纹匹配的话，每登录一次就多出一条记录，这就是「账号会重复」
 * 的成因。userId 只在拿不到时才退回指纹匹配（离线、接口不可用的情形）。
 *
 * 已经是已知账号时只刷新槽位内容、指纹与 issuer，不动昵称、加入时间与切换计数——
 * 那些是人的数据，不该被一次自动归档改写。
 *
 * 同一平台账号下若还留着历史重复条目（早期版本按指纹去重时产生的），这里会把它们
 * 连同各自的槽位一并收掉，只留下正在用的这条。
 *
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @param record - 待归档的 grant record。
 * @param options - `userId` 平台用户 id（去重首选）；`label` 首次入库的昵称；
 *   `now` 覆盖时间戳；`setActive: false` 表示这次归档不代表「它现在是活跃账号」。
 * @returns `{ account, created, fingerprint, merged }`；`merged` 是被合并掉的重复条目数。
 * @throws Error 当 record 不是可读的 grant 时。
 */
export async function archiveGrant(backend, home, record, options = {}) {
  const now = options.now ?? new Date().toISOString()
  // 形状不对就抛：交给调用方决定是拒绝这次归档还是只记一条告警。
  const grant = readGrant(record)
  const fingerprint = fingerprintOfToken(grant.token)
  const setActive = options.setActive !== false
  const userId = typeof options.userId === 'string' && options.userId.length > 0 ? options.userId : null
  let created = false
  let entry
  const staleIds = []
  const registry = await updateRegistry(home, (current) => {
    const existing =
      (userId === null ? null : findByUserId(current, userId)) ?? findByFingerprint(current, fingerprint)
    const id = existing?.id ?? assignAccountId(current, fingerprint)
    created = existing === null
    entry = {
      id,
      fingerprint,
      // 已知账号保留原有的 userId：一次没取到资料不该把它抹掉。
      userId: userId ?? existing?.userId ?? null,
      label: existing?.label ?? options.label ?? `账号 ${id.slice(5)}`,
      issuer: grant.issuer,
      addedAt: existing?.addedAt ?? now,
      lastUsedAt: existing?.lastUsedAt ?? now,
      switchCount: existing?.switchCount ?? 0,
    }
    let next = upsertAccount(current, entry)
    if (userId !== null) {
      for (const account of findAllByUserId(next, userId)) {
        if (account.id === id) continue
        staleIds.push(account.id)
        next = removeAccount(next, account.id)
      }
    }
    return setActive ? { ...next, activeId: id } : next
  })
  await backend.writeSlot(entry.id, makeGrant(grant.token, grant.issuer))
  // 槽位清理放在注册表提交之后：中途失败也只是留下一个无引用的槽位，
  // 下次 list 会把它作为孤儿报出来，不会让记录指向空槽位。
  for (const staleId of staleIds) await backend.deleteSlot(staleId)
  return { account: findById(registry, entry.id), created, fingerprint, merged: staleIds.length }
}

/**
 * 把当前 default 里的 grant 归档进账号库（幂等）。
 *
 * 已经是已知账号时，只刷新它的槽位内容与 issuer，不动昵称、加入时间与切换计数——
 * 那些是人的数据，不该被一次自动归档改写。
 *
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @param options - `label` 用于首次入库时的昵称；`now` 覆盖时间戳。
 * @returns `{ account, created, fingerprint }`；default 为空时 account 为 null。
 * @throws Error 当 default 里的记录形状不对时（既不覆盖也不归档，避免把坏数据扩散）。
 */
export async function captureActive(backend, home, options = {}) {
  const active = await inspectActive(backend)
  if (active.state === 'empty') return { account: null, created: false, fingerprint: null }
  if (active.state === 'broken') {
    throw new Error(`default 槽位里的记录无法解读，已放弃归档：${active.reason}`)
  }
  return archiveGrant(backend, home, active.record, options)
}

/**
 * 列出全部账号，并标出哪个是当前活跃账号。
 *
 * 活跃判定用 default 的指纹而不是注册表的 activeId：注册表可能被手工改过，
 * 而 default 的内容永远不会撒谎。
 *
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @returns `{ accounts, activeId, warnings, defaultState, defaultReason }`。
 */
export async function listAccounts(backend, home) {
  const { registry, warnings } = loadRegistry(home)
  const active = await inspectActive(backend)
  const activeId =
    active.fingerprint === null ? null : findByFingerprint(registry, active.fingerprint)?.id ?? null
  const slotIds = new Set(await backend.listSlotIds())
  const accounts = registry.accounts.map((account) => ({
    ...account,
    active: account.id === activeId,
    archived: slotIds.has(account.id),
  }))
  // 槽位存在但注册表里没有：说明有人在 DSH 之外动过凭证库。报出来，别默默忽略。
  for (const id of slotIds) {
    if (findById(registry, id) === null) {
      warnings.push(`槽位 ${id} 存在但注册表里没有对应条目（可能被外部工具写入）`)
    }
  }
  return {
    accounts,
    activeId,
    warnings,
    defaultState: active.state,
    defaultReason: active.reason,
  }
}

/**
 * 把「账号 id 或昵称」解析成一个账号，输入非法或歧义时给出可读原因。
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @param selector - 账号 id 或昵称。
 * @returns `{ account }` 或 `{ account: null, reason }`。
 */
async function resolveAgainst(backend, home, selector) {
  const listing = await listAccounts(backend, home)
  return resolveSelector({ accounts: listing.accounts }, selector)
}

/**
 * 切换活跃账号。
 *
 * 顺序不可颠倒：先归档当前 default，再覆盖。如果目标槽位是空的（比如官方登出时
 * 只清 default、或有人手工删了槽位），立刻失败而不是把 default 清空——清掉
 * default 等于当场把登录状态弄丢。
 *
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @param selector - 账号 id 或昵称。
 * @returns `{ account, previous, noop }`。
 * @throws Error 找不到账号、槽位缺失、或槽位记录形状不对。
 */
export async function useAccount(backend, home, selector) {
  const resolved = await resolveAgainst(backend, home, selector)
  if (resolved.account === null) throw new Error(resolved.reason)
  const target = resolved.account

  if (target.active === true) {
    return { account: target, previous: target, noop: true }
  }

  // 先把当前账号钉进它的槽位，再谈覆盖。
  const previous = await captureActive(backend, home)

  const record = await backend.readSlot(target.id)
  if (record === undefined) {
    throw new Error(
      `账号 ${target.id}（${target.label}）的存档槽位是空的，拒绝切换：` +
        '槽位缺失通常意味着该账号已被官方登出清理，需要重新登录一次再切回来。',
    )
  }
  let grant
  try {
    grant = readGrant(record)
  } catch (error) {
    throw new Error(`账号 ${target.id} 的存档无法解读：${error.message}`)
  }

  await backend.writeDefault(makeGrant(grant.token, grant.issuer))
  const now = new Date().toISOString()
  const registry = await updateRegistry(home, (current) => markSwitched(current, target.id, now))
  return { account: findById(registry, target.id) ?? { ...target, active: true }, previous: previous.account, noop: false }
}

/**
 * 把当前活跃账号存档、并从 default 撤下。
 *
 * 这是「一次登录多个账号」真正需要的那个动作：官方 UI 在已登录状态下只会显示
 * 「退出登录」，而退出会**向平台注销 token**（`revokeAccount`），把槽位里的存档
 * 一起废掉。park 只动本地、不碰服务端，于是 UI 回到未登录态可以继续登录下一个账号，
 * 而刚才那个账号的 token 依然有效，随时切得回来。
 *
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @param options - 透传给归档的 `label` / `now`。
 * @returns `{ account, parked }`；本来就没有活跃账号时 `parked` 为 false。
 */
export async function parkActive(backend, home, options = {}) {
  const captured = await captureActive(backend, home, options)
  if (captured.account === null) return { account: null, parked: false }
  await backend.deleteDefault()
  return { account: captured.account, parked: true }
}

/**
 * 从账号库里移除一个账号：删槽位、删注册表条目。
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @param selector - 账号 id 或昵称。
 * @param options - `force: true` 允许连带清掉当前活跃账号。
 * @returns `{ account, wasActive }`。
 * @throws Error 当目标是当前活跃账号且未加 force 时。
 */
export async function forgetAccount(backend, home, selector, options = {}) {
  const resolved = await resolveAgainst(backend, home, selector)
  if (resolved.account === null) throw new Error(resolved.reason)
  const account = resolved.account

  if (account.active && options.force !== true) {
    throw new Error(
      `账号 ${account.id}（${account.label}）正是当前活跃账号。先切到别的账号，或用 --force 连同 default 一起清掉。`,
    )
  }
  await backend.deleteSlot(account.id)
  if (account.active) await backend.deleteDefault()
  await updateRegistry(home, (current) => removeRegistryAccount(current, account.id))
  // 只回传调用方要的两个字段：整个 registry 会跨线传输，既没必要也无从校验。
  return { account, wasActive: account.active }
}

/**
 * 改昵称。
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @param selector - 账号 id 或昵称。
 * @param label - 新昵称。
 * @returns 更新后的账号记录。
 */
export async function labelAccount(backend, home, selector, label) {
  const resolved = await resolveAgainst(backend, home, selector)
  if (resolved.account === null) throw new Error(resolved.reason)
  const registry = await updateRegistry(home, (current) =>
    renameRegistryAccount(current, resolved.account.id, label),
  )
  return findById(registry, resolved.account.id)
}

/**
 * 总览，供 CLI 一次性打印与插件服务返回。
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @returns {@link listAccounts} 的结果加上后端类型。
 */
export async function overview(backend, home) {
  const listing = await listAccounts(backend, home)
  return { ...listing, backend: backend.kind, home }
}

/**
 * 挑选同一账号的多条记录里该留下的那条。
 *
 * 优先级：当前活跃的 > 最近使用过的 > 加入最晚的。活跃的那条是 default 正指着它，
 * 删掉它等于当场改变登录状态；最近使用的 token 最可能还有效。
 * @param registry - 注册表。
 * @param ids - 同一账号的全部记录 id。
 * @returns 该保留的 id。
 */
function pickSurvivor(registry, ids) {
  const active = ids.find((id) => findById(registry, id)?.id === registry.activeId)
  if (active !== undefined) return active
  return [...ids].sort((left, right) => {
    const a = findById(registry, left)
    const b = findById(registry, right)
    const used = String(b?.lastUsedAt ?? '').localeCompare(String(a?.lastUsedAt ?? ''))
    if (used !== 0) return used
    return String(b?.addedAt ?? '').localeCompare(String(a?.addedAt ?? ''))
  })[0]
}

/**
 * 给账号库里每条记录补上平台身份，并合并同一账号的重复记录。
 *
 * 这是给历史数据用的**一次性修补**：早期按 token 指纹去重，而重新登录会换新 token，
 * 于是同一个账号留下多条记录；那些老记录没有 userId，本地无从分辨。逐条问平台一次
 * 就有答案了——顺带把真实昵称也补上。
 *
 * 合并时只删同一 userId 下的多余记录，且**绝不删当前活跃的那条**。
 *
 * @param backend - 槽位后端。
 * @param home - DSH home。
 * @param options - `lookup` 覆盖查询实现（测试用）；`onProgress` 每条完成时回调；
 *   `dryRun: true` 只报告不落盘（不写 userId、不合并、不改名）。
 * @returns `{ checked, identified, failures, groups, merged, renamed, dryRun }`。
 */
export async function identifyAccounts(backend, home, options = {}) {
  const lookup = options.lookup ?? fetchPlatformIdentity
  const onProgress = options.onProgress
  const dryRun = options.dryRun === true

  const started = loadRegistry(home)
  const report = { checked: 0, identified: 0, failures: [], groups: [], merged: 0, renamed: 0, dryRun }

  /** userId -> 该账号下的全部记录 id。 */
  const byUserId = new Map()
  /** accountId -> 平台返回的昵称。 */
  const names = new Map()

  for (const account of started.registry.accounts) {
    const record = await backend.readSlot(account.id)
    if (record === undefined) {
      report.failures.push({ id: account.id, reason: '槽位为空' })
      continue
    }
    let grant
    try {
      grant = readGrant(record)
    } catch (error) {
      report.failures.push({ id: account.id, reason: error.message })
      continue
    }
    report.checked += 1
    const identity = await lookup(grant.token)
    if (identity.ok !== true) {
      report.failures.push({ id: account.id, reason: identity.reason })
      if (onProgress) onProgress({ id: account.id, ok: false, reason: identity.reason })
      continue
    }
    report.identified += 1
    // 平台上的昵称优先；没设昵称就退回联系方式——平台给的 contact 已是脱敏形式
    // （`159******35`），跟官方账号页显示的是同一个值。
    const displayName = identity.name ?? identity.contact ?? null
    names.set(account.id, displayName)
    const list = byUserId.get(identity.userId) ?? []
    list.push(account.id)
    byUserId.set(identity.userId, list)
    // 改名跟合并是两件事，所以放在这里逐条做，而不是塞进下面的重复组循环里——
    // 那样只会给「有过重复」的账号改名，没重复过的永远拿不到平台昵称。
    let renamed = false
    await updateRegistry(home, (current) => {
      if (dryRun) return undefined
      const existing = findById(current, account.id)
      if (existing === null) return undefined
      const next = { ...existing, userId: identity.userId }
      if (displayName !== null && /^账号 [0-9a-f]+$/.test(existing.label)) {
        next.label = displayName
        renamed = true
      }
      return upsertAccount(current, next)
    })
    if (renamed) report.renamed += 1
    if (onProgress) onProgress({ id: account.id, ok: true, name: displayName })
  }

  for (const [userId, ids] of byUserId) {
    if (ids.length > 1) report.groups.push({ userId, ids: [...ids] })
  }

  for (const group of report.groups) {
    if (dryRun) {
      // 只报告：告诉调用方「这几条是同一个账号」，由它决定是否真的合并。
      report.merged += group.ids.length - 1
      continue
    }
    const survivor = pickSurvivor(loadRegistry(home).registry, group.ids)
    for (const id of group.ids) {
      if (id === survivor) continue
      await backend.deleteSlot(id)
      await updateRegistry(home, (registry) => removeRegistryAccount(registry, id))
      report.merged += 1
    }
  }

  return report
}

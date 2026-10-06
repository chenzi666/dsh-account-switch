/**
 * dsh-account-switch —— Harness 宿主侧插件。
 *
 * 它做的事只有一件，但要做到毫无缝隙：**在官方只认一个槽位的前提下，
 * 让多个账号的 grant 共存，并让切换立即生效。**
 *
 * 官方（`@deepseek-ai/dsh-deepseek-account-platform`）把活跃账号硬编码在
 * `deepseek-account-platform/default`，登录流程直接覆盖它。于是本插件：
 *
 *   1. 启动时把 default 归档进 `deepseek-account-platform/account-<指纹>`；
 *   2. 之后监听 `credentials/record-updated`，每次 default 变化都先抢救旧值、
 *      再归档新值——**顺序不能反**，反了就会在一次重新登录里丢掉上一个账号；
 *   3. 对外提供 `ctx.accountSwitch`，切换就是把目标槽位写回 default。
 *
 * 为什么切换能热生效：`PlatformAccount.resolveToken()` 每个模型请求都重读
 * `default`，没有跨请求缓存；而写入会触发 `credentials/record-updated`，
 * 那个服务自己也监听着这个事件。所以从「写入」到「下一个请求用新 token」
 * 之间没有任何需要重启的环节。
 *
 * @module dsh-account-switch
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { Service } from '@deepseek-ai/cordis'
import { archiveGrant, captureActive, forgetAccount, labelAccount, listAccounts, overview, parkActive, useAccount } from './core.js'
import { accountsDir, resolveDshHome } from './home.js'
import { DEFAULT_KEY, fingerprintOfRecord } from './keys.js'
import { createQuotaSwitch } from './quota-switch.js'
import { createServiceBackend } from './slots.js'

export const name = 'account-switch'

/** 留痕里记录的版本标记。 */
const VERSION = '0.1.0'

/**
 * 本插件**不导出 `default`**，这是硬要求，不是风格偏好。
 *
 * `cordis-plugin-loader` 的 `unwrapExports()` 第一件事就是 `exports.default ?? exports`
 * ——`default` 优先于 `apply`。如果这里挂一个 `export default SomeClass`，loader 会拿那个
 * 类当插件实例化：`super(ctx, ...)` 照常注册服务、**不报任何错**，而 `apply()` 从头到尾
 * 不会被调用。那是完全静默的失败。对照 `dsh-proxy-boot`：它只有 `name` + `apply`，所以正常。
 *
 * 同理这里**不导出 `inject`**：静态 inject 会让插件在依赖不就绪时静默挂起，连「我到底有没有
 * 被加载」都无从判断。改成在 `apply` 里显式 `ctx.inject()`。
 */

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  autoArchiveOnStart: Schema.boolean().default(true),
  autoCaptureOnSignIn: Schema.boolean().default(true),
  /**
   * 额度用尽时自动换号并重跑当前这一步，见 {@link ./quota-switch.js}。
   * 关掉它不影响手动切换，只是回到「额度烧干就中断」的官方行为。
   */
  autoSwitchOnQuota: Schema.boolean().default(true),
  /**
   * 自动换号的失败链记忆时长（毫秒）。
   * 一轮之内试完所有账号就收手交回官方报错；隔得比这久则忘掉旧账——
   * 额度会因充值或周期重置而恢复，旧账不该长期占着一个账号的位置。
   */
  quotaChainResetMs: Schema.number().default(300_000),
  verbose: Schema.boolean().default(false),
  home: Schema.string(),
})

/**
 * 写启动留痕。
 *
 * 这是判断「插件到底有没有被加载」的唯一可靠证据。上面那条注释描述的静默失败，
 * 与「插件根本没进加载列表」在外部表现上一模一样：都没有产物、都没有报错。
 * 留痕写在任何依赖之前，因此它存在就等于 `apply` 真的被 cordis 调用了。
 *
 * @param home - DSH home。
 * @param detail - 追加信息。
 */
function writeLoadProbe(home, detail) {
  try {
    const dir = accountsDir(home)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(dir, 'load-probe.json'),
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: VERSION, ...detail }, null, 2)}\n`,
      { mode: 0o600 },
    )
  } catch (error) {
    process.stderr.write(`[account-switch] 无法写入启动留痕：${error?.message}\n`)
  }
}

/**
 * 记一条自动换号流水。
 *
 * 换号是**用户看不见的副作用**：会话若无其事地接着跑，而 `default` 已经悄悄换了人。
 * 不留痕的话，事后想查「账号怎么自己变了」会完全没有头绪——所以每次自动切换追加
 * 一行 JSON 到 `$DSH_HOME/accounts/quota-switch.log`。
 *
 * 只追加、不重写（切号可能连着发生），且任何失败都吞掉：留痕是给人看的，
 * 不能让它的异常反过来打断恢复流程。
 *
 * @param home - DSH home。
 * @param entry - 要记录的事件。
 */
function appendSwitchLog(home, entry) {
  try {
    const dir = accountsDir(home)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(join(dir, 'quota-switch.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 })
  } catch (error) {
    process.stderr.write(`[account-switch] 无法写入换号流水：${error?.message}\n`)
  }
}

/**
 * 对外服务：`ctx.accountSwitch`。
 *
 * 方法全部薄封装到 `core.js`，因为 CLI 走的是同一批函数。逻辑只有一份，
 * 两个入口不会漂移。
 */
class AccountSwitch extends Service {
  /**
   * @param ctx - cordis 上下文。
   * @param deps - `{ backend, home, config }`。
   */
  constructor(ctx, deps) {
    super(ctx, 'accountSwitch')
    this.backend = deps.backend
    this.home = deps.home
    this.config = deps.config
  }

  /** @returns 账号总览，含 `accounts`、`activeId`、`warnings`。 */
  overview() {
    return overview(this.backend, this.home)
  }

  /** @returns `{ account, created, fingerprint }`。 */
  capture() {
    return captureActive(this.backend, this.home)
  }

  /**
   * 切换活跃账号。
   * @param selector - 账号 id 或昵称。
   * @returns `{ account, previous, noop }`。
   */
  use(selector) {
    return useAccount(this.backend, this.home, selector)
  }

  /**
   * 归档当前活跃账号并从 default 撤下，腾出位置登录下一个账号。
   * @returns `{ account, parked }`。
   */
  park() {
    return parkActive(this.backend, this.home)
  }

  /**
   * 从账号库移除一个账号。
   * @param selector - 账号 id 或昵称。
   * @param options - `force` 允许连同活跃账号一起清掉。
   */
  forget(selector, options) {
    return forgetAccount(this.backend, this.home, selector, options)
  }

  /**
   * 改昵称。
   * @param selector - 账号 id 或昵称。
   * @param label - 新昵称。
   */
  rename(selector, label) {
    return labelAccount(this.backend, this.home, selector, label)
  }
}

/**
 * credentials 就绪之后的实际启动。
 * @param ctx - 已保证 `ctx.credentials` 可用的上下文。
 * @param home - DSH home。
 * @param config - 已解析的配置。
 */
function start(ctx, home, config) {
  const backend = createServiceBackend(ctx)
  const logger = ctx.logger

  // 诊断：TYPERT 清单注册这条链上有两个静默的失败点，从浏览器端看它们是同一句
  // 「命名空间没有注册」。这里把两个前提直接测出来写进留痕——
  //   1. typert-loader 拿 ctx.baseUrl 作锚点去 require.resolve 插件包；锚点不对，
  //      它就静默跳过这个 entry，宿主侧不给任何提示。
  //   2. 注册结果落在 typert 的本地 registry 里；我的 endpoint 不在，就是清单没进去。
  const diagnostics = { anchor: typeof ctx.baseUrl === 'string' ? ctx.baseUrl : '(unset)' }
  try {
    const anchorRequire = createRequire(ctx.baseUrl ?? import.meta.url)
    diagnostics.selfResolve = anchorRequire.resolve('dsh-account-switch/package.json')
  } catch (error) {
    diagnostics.selfResolve = `失败 ${error?.code ?? ''}: ${String(error?.message ?? error).slice(0, 140)}`
  }
  try {
    const typert = ctx.get('typert')
    diagnostics.typert = typert === undefined ? '服务缺失' : '服务在位'
    const store = typert?.localStore ?? typert?.local
    if (typeof store?.list === 'function') {
      const all = store.list()
      diagnostics.endpointTotal = all.length
      // 匹配用包名而不是命名空间：endpoint id 形如 `<包名>#<方法>`，
      // 拿 camelCase 的命名空间去搜永远搜不到，会假报「不在册」。
      const ids = all.map((entry) => String(entry?.endpoint ?? entry?.id ?? entry))
      diagnostics.mine = ids.filter((text) => text.includes('dsh-account-switch'))
      diagnostics.sample = ids.slice(0, 6)
    } else {
      diagnostics.endpointTotal = '（没有 list()）'
    }
  } catch (error) {
    diagnostics.typert = `查询抛错: ${String(error?.message ?? error).slice(0, 140)}`
  }
  writeLoadProbe(home, { enabled: true, home, autoSwitchOnQuota: config.autoSwitchOnQuota, ...diagnostics })

  /** 串行化：事件可能连发，归档必须逐个落地，否则 lastSeen 会打架。 */
  let queue = Promise.resolve()
  const enqueue = (task) => {
    const run = queue.then(task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 上一次见到的 default 内容与指纹，用于在覆盖发生的那一刻抢救旧账号。 */
  let lastSeen
  let lastSeenFingerprint = null

  /**
   * 读当前活跃账号的平台身份：userId 与昵称。
   *
   * 这是去重的关键——token 每次重新登录都换新，指纹跟着变，只有 userId 不变。
   * 取不到一律返回 undefined 而不是抛错：这是增强信息，缺了它退回指纹去重即可，
   * 不该挡住归档。
   * @param reason - 触发来源，仅用于日志。
   * @returns `{ userId?, label? }`，或 undefined。
   */
  async function readIdentity(reason) {
    try {
      const account = ctx.get('deepseekAccount')
      if (account === undefined || typeof account.getProfile !== 'function') return undefined
      const result = await account.getProfile({
        version: '0.2.0-rc.2',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      const value = result === null || result === undefined ? undefined : result.value
      if (value === null || value === undefined) return undefined
      const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : undefined
      const contact = typeof value.contact === 'string' && value.contact.length > 0 ? value.contact : undefined
      return {
        userId: typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined,
        // 平台昵称优先；没设就退回联系方式——它已是脱敏形式（`159******35`），
        // 与官方账号页显示的是同一个值。
        label: name ?? contact,
      }
    } catch (error) {
      if (config.verbose) {
        logger.warn('[account-switch] 读取账号资料失败，本次按指纹归档（%s）：%s', reason, error?.message ?? String(error))
      }
      return undefined
    }
  }

  /**
   * 一次 default 变化。两步有严格顺序：先抢救旧值，再归档新值。
   * @param reason - 触发来源，仅用于日志。
   */
  async function reconcile(reason) {
    const next = await backend.readDefault()
    const nextFingerprint = fingerprintOfRecord(next)

    if (lastSeen !== undefined && lastSeenFingerprint !== null && lastSeenFingerprint !== nextFingerprint) {
      try {
        const saved = await archiveGrant(backend, home, lastSeen, { setActive: false })
        if (config.verbose) {
          logger.info('[account-switch] 抢救上一个账号 %s（%s）', saved.account?.id, reason)
        }
      } catch (error) {
        logger.warn('[account-switch] 旧账号抢救失败：%s', error.message)
      }
    }

    if (next !== undefined && config.autoCaptureOnSignIn) {
      try {
        const identity = await readIdentity(reason)
        const result = await archiveGrant(backend, home, next, {
          setActive: true,
          userId: identity?.userId,
          label: identity?.label,
        })
        if (result.created) {
          logger.info('[account-switch] 入库新账号 %s（%s）', result.account?.id, result.account?.label)
        }
        if (result.merged > 0) {
          logger.info('[account-switch] 合并了 %d 条同一账号的重复记录', result.merged)
        }
      } catch (error) {
        // 记录形状不对时只告警：坏 record 归官方处理，本插件不替它做决定。
        logger.warn('[account-switch] 归档当前账号失败：%s', error.message)
      }
    }

    lastSeen = next
    lastSeenFingerprint = nextFingerprint
  }

  ctx.on('credentials/record-updated', (key) => {
    if (String(key) !== DEFAULT_KEY) return
    enqueue(() => reconcile('default 变化')).catch((error) => {
      logger.warn('[account-switch] 处理凭证变化失败：%s', error.message)
    })
  })

  const service = new AccountSwitch(ctx, { backend, home, config })

  /*
   * 额度用尽 → 自动换号 → 重跑这一步。
   *
   * 挂的是官方为「请求失败后要不要重来」留的扩展点，`dsh-llm-retry` 与两个 compaction
   * 插件都挂在同一处。契约是 waterfall：不关心的错误码必须 `next()` 传下去，而返回
   * `{ kind: 'retry' }` 会让 agent-loop `continue`——重跑这一步，`resolveToken()` 重读
   * `default`，新账号的 token 自然生效，而会话上下文、消息队列与工具状态一动不动。
   *
   * 切换动作走 `enqueue`：本插件里所有改 `default` 的动作都在同一条串行队列上，
   * 否则自动换号会与「登录新账号」的归档互相覆盖。
   */
  if (config.autoSwitchOnQuota) {
    const quota = createQuotaSwitch({
      list: () => listAccounts(backend, home),
      use: (id) => enqueue(() => useAccount(backend, home, id)),
      logger,
      resetAfterMs: config.quotaChainResetMs,
      onSwitch: ({ account, failure, payload }) =>
        appendSwitchLog(home, {
          event: 'quota-switch',
          to: account.id,
          label: account.label ?? null,
          code: failure.code,
          status: failure.status ?? null,
          provider: payload?.provider ?? null,
          agent: payload?.agent?.id ?? null,
          turn: payload?.turn ?? null,
          step: payload?.step ?? null,
        }),
    })
    ctx.on('agent/request-error', (payload, next) => quota.handle(payload, next))
    logger.info('[account-switch] 额度用尽自动换号已就绪（失败链记忆 %sms）', config.quotaChainResetMs)
  }

  // 两条独立的链，都结束后**写一次**留痕——分头写会互相覆盖，而且覆盖顺序还不确定。
  //
  // 1) 自己把清单交给 typert registry。
  //    不依赖 `dsh-typert-loader` 去发现它：那个插件属于 `dsh-base` bundle，用的是 bundle 的
  //    `ctx.baseUrl` 作解析锚点，而这份清单在一个 profile 本地包里——它 resolve 不到，于是走
  //    它自己的静默分支（`artifactPath.set(name, null); return null`）跳过，宿主侧不留痕迹。
  //    浏览器端于是永远长不出 `remote.accountSwitch`。直接从自己的 ctx 注册，没有猜测余地。
  //
  // 2) 浏览器端的 Remote 门面。它只用 @deepseek-ai/cordis，不碰内核内部包；即便挂载失败，
  //    浏览器那边也只是显示一行「服务未就绪」——客户端的 inject 里不再包含它，所以挂不上
  //    也不会把 web boot 拖垮（那正是上一次崩溃的成因）。
  const registerManifest = import('./typert.host.js').then(({ TYPERT }) => {
    const typert = ctx.get('typert')
    if (typert === undefined) throw new Error('typert 服务缺失')
    typert.register(TYPERT)
    return 'ok'
  })

  const mountRemote = import('./remote.js').then(({ AccountSwitchController }) => {
    const controller = new AccountSwitchController(ctx, service)
    return { serviceKey: controller.name, namespace: controller.typertRemote?.namespace }
  })

  Promise.allSettled([registerManifest, mountRemote]).then(([manifestResult, remoteResult]) => {
    const brief = (outcome) =>
      outcome.status === 'fulfilled'
        ? undefined
        : String(outcome.reason?.message ?? outcome.reason).slice(0, 200)

    writeLoadProbe(home, {
      enabled: true,
      home,
      /*
       * 这一次是**整体覆盖**，所以先前那次写的字段必须在这里再带一遍。
       * 少了它，留痕里就看不到自动换号策略，排查时会误判成「策略根本没装上」。
       */
      autoSwitchOnQuota: config.autoSwitchOnQuota,
      ...diagnostics,
      typertRegister: manifestResult.status === 'fulfilled' ? manifestResult.value : `失败: ${brief(manifestResult)}`,
      remote: remoteResult.status === 'fulfilled' ? 'mounted' : 'failed',
      ...(remoteResult.status === 'fulfilled' ? remoteResult.value : { remoteError: brief(remoteResult) }),
    })

    if (manifestResult.status === 'rejected') {
      logger.warn('[account-switch] TYPERT 清单注册失败，浏览器端账号页将不可用：%s', brief(manifestResult))
    }
    if (remoteResult.status === 'rejected') {
      logger.warn('[account-switch] Remote 门面未挂载，浏览器端账号页将显示服务未就绪：%s', brief(remoteResult))
    }
  })

  // 启动归档：在插件接管之前就可能已经有一个登录着的账号，先把它钉进库里，
  // 否则用户第一次登录新账号就会把它顶掉且再也找不回来。
  enqueue(async () => {
    const current = await backend.readDefault()
    lastSeen = current
    lastSeenFingerprint = fingerprintOfRecord(current)
    if (current === undefined) return
    if (!config.autoArchiveOnStart) return
    try {
      // 启动这次也顺手补身份：老记录里可能没有 userId，补上之后才谈得上去重，
      // 而这里是「当前活跃账号的资料一定能取到」的时机。
      const identity = await readIdentity('启动归档')
      const result = await archiveGrant(backend, home, current, {
        setActive: true,
        userId: identity?.userId,
        label: identity?.label,
      })
      logger.info('[account-switch] 已归档当前账号 %s（%s）', result.account?.id, result.account?.label)
      if (result.merged > 0) {
        logger.info('[account-switch] 合并了 %d 条同一账号的重复记录', result.merged)
      }
    } catch (error) {
      logger.warn('[account-switch] 启动归档失败：%s', error.message)
    }
  }).catch((error) => {
    logger.warn('[account-switch] 启动初始化失败：%s', error.message)
  })

  return service
}

/**
 * 插件入口。
 * @param ctx - cordis 上下文。
 * @param config - 见 {@link Config}。
 */
export function apply(ctx, config) {
  let resolved
  try {
    resolved = Config(config ?? {})
  } catch (error) {
    // 配置不合法时更要留痕：那又是一次「插件在，但什么都没发生」的静默失败。
    writeLoadProbe(resolveDshHome(), { enabled: false, configError: String(error?.message ?? error) })
    throw error
  }
  const home = resolveDshHome(resolved.home)

  // 无条件留痕：在 apply 被调用的第一时间证明它，早于任何可能失败的依赖。
  writeLoadProbe(home, { enabled: resolved.enabled, home })

  if (!resolved.enabled) return

  ctx.inject(['credentials'], (scope) => {
    try {
      start(scope, home, resolved)
    } catch (error) {
      scope.logger.warn('[account-switch] 启动失败：%s', error?.message ?? String(error))
    }
  })
}

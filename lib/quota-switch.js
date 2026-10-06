/**
 * 额度耗尽时的自动切号。
 *
 * 症结：账号是**进程级单例**，额度也是账号级的。当前账号额度烧干时，官方行为是
 * 把这次请求判成失败，整个 turn 就此中断——人得切个号再重说一遍。而切号本身是
 * 瞬时的（见 core.js），缺的只是「谁去发现这件事、谁来按这个按钮」。
 *
 * 官方留了那个按钮。`dsh-agent-loop` 在模型请求失败后广播 `agent/request-error`，
 * 把「这次要不要重来」交给插件链决定：
 *
 * ```js
 * const action = await this.dispatch.waterfall('agent/request-error', { ...payload }, () => Promise.resolve(void 0))
 * if (action?.kind !== 'retry') throw new LlmError(failure.message, failure.code, failure)
 * continue   // ← 重跑这一步
 * ```
 *
 * 官方 `dsh-llm-retry` 正是挂在这个点上做退避重试的；两个 compaction 插件也挂在
 * 同一处，且对不关心的错误码一律 `return next()`，所以这条链上不会有人截断我们。
 *
 * 于是全部动作就是：听到额度错误 → 换一个还没烧干的账号 → 回一个 `{ kind: 'retry' }`。
 * 重跑时 `PlatformAccount.resolveToken()` 会重读 `default`，拿到的已经是新账号的
 * token，会话上下文、消息队列、工具状态全都不动——**任务不中断，只是换了个钱包**。
 *
 * 错误码由官方定义，不靠猜：`dsh-llm` 的 `QUOTA_EXCEEDED_CODE = 'QUOTA'`
 * （`status === 402`，或响应文本命中 `insufficient balance` / `quota exceeded`
 * 一类的措辞），账号 provider 再把它映射成 `ACCOUNT_QUOTA_EXCEEDED_CODE`。
 * 两个都要认：前者是通用码，后者是账号侧专用的。
 *
 * @module dsh-account-switch/quota-switch
 */

/**
 * 额度错误码，**刻意写成字面量而不是 import 内核包**。
 *
 * 值本身是稳定契约，不是内部实现细节：客户端 UI 也在硬编码比对它们
 * （`dsh-client-ui-chat` 里 `code === "QUOTA" || code === "ACCOUNT_QUOTA"` 才显示
 * 「当前请求的额度已用尽」），所以这几个字符跨进程、跨版本都得是这一串。
 *
 * 而 `@deepseek-ai/dsh-llm` 并不在本插件的依赖里（sync-install.ps1 只带 yaml 与 zod），
 * 靠 Harness 的模块解析层去够内核包是**未经验证**的路径——够不到会让整个插件加载失败，
 * 代价远大于省下两个字符串。
 */
export const ACCOUNT_QUOTA_CODE = 'ACCOUNT_QUOTA'
export const QUOTA_CODE = 'QUOTA'

/** 认作「这个账号没钱了」的错误码。 */
export const DEFAULT_QUOTA_CODES = Object.freeze([ACCOUNT_QUOTA_CODE, QUOTA_CODE])

/** 失败链记忆的默认时长。 */
const DEFAULT_RESET_AFTER_MS = 300_000

/** 失败链最多保留多少个会话，超出时清掉已全过期的那些。 */
const MAX_CHAINS = 256

/**
 * 取这次失败属于哪个会话。
 *
 * `agent.id` 是会话的稳定标识；拿不到就退回到一个共享槽位——那退化成「全局一条链」，
 * 只会更保守（更早收手），不会更激进。
 * @param payload - `agent/request-error` 的载荷。
 * @returns 链的键。
 */
function chainKeyOf(payload) {
  const id = payload?.agent?.id
  return typeof id === 'string' && id.length > 0 ? id : '(unnamed-agent)'
}

/**
 * 建一个额度切换器。
 *
 * 依赖全部注入，方便在事务之外测：真跑时 `list` / `use` 来自 core.js，
 * 测试时传两个纯函数即可，不碰任何文件。
 *
 * @param options - `list()` 读账号总览，`use(id)` 执行切换，`logger` 日志，
 *   `codes` 认作额度耗尽的错误码，`resetAfterMs` 单个账号的冷却时长，
 *   `now` 可注入的时钟，`onSwitch` 切换成功后的回调（用于留痕/上报）。
 * @returns `{ handle, chains, reset }`；`handle` 就是 `agent/request-error` 的处理函数。
 */
export function createQuotaSwitch(options) {
  const {
    list,
    use,
    logger,
    codes = DEFAULT_QUOTA_CODES,
    resetAfterMs = DEFAULT_RESET_AFTER_MS,
    now = () => Date.now(),
    onSwitch,
  } = options

  /**
   * 键 → `{ tried: Map<账号 id, 该账号最近一次被判没钱的时间> }`。
   *
   * 记忆是**逐账号带时间戳**的，而不是一份「本轮试过」的集合——差别在两件真实会发生的事上：
   *
   *   1. **充值之后。** 充了值那个账号就活了，可集合式记忆会一直把它挡在外面；
   *      带时间戳则过了冷却就自动重新可用。
   *   2. **外侧还有别人重试。** `dsh-llm-retry` 在 `mode: 'always'` 下也会重跑，
   *      此时「试完一轮就清空」等于允许再切一轮，而对象还是同样几个烧干的账号——
   *      白切一圈，还可能来回横跳。带时间戳则同一批账号在冷却期内不会被重复选中。
   *
   * 为什么按 agent 分链：切换是全局的（官方只有 `default` 一个槽位），但**发现**额度
   * 耗尽却是每个会话各自的事，分开记才不会让并发跑着的几个会话互相清掉对方的记忆。
   */
  const chains = new Map()

  const warn = (message, ...args) => {
    try {
      logger?.warn?.(message, ...args)
    } catch {
      /* 日志失败不该影响恢复流程 */
    }
  }
  const info = (message, ...args) => {
    try {
      logger?.info?.(message, ...args)
    } catch {
      /* 同上 */
    }
  }

  /**
   * 取某个会话的失败链；顺手丢掉已全过期的链，避免长跑实例里越攒越多。
   * @param key - 链的键。
   * @param stamp - 本次失败的时间戳。
   * @returns 失败链记录。
   */
  function chainFor(key, stamp) {
    if (chains.size > MAX_CHAINS) {
      for (const [other, entry] of chains) {
        if ([...entry.tried.values()].every((at) => stamp - at > resetAfterMs)) chains.delete(other)
      }
    }
    let entry = chains.get(key)
    if (entry === undefined) {
      entry = { tried: new Map() }
      chains.set(key, entry)
    }
    return entry
  }

  /**
   * 某个账号是否还在冷却里（最近刚被判过没钱）。
   * @param chain - 失败链。
   * @param id - 账号 id。
   * @param stamp - 当前时间。
   * @returns 仍在冷却中则为 true。
   */
  function coolingDown(chain, id, stamp) {
    const at = chain.tried.get(id)
    return at !== undefined && stamp - at <= resetAfterMs
  }

  /**
   * 处理一次模型请求失败。
   *
   * 不是额度错误就原样交给下一个（官方重试、上下文压缩都在链上等着）。
   * @param payload - `{ agent, turn, step, provider, failure, retryPolicy, signal }`。
   * @param next - 链上的下一个处理者。
   * @returns `{ kind: 'retry' }` 表示换号后重跑这一步；`next()` 的返回值表示不干预。
   */
  async function handle(payload, next) {
    const failure = payload?.failure
    if (failure === undefined || !codes.includes(String(failure.code))) return next()
    // 用户已经取消/中断：这时候换号重试等于把人的操作覆盖掉。
    if (payload.signal?.aborted === true) return next()

    const key = chainKeyOf(payload)
    const stamp = now()
    const chain = chainFor(key, stamp)

    let listing
    try {
      listing = await list()
    } catch (error) {
      warn('[account-switch] 额度切换：读账号库失败，交回官方处理：%s', error?.message ?? String(error))
      return next()
    }

    const accounts = Array.isArray(listing?.accounts) ? listing.accounts : []
    const activeId = typeof listing?.activeId === 'string' ? listing.activeId : null
    // 活跃账号就是刚被判没钱的这一个，直接进冷却，不必再读一次它的余额。
    if (activeId !== null) chain.tried.set(activeId, stamp)

    // 槽位缺失的账号切过去必炸（core.useAccount 会明确拒绝），这里先剔掉。
    const candidates = accounts.filter(
      (account) =>
        account?.id !== undefined &&
        account.archived !== false &&
        account.id !== activeId &&
        !coolingDown(chain, account.id, stamp),
    )
    if (candidates.length === 0) {
      // 没有可换的账号（本来就只有一个人，或其余都在冷却里）：不干预，
      // 让官方把这次失败如实报出去。记忆留着——它到期会自己失效。
      return next()
    }

    for (const account of candidates) {
      try {
        const result = await use(account.id)
        chain.tried.set(account.id, stamp)
        if (result?.noop === true) continue
        info(
          '[account-switch] 账号额度用尽，已切到 %s（%s），本步将自动重跑',
          account.id,
          account.label ?? '未命名',
        )
        try {
          onSwitch?.({ account, failure, payload })
        } catch {
          /* 留痕失败不该让恢复失败 */
        }
        return { kind: 'retry' }
      } catch (error) {
        // 这个账号切不过去（槽位坏了、记录不可读）：记进冷却，继续试下一个。
        chain.tried.set(account.id, stamp)
        warn('[account-switch] 切到 %s 失败，继续尝试其余账号：%s', account.id, error?.message ?? String(error))
      }
    }

    return next()
  }

  /** 清掉全部失败链（测试与手动复位用）。 */
  function reset() {
    chains.clear()
  }

  return { handle, chains, reset }
}

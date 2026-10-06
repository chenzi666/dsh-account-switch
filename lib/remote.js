/**
 * 浏览器端要用的 Remote 门面。
 *
 * 为什么单独一层：`ctx.accountSwitch` 是给宿主侧插件用的普通 cordis 服务，
 * 而浏览器只能通过 Typert Gateway 的 wire namespace 访问 Host。两者形状不同——
 * 前者可以返回任何值、可以抛任何错，后者只能传 JSON 且要显式标记哪些方法上线路。
 * 与其让一个服务同时扮演两个角色，不如把门面单独摆出来，语义各自清楚。
 *
 * **为什么不 import `@deepseek-ai/dsh-typert-protocol`**：那是内核内部包，
 * profile 插件的模块解析范围未必覆盖它。实测上，import 失败会让整个 remote 服务
 * 缺席，而浏览器端一旦 inject 了那个缺席的服务就会永远 pending —— DSH 的 web boot
 * 要求每条 entry 都 activate，一条 pending 就足以让整个界面启不起来。
 * 所以这里只用确定可用的 `@deepseek-ai/cordis`，把协议那点约定照抄下来：
 *
 *   1. 服务上挂一个 `typertRemote = { service, serviceKey, namespace }`，
 *      Gateway 的 source-mode discovery 就是靠读它；
 *   2. 类原型上写 `REMOTE_METHOD_DESCRIPTOR`，值形如 `{ version: 1, methods: [...] }`，
 *      逐条声明哪些方法可远程调用。协议注释明写这套绑定
 *      "carries no compiler-injected metadata"，所以手写与装饰器等价。
 *
 * @module dsh-account-switch/remote
 */

import { Service } from '@deepseek-ai/cordis'

/** 与协议内部同名的原型属性键；改这里就等于改协议约定。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 允许从浏览器调用的方法。顺序即声明顺序，协议按它枚举。 */
const REMOTE_METHODS = Object.freeze(['overview', 'use', 'park', 'capture', 'rename', 'forget'])

/**
 * `accountSwitch` wire namespace 的 Host 实现。
 *
 * 每个方法都是一层直通：真正的逻辑在 {@link AccountSwitch} 里，与 CLI 共用同一份
 * `core.js`。这里不做任何校验或兜底——CLI 走的那条路和浏览器走的那条路必须对同一批
 * 文件给出同一套结果，多在门面上加一层判断就多一处漂移点。
 */
class AccountSwitchController extends Service {
  /**
   * @param ctx - cordis 上下文。
   * @param service - 宿主侧的账号服务实例。
   */
  constructor(ctx, service) {
    super(ctx, 'accountSwitchRemote')
    this.service = service
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: this.name,
      namespace: 'accountSwitch',
    })
    // 与协议同源的一行：让 Remote 调用之外的 ctx.invocation 读作 undefined，
    // 而不是抛「cannot get property」。拿不到 reflect 就跳过——它只影响报错措辞。
    try {
      if (!Object.hasOwn(ctx.root.reflect.props, 'invocation')) {
        ctx.root.accessor('invocation', { get: () => undefined })
      }
    } catch {
      /* 无关紧要，继续 */
    }
  }

  /** @returns 账号总览，含 `accounts`、`activeId`、`warnings`。 */
  overview() {
    return this.service.overview()
  }

  /**
   * 切换活跃账号。
   * @param selector - 账号 id 或昵称。
   */
  use(selector) {
    return this.service.use(selector)
  }

  /** 归档当前账号并从 default 撤下，腾出位置登录下一个。 */
  park() {
    return this.service.park()
  }

  /** 归档当前活跃账号（幂等）。 */
  capture() {
    return this.service.capture()
  }

  /**
   * 改昵称。
   * @param selector - 账号 id 或昵称。
   * @param label - 新昵称。
   */
  rename(selector, label) {
    return this.service.rename(selector, label)
  }

  /**
   * 从账号库移除。
   * @param selector - 账号 id 或昵称。
   * @param options - `{ force }` 允许连同活跃账号一起清掉。
   */
  forget(selector, options) {
    return this.service.forget(selector, options)
  }
}

// 手写远程标记，等价于给上面六个方法各加一个 `@Remote`。
Object.defineProperty(AccountSwitchController.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(
      REMOTE_METHODS.map((method) =>
        Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }),
      ),
    ),
  }),
})

export { AccountSwitchController }

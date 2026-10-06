/**
 * Typert 的 host face 清单。
 *
 * **没有这个文件，浏览器端就看不见 `accountSwitch` 这个命名空间。** 这不是可选装饰：
 * `dsh-typert-loader` 从包的 `exports["./typert"]` 取这份清单，`ctx.typert.register()`
 * 用它建立端点目录，客户端再从目录里长出 `remote.<namespace>` 服务。没有清单，服务
 * 在宿主侧注册得再正确，浏览器也拿不到——之前那次「账号服务未就绪」就是缺了它。
 *
 * 清单里每一样都要跟运行时严格对齐：
 *   - `invocations[].service` 必须是构造函数里 `super(ctx, '<key>')` 的那个 key；
 *   - 每个参数与结果都要给 `mode: 'strict'` 的 codec，`create()` 返回 zod schema；
 *   - `model.services[]` 的 members/types 是人看的文档（signature、jsDoc、declaration），
 *     校验只要求它们存在且成形，不参与运行时。
 *
 * schema 按 JSON 往返后的形状写：`undefined` 会在序列化时消失，所以可缺省的字段一律
 * 用 `.nullable()` / `.optional()`，不去赌某个字段一定在。
 *
 * @module dsh-account-switch/typert
 */

import { z } from 'zod'

/** 清单归属的包名；必须与 package.json 的 name 一致，校验会逐字比对。 */
const PACKAGE = 'dsh-account-switch'

/** 构造函数里注册的服务 key。 */
const SERVICE_KEY = 'accountSwitchRemote'

/** 线上命名空间，浏览器侧就是 `remote.accountSwitch`。 */
const NAMESPACE = 'accountSwitch'

/* ── schema 工厂：每个 codec 持有一个惰性的 create() ─────────────────────── */

/** 账号档案。`active` / `archived` 只有列表路径会补上，别处可能缺席。 */
const Account = () =>
  z.object({
    id: z.string(),
    fingerprint: z.string(),
    label: z.string(),
    issuer: z.string().nullable(),
    addedAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    switchCount: z.number(),
    active: z.boolean().optional(),
    archived: z.boolean().optional(),
  })

const Overview = () =>
  z.object({
    accounts: z.array(Account()),
    activeId: z.string().nullable(),
    warnings: z.array(z.string()),
    defaultState: z.string(),
    defaultReason: z.string().nullable(),
    backend: z.string(),
    home: z.string(),
  })

const Selector = () => z.string()

const UseResult = () =>
  z.object({
    account: Account(),
    previous: Account().nullable(),
    noop: z.boolean(),
  })

const ParkResult = () =>
  z.object({
    account: Account().nullable(),
    parked: z.boolean(),
  })

const CaptureResult = () =>
  z.object({
    account: Account().nullable(),
    created: z.boolean(),
    fingerprint: z.string().nullable(),
  })

const ForgetResult = () =>
  z.object({
    account: Account(),
    wasActive: z.boolean(),
  })

/** 用一个 ZodType 造 codec，`<endpoint>:<field>` 是它在线上的唯一名字。 */
function strictCodec(endpoint, field, create) {
  return {
    mode: 'strict',
    typeSymbol: `${PACKAGE}#${endpoint}:${field}`,
    create,
  }
}

/** 造一条 invocation，省得六个方法把同样的形状抄六遍。 */
function direct(id, method, parameters, result) {
  return {
    id: `${PACKAGE}#${id}`,
    service: SERVICE_KEY,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(([name, create]) => ({
      name,
      wire: name,
      source: 'json',
      codec: strictCodec(id, name, create),
    })),
    result: strictCodec(id, 'result', result),
  }
}

/** 六个方法的文档条目。校验要求 kind 属于已知集合、name 与 signature 非空。 */
function member(name, signature, summary) {
  return { kind: 'method', name, signature, summary }
}

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    direct('overview', 'overview', [], Overview),
    direct('use', 'use', [['selector', Selector]], UseResult),
    direct('park', 'park', [], ParkResult),
    direct('capture', 'capture', [], CaptureResult),
    direct('rename', 'rename', [['selector', Selector], ['label', Selector]], Account),
    direct('forget', 'forget', [['selector', Selector], ['options', () => z.object({ force: z.boolean().optional() }).optional()]], ForgetResult),
  ],
  model: {
    services: [
      {
        tags: [],
        key: SERVICE_KEY,
        exportName: 'AccountSwitchController',
        summary: 'Host service backing the generated `ctx.remote.accountSwitch` namespace.',
        members: [
          member('overview', '@Remote overview(): Overview', 'List every stored account plus which one is currently active.'),
          member('use', '@Remote use(selector: string): UseResult', 'Make one stored account the active one, filing the previous one first.'),
          member('park', '@Remote park(): ParkResult', 'File the active account and detach it, so another account can be signed in.'),
          member('capture', '@Remote capture(): CaptureResult', 'File the active account into the store (idempotent).'),
          member('rename', '@Remote rename(selector: string, label: string): Account', 'Give one account a display name.'),
          member('forget', '@Remote forget(selector: string, options?: { force?: boolean }): ForgetResult', 'Drop one account from the store.'),
        ],
        types: [
          {
            name: 'Account',
            declaration:
              'export interface Account {\n    id: string;\n    fingerprint: string;\n    label: string;\n    issuer: string | null;\n    addedAt: string | null;\n    lastUsedAt: string | null;\n    switchCount: number;\n    active?: boolean;\n    archived?: boolean;\n}',
          },
          {
            name: 'Overview',
            declaration:
              'export interface Overview {\n    accounts: Account[];\n    activeId: string | null;\n    warnings: string[];\n    defaultState: string;\n    defaultReason: string | null;\n    backend: string;\n    home: string;\n}',
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
}

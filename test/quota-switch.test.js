import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ACCOUNT_QUOTA_CODE, QUOTA_CODE, createQuotaSwitch } from '../lib/quota-switch.js'

/**
 * 一份账号总览。默认 A 活跃、B/C 在库里且在存档槽位上。
 * @param activeId - 当前活跃账号 id。
 * @param ids - 账号 id 列表。
 * @returns 形态与 core.listAccounts() 一致的对象。
 */
function makeListing(activeId, ids) {
  return {
    activeId,
    accounts: ids.map((id) => ({
      id,
      label: `账号 ${id}`,
      active: id === activeId,
      archived: true,
    })),
    warnings: [],
  }
}

/**
 * 一个可推进的假账号库：记住活跃账号与切换历史，不碰任何文件。
 * @param ids - 账号 id 列表，第一个为初始活跃账号。
 * @returns `{ list, use, switched, active, setActive }`。
 */
function fakeBook(ids) {
  let active = ids[0]
  const switched = []
  return {
    list: async () => makeListing(active, ids),
    use: async (id) => {
      switched.push(id)
      active = id
      return { account: { id }, noop: false }
    },
    switched,
    get active() {
      return active
    },
    setActive(id) {
      active = id
    },
  }
}

/**
 * 一次模型请求失败的载荷。
 * @param code - 失败码。
 * @param overrides - 覆盖字段（如 `agent`、`signal`）。
 * @returns `agent/request-error` 的载荷。
 */
function failurePayload(code = ACCOUNT_QUOTA_CODE, overrides = {}) {
  return {
    agent: { id: 'agent-1' },
    turn: 1,
    step: 1,
    provider: 'deepseek-account',
    failure: { message: 'Insufficient Balance', code },
    signal: new AbortController().signal,
    ...overrides,
  }
}

/**
 * 记录被调用次数的假 next。
 * @param value - next 的返回值。
 * @returns `{ next, calls }`。
 */
function recorder(value) {
  const calls = []
  return {
    next: async () => {
      calls.push(1)
      return value
    },
    calls,
  }
}

test('额度用尽：切到下一个账号并让这一步重跑', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb'])
  const quota = createQuotaSwitch({ list: book.list, use: book.use, now: () => 0 })
  const { next, calls } = recorder()

  const action = await quota.handle(failurePayload(), next)

  assert.deepEqual(action, { kind: 'retry' }, '必须回 retry，agent-loop 才会 continue')
  assert.deepEqual(book.switched, ['acct-bbbb'], '只切一次，且切到另一个账号')
  assert.equal(calls.length, 0, '既然自己处理了，就不该再往链上抛')
})

test('通用配额码 QUOTA 同样认作额度用尽', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb'])
  const quota = createQuotaSwitch({ list: book.list, use: book.use, now: () => 0 })

  const action = await quota.handle(failurePayload(QUOTA_CODE), recorder().next)

  assert.deepEqual(action, { kind: 'retry' })
  assert.deepEqual(book.switched, ['acct-bbbb'])
})

test('非额度错误原样交给链上的下一个处理者', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb'])
  const quota = createQuotaSwitch({ list: book.list, use: book.use, now: () => 0 })
  const { next, calls } = recorder({ kind: 'retry' })

  for (const code of ['RATE_LIMIT', 'SERVER', 'CONTEXT_WINDOW_EXCEEDED', 'ACCOUNT_TOKEN_INVALID']) {
    const action = await quota.handle(failurePayload(code), next)
    assert.deepEqual(action, { kind: 'retry' }, `${code} 不该由本插件处理`)
  }

  assert.equal(calls.length, 4, '四个非额度错误都应转交')
  assert.deepEqual(book.switched, [], '不碰账号库')
})

test('只有一个账号：不动手，把失败如实交回官方', async () => {
  const book = fakeBook(['acct-aaaa'])
  const quota = createQuotaSwitch({ list: book.list, use: book.use, now: () => 0 })
  const { next, calls } = recorder()

  const action = await quota.handle(failurePayload(), next)

  assert.equal(action, undefined)
  assert.equal(calls.length, 1)
  assert.deepEqual(book.switched, [])
})

test('所有账号都烧干：收手交回官方，而不是来回横跳', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb', 'acct-cccc'])
  const quota = createQuotaSwitch({ list: book.list, use: book.use, now: () => 0 })
  const { next, calls } = recorder()

  // 前两次各换一个还没烧干的账号。
  assert.deepEqual(await quota.handle(failurePayload(), next), { kind: 'retry' })
  assert.deepEqual(await quota.handle(failurePayload(), next), { kind: 'retry' })
  assert.deepEqual(book.switched, ['acct-bbbb', 'acct-cccc'], '依次换到 B、C')

  const settled = book.switched.slice()
  const action = await quota.handle(failurePayload(), next)

  assert.equal(action, undefined, '三个都试过之后不再换号')
  assert.equal(calls.length, 1, '这一次交给官方报错')
  assert.deepEqual(book.switched, settled, '不得把已经烧干的账号再切一轮')
})

test('冷却到期后，烧干的账号重新回到候选里', async () => {
  let clock = 0
  const book = fakeBook(['acct-aaaa', 'acct-bbbb'])
  const quota = createQuotaSwitch({ list: book.list, use: book.use, resetAfterMs: 300_000, now: () => clock })

  await quota.handle(failurePayload(), recorder().next)
  assert.deepEqual(book.switched, ['acct-bbbb'])

  // 冷却期内：B 刚烧干，A 也在冷却，没有候选。
  const blocked = await quota.handle(failurePayload(), recorder().next)
  assert.equal(blocked, undefined, '冷却期内不该重复切换')

  // 充值之后隔一段时间再失败：A 已过冷却，重新可切。
  clock += 600_000
  const action = await quota.handle(failurePayload(), recorder().next)
  assert.deepEqual(action, { kind: 'retry' })
  assert.deepEqual(book.switched, ['acct-bbbb', 'acct-aaaa'], '过期账号重新可用')
})

test('切不过去的账号记进冷却，继续试其余账号', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb', 'acct-cccc'])
  const attempts = []
  const use = async (id) => {
    attempts.push(id)
    if (id === 'acct-bbbb') throw new Error('账号 acct-bbbb 的存档槽位是空的')
    book.setActive(id)
    return { account: { id }, noop: false }
  }
  const quota = createQuotaSwitch({ list: book.list, use, now: () => 0 })

  const action = await quota.handle(failurePayload(), recorder().next)

  assert.deepEqual(action, { kind: 'retry' })
  assert.deepEqual(attempts, ['acct-bbbb', 'acct-cccc'], '坏账号不该挡住后面的好账号')
  assert.equal(book.active, 'acct-cccc')
})

test('全部切换都失败：交回官方，不谎报成功', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb', 'acct-cccc'])
  const use = async () => {
    throw new Error('凭证库不可写')
  }
  const quota = createQuotaSwitch({ list: book.list, use, now: () => 0 })
  const { next, calls } = recorder()

  const action = await quota.handle(failurePayload(), next)

  assert.equal(action, undefined)
  assert.equal(calls.length, 1)
})

test('读账号库失败：不打断恢复链，交给下一个处理者', async () => {
  const quota = createQuotaSwitch({
    list: async () => {
      throw new Error('credentials 服务缺失')
    },
    use: async () => ({}),
    now: () => 0,
  })
  const { next, calls } = recorder({ kind: 'retry' })

  const action = await quota.handle(failurePayload(), next)

  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(calls.length, 1, '下一环就是官方的 llm-retry，不能把链掐断')
})

test('槽位缺失的账号不进候选', async () => {
  const accounts = [
    { id: 'acct-aaaa', label: 'A', active: true, archived: true },
    { id: 'acct-bbbb', label: 'B', active: false, archived: false },
    { id: 'acct-cccc', label: 'C', active: false, archived: true },
  ]
  const switched = []
  const quota = createQuotaSwitch({
    list: async () => ({ activeId: 'acct-aaaa', accounts }),
    use: async (id) => {
      switched.push(id)
      return { account: { id }, noop: false }
    },
    now: () => 0,
  })

  const action = await quota.handle(failurePayload(), recorder().next)

  assert.deepEqual(action, { kind: 'retry' })
  assert.deepEqual(switched, ['acct-cccc'], '槽位空了的 B 切过去必炸，应被跳过')
})

test('切换目标恰好还是当前账号（noop）时继续找下一个', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb', 'acct-cccc'])
  const use = async (id) => {
    if (id === 'acct-bbbb') return { account: { id }, noop: true }
    book.setActive(id)
    return { account: { id }, noop: false }
  }
  const quota = createQuotaSwitch({ list: book.list, use, now: () => 0 })

  const action = await quota.handle(failurePayload(), recorder().next)

  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(book.active, 'acct-cccc', 'noop 等于没切成，应该接着试下一个')
})

test('收到取消信号时不换号', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb'])
  const quota = createQuotaSwitch({ list: book.list, use: book.use, now: () => 0 })
  const controller = new AbortController()
  controller.abort()

  const { next, calls } = recorder()
  const action = await quota.handle(failurePayload(ACCOUNT_QUOTA_CODE, { signal: controller.signal }), next)

  assert.equal(action, undefined)
  assert.equal(calls.length, 1, '用户已经中断，原样往下走')
  assert.deepEqual(book.switched, [], '不得把人已经取消的会话重新拉起来')
})

test('不同会话各自记链，互不清空对方的记忆', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb'])
  const quota = createQuotaSwitch({ list: book.list, use: book.use, now: () => 0 })

  await quota.handle(failurePayload(), recorder().next)
  assert.equal(book.active, 'acct-bbbb')

  // 另一个会话第一次撞上额度：它的链是空的，A 对它是可选的。
  const action = await quota.handle(
    failurePayload(ACCOUNT_QUOTA_CODE, { agent: { id: 'agent-2' } }),
    recorder().next,
  )

  assert.deepEqual(action, { kind: 'retry' })
  assert.deepEqual(book.switched, ['acct-bbbb', 'acct-aaaa'], 'agent-2 不受 agent-1 记忆的牵制')
})

test('切换成功会回调一次，用于留痕', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb'])
  const seen = []
  const quota = createQuotaSwitch({
    list: book.list,
    use: book.use,
    now: () => 0,
    onSwitch: (event) => seen.push(event),
  })

  await quota.handle(failurePayload(), recorder().next)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].account.id, 'acct-bbbb')
  assert.equal(seen[0].failure.code, ACCOUNT_QUOTA_CODE)
})

test('回调抛错不影响恢复', async () => {
  const book = fakeBook(['acct-aaaa', 'acct-bbbb'])
  const quota = createQuotaSwitch({
    list: book.list,
    use: book.use,
    now: () => 0,
    onSwitch: () => {
      throw new Error('磁盘满了')
    },
  })

  const action = await quota.handle(failurePayload(), recorder().next)

  assert.deepEqual(action, { kind: 'retry' }, '留痕是给人看的，不能让它的异常打断恢复')
})

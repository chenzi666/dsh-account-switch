import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureActive, forgetAccount, labelAccount, listAccounts, overview, parkActive, useAccount } from '../lib/core.js'
import { credentialsPath } from '../lib/home.js'
import { fingerprintOfToken, makeGrant } from '../lib/keys.js'
import { createFileBackend, readRecordsSection } from '../lib/slots.js'
import { registryPath } from '../lib/store.js'

const ISSUER = 'https://platform.deepseek.com'

/** 一个已经登录着账号 A 的 Harness home。 */
const SAMPLE = `# 手工注释
version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: browser-secret
  deepseek-account-platform/device:
    kind: grant
    payload:
      id: 0ffc769c-6289-4ed2-92f0-a70036d31cc2
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: token-account-A
      issuer: ${ISSUER}
refs:
  DEEPSEEK_API_KEY: sk-aaa
`

/** 建隔离 home；initial 为 undefined 表示不存在凭证库。 */
function makeHome(t, initial) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-account-e2e-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  if (initial !== undefined) writeFileSync(credentialsPath(home), initial, { mode: 0o600 })
  return home
}

test('端到端：两个账号入库、来回切换、谁都不丢', async (t) => {
  const home = makeHome(t, SAMPLE)
  const backend = createFileBackend(home)

  // ── 1. 启动归档：当前登录着的 A 必须进库，否则下次登录会把它顶掉且找不回来。
  const first = await captureActive(backend, home)
  assert.equal(first.created, true)
  assert.equal(first.account.id, `acct-${fingerprintOfToken('token-account-A').slice(0, 8)}`)
  assert.equal(first.account.issuer, ISSUER)

  // 归档是幂等的：重复采集不新增账号，也不改写昵称与加入时间。
  const again = await captureActive(backend, home)
  assert.equal(again.created, false)
  assert.equal(again.account.id, first.account.id)
  assert.equal((await listAccounts(backend, home)).accounts.length, 1)

  // ── 2. 模拟官方登录第二个账号：登录流程直接覆盖 default。
  await backend.writeDefault(makeGrant('token-account-B', ISSUER))

  // ── 3. 归档 B。此刻 A 只活在槽位里。
  const second = await captureActive(backend, home)
  assert.equal(second.created, true)
  assert.notEqual(second.account.id, first.account.id)

  const twoAccounts = await listAccounts(backend, home)
  assert.equal(twoAccounts.accounts.length, 2)
  assert.equal(twoAccounts.activeId, second.account.id)
  const storedA = twoAccounts.accounts.find((account) => account.id === first.account.id)
  assert.equal(storedA.active, false)
  assert.equal(storedA.archived, true)

  // ── 4. 切回 A。
  const back = await useAccount(backend, home, first.account.id)
  assert.equal(back.noop, false)
  assert.equal((await backend.readDefault()).payload.token, 'token-account-A')
  assert.equal((await listAccounts(backend, home)).activeId, first.account.id)

  // ── 5. 两边槽位都完好，这才是「随意切换」的物理基础。
  assert.equal((await backend.readSlot(first.account.id)).payload.token, 'token-account-A')
  assert.equal((await backend.readSlot(second.account.id)).payload.token, 'token-account-B')

  // ── 6. 官方持有的东西一个都没被碰：device、browser-session、refs、注释。
  const text = readFileSync(credentialsPath(home), 'utf8')
  assert.match(text, /# 手工注释/)
  assert.match(text, /browser-secret/)
  assert.match(text, /0ffc769c-6289-4ed2-92f0-a70036d31cc2/)
  assert.match(text, /sk-aaa/)

  // ── 7. 昵称可用，且昵称唯一时能直接当选择器。
  await labelAccount(backend, home, second.account.id, '小号')
  const byLabel = await useAccount(backend, home, '小号')
  assert.equal(byLabel.noop, false)
  assert.equal((await backend.readDefault()).payload.token, 'token-account-B')

  // ── 8. 切到当前账号是空操作，不该白白多记一次切换。
  const noop = await useAccount(backend, home, '小号')
  assert.equal(noop.noop, true)
  const after = await listAccounts(backend, home)
  // B 只被真正切到过一次（第 7 步）；第 8 步是空操作，计数必须停在那里。
  assert.equal(after.accounts.find((account) => account.id === second.account.id).switchCount, 1)
  assert.equal(after.accounts.find((account) => account.id === first.account.id).switchCount, 1)
})

test('账号库只存指纹，绝不落 token 明文', async (t) => {
  const home = makeHome(t, SAMPLE)
  const backend = createFileBackend(home)
  await captureActive(backend, home)

  const registryRaw = readFileSync(registryPath(home), 'utf8')
  assert.doesNotMatch(registryRaw, /token-account-A/, '注册表里出现 token 明文就是设计事故')
  assert.match(registryRaw, new RegExp(fingerprintOfToken('token-account-A')))
})

test('目标槽位为空时拒绝切换，default 一动不动', async (t) => {
  const home = makeHome(t, SAMPLE)
  const backend = createFileBackend(home)
  const { account } = await captureActive(backend, home)

  // 模拟「官方登出时把该账号的存档也清了」或者有人手工删了槽位。
  await backend.deleteSlot(account.id)
  await backend.writeDefault(makeGrant('token-account-B', ISSUER))

  await assert.rejects(() => useAccount(backend, home, account.id), /存档槽位是空的/)
  assert.equal(
    (await backend.readDefault()).payload.token,
    'token-account-B',
    '切换失败必须保持原状——清掉 default 等于当场把登录弄丢',
  )
})

test('default 是坏记录时既不归档也不覆盖，只把原因讲清楚', async (t) => {
  const home = makeHome(
    t,
    'version: 1\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: t\n',
  )
  const backend = createFileBackend(home)
  await assert.rejects(() => captureActive(backend, home), /无法解读/)
})

test('空凭证库：归档是空操作，不凭空造账号', async (t) => {
  const home = makeHome(t, undefined)
  const backend = createFileBackend(home)
  const result = await captureActive(backend, home)
  assert.equal(result.account, null)
  assert.equal(result.created, false)

  const status = await overview(backend, home)
  assert.equal(status.defaultState, 'empty')
  assert.deepEqual(status.accounts, [])
})

test('移除活跃账号需要 --force；force 时连带清 default', async (t) => {
  const home = makeHome(t, SAMPLE)
  const backend = createFileBackend(home)
  const { account } = await captureActive(backend, home)

  await assert.rejects(() => forgetAccount(backend, home, account.id), /正是当前活跃账号/)
  assert.equal((await backend.readDefault()).payload.token, 'token-account-A', '被拒绝的移除不该有副作用')

  const removed = await forgetAccount(backend, home, account.id, { force: true })
  assert.equal(removed.wasActive, true)
  assert.equal(await backend.readDefault(), undefined)
  assert.equal((await backend.readSlot(account.id)), undefined)
  assert.deepEqual((await listAccounts(backend, home)).accounts, [])
})

test('park：撤下活跃账号但存档完好，之后还能切回来', async (t) => {
  const home = makeHome(t, SAMPLE)
  const backend = createFileBackend(home)
  await captureActive(backend, home)

  const parked = await parkActive(backend, home)
  assert.equal(parked.parked, true)
  assert.equal(await backend.readDefault(), undefined, 'default 应当被撤下，UI 才会回到未登录态')
  assert.equal(
    (await backend.readSlot(parked.account.id)).payload.token,
    'token-account-A',
    '存档必须完好——park 的全部意义就是不注销、不丢号',
  )

  // 撤下之后照样切得回来，这就是多账号能一个个加进去的原因。
  const back = await useAccount(backend, home, parked.account.id)
  assert.equal(back.noop, false)
  assert.equal((await backend.readDefault()).payload.token, 'token-account-A')

  // 本来就没有活跃账号时，park 是空操作而不是错误。
  await backend.deleteDefault()
  const nothing = await parkActive(backend, home)
  assert.equal(nothing.parked, false)
  assert.equal(nothing.account, null)
})

test('token 含 YAML 敏感字符时也能无损往返', async (t) => {
  const home = makeHome(t, undefined)
  const backend = createFileBackend(home)
  // 官方 grant schema 对 token 的要求只有 /^[\x21-\x7e]+$/ —— 可打印 ASCII、无空格。
  // 也就是说 : # @ % & * ! ? - 这些 YAML 里的敏感字符都可能出现在真实 token 里，
  // 而裸标量遇到它们会被当成注释或键值分隔符。渲染层必须自己把这些引起来。
  const nasty = 'a:b#c@d%e&f*g!h?i-j'
  await backend.writeDefault(makeGrant(nasty, ISSUER))
  assert.equal((await backend.readDefault()).payload.token, nasty)

  const records = readRecordsSection(readFileSync(credentialsPath(home), 'utf8'))
  assert.equal(records.get('deepseek-account-platform/default').payload.token, nasty, '落盘再读回必须逐字相同')
})

test('槽位存在但注册表缺失时点名报出来，而不是默默忽略', async (t) => {
  const home = makeHome(t, SAMPLE)
  const backend = createFileBackend(home)
  // 直接往凭证库里塞一个注册表不认识的槽位，模拟外部工具写入。
  await backend.writeSlot('acct-deadbeef', makeGrant('token-orphan', ISSUER))

  const listing = await listAccounts(backend, home)
  assert.equal(listing.accounts.length, 0)
  assert.equal(listing.warnings.length, 1)
  assert.match(listing.warnings[0], /acct-deadbeef/)
})

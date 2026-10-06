import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { credentialsPath } from '../lib/home.js'
import { makeGrant } from '../lib/keys.js'
import { createFileBackend, readRecordsSection, renderRecordEdit } from '../lib/slots.js'

/** 一份贴近真实的凭证库：有注释、有 refs、有官方持有的 device 与 browser-session。 */
const SAMPLE = `# dsh credentials —— 手工加入的注释必须活下来
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
      issuer: https://platform.deepseek.com
refs:
  DEEPSEEK_API_KEY: sk-aaa
`

/** 建一个隔离的 home，用完即删。 */
function makeHome(t, initial) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-account-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  if (initial !== undefined) writeFileSync(credentialsPath(home), initial, { mode: 0o600 })
  return home
}

test('渲染一次槽位写入：注释与其余条目逐字保留', () => {
  const next = renderRecordEdit(SAMPLE, 'deepseek-account-platform/account-acct-12345678', makeGrant('token-B', 'https://platform.deepseek.com'))

  assert.match(next, /# dsh credentials/, '顶部注释必须保留')
  assert.match(next, /token-account-A/, '活跃账号不能被这次写入动到')
  assert.match(next, /0ffc769c-6289-4ed2-92f0-a70036d31cc2/, 'device 归官方，必须原样保留')
  assert.match(next, /sk-aaa/, 'refs 段必须原样保留')
  assert.match(next, /account-acct-12345678/, '新槽位应当出现')

  const records = readRecordsSection(next)
  assert.equal(records.get('deepseek-account-platform/account-acct-12345678').payload.token, 'token-B')
  assert.equal(records.size, 4, '写入应当新增一条，而不是替换整段')
})

test('渲染一次删除：只摘掉目标条目', () => {
  const withSlot = renderRecordEdit(SAMPLE, 'deepseek-account-platform/account-acct-12345678', makeGrant('token-B', 'https://platform.deepseek.com'))
  const pruned = renderRecordEdit(withSlot, 'deepseek-account-platform/account-acct-12345678', undefined)

  const records = readRecordsSection(pruned)
  assert.equal(records.has('deepseek-account-platform/account-acct-12345678'), false)
  assert.equal(records.get('deepseek-account-platform/default').payload.token, 'token-account-A')
  assert.match(pruned, /# dsh credentials/)
})

test('从零渲染：文件不存在时也能建出合法文档', () => {
  const next = renderRecordEdit(undefined, 'deepseek-account-platform/default', makeGrant('tok', 'https://platform.deepseek.com'))
  const records = readRecordsSection(next)
  assert.equal(records.get('deepseek-account-platform/default').payload.token, 'tok')
})

test('文件后端：槽位读写与 default 覆盖', async (t) => {
  const home = makeHome(t, SAMPLE)
  const backend = createFileBackend(home)
  const id = 'acct-12345678'

  assert.equal((await backend.readDefault()).payload.token, 'token-account-A')
  assert.equal(await backend.readSlot(id), undefined)
  assert.deepEqual(await backend.listSlotIds(), [])

  await backend.writeSlot(id, makeGrant('token-B', 'https://platform.deepseek.com'))
  assert.equal((await backend.readSlot(id)).payload.token, 'token-B')
  assert.deepEqual(await backend.listSlotIds(), [id])

  await backend.writeDefault(makeGrant('token-B', 'https://platform.deepseek.com'))
  assert.equal((await backend.readDefault()).payload.token, 'token-B')

  // 覆盖 default 之后，原账号仍然活在自己的槽位里——这正是「不丢账号」的全部含义。
  assert.equal(readRecordsSection(readFileSync(credentialsPath(home), 'utf8')).get('deepseek-account-platform/device').payload.id, '0ffc769c-6289-4ed2-92f0-a70036d31cc2')

  await backend.deleteDefault()
  assert.equal(await backend.readDefault(), undefined)
  assert.equal((await backend.readSlot(id)).payload.token, 'token-B', '清 default 不该牵连槽位')

  await backend.deleteSlot(id)
  assert.equal(await backend.readSlot(id), undefined)
})

test('文件后端拒绝写入 shaped 不对的 record，绝不污染文档', async (t) => {
  const home = makeHome(t, SAMPLE)
  const backend = createFileBackend(home)

  await assert.rejects(() => backend.writeSlot('acct-12345678', { kind: 'api-key', payload: {} }), /kind 必须是 "grant"/)
  await assert.rejects(
    () => backend.writeSlot('acct-12345678', { kind: 'grant', payload: {}, extra: 1 }),
    /未知字段/,
  )
  await assert.rejects(
    () => backend.writeSlot('acct-12345678', { kind: 'grant', payload: { fn: () => 1 } }),
    /JSON 无法表达/,
  )

  const after = readFileSync(credentialsPath(home), 'utf8')
  assert.equal(after, SAMPLE, '任何被拒的写入都不该改动文件')
})

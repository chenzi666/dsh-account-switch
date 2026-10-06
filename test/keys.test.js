import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_KEY,
  SCOPE,
  accountIdFromFingerprint,
  fingerprintOfRecord,
  fingerprintOfToken,
  isSlotKey,
  isValidSegment,
  makeGrant,
  readGrant,
  slotIdFromKey,
  slotKeyFor,
} from '../lib/keys.js'

test('段语法与内核 KEY_SEGMENT_PATTERN 对齐', () => {
  assert.equal(isValidSegment('default'), true)
  assert.equal(isValidSegment('account-ab12cd34'), true)
  assert.equal(isValidSegment('a'), true)
  // 以下都是内核会拒绝的形状：一旦放过去，写进文档会让整篇解析失败。
  assert.equal(isValidSegment('Default'), false, '大写开头')
  assert.equal(isValidSegment('1account'), false, '数字开头')
  assert.equal(isValidSegment('account_x'), false, '下划线')
  assert.equal(isValidSegment('account/x'), false, '含斜杠')
  assert.equal(isValidSegment(''), false)
  assert.equal(isValidSegment(undefined), false)
})

test('存档槽位 key 的拼装与反解', () => {
  const key = slotKeyFor('acct-ab12cd34')
  assert.equal(key, `${SCOPE}/account-acct-ab12cd34`)
  assert.equal(isSlotKey(key), true)
  assert.equal(slotIdFromKey(key), 'acct-ab12cd34')

  assert.equal(isSlotKey(DEFAULT_KEY), false, 'default 不是存档槽位')
  assert.equal(isSlotKey(`${SCOPE}/device`), false, 'device 归官方所有')
  assert.equal(isSlotKey('别的插件/account-x'), false)
  assert.equal(slotIdFromKey(DEFAULT_KEY), null)
})

test('非法 id 在拼 key 阶段就被拦住，不会写到文档里再炸', () => {
  assert.throws(() => slotKeyFor('Bad-Id'), TypeError)
  assert.throws(() => slotKeyFor('9bad'), TypeError)
})

test('token 指纹稳定且区分不同 token', () => {
  const a = fingerprintOfToken('token-account-A')
  assert.equal(a, fingerprintOfToken('token-account-A'), '同一个 token 必须给出同一指纹')
  assert.notEqual(a, fingerprintOfToken('token-account-B'))
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.throws(() => fingerprintOfToken(''), TypeError)
  assert.throws(() => fingerprintOfToken(null), TypeError)
})

test('账号 id 由指纹派生，天然幂等', () => {
  const fingerprint = fingerprintOfToken('token-account-A')
  const id = accountIdFromFingerprint(fingerprint)
  assert.equal(id, `acct-${fingerprint.slice(0, 8)}`)
  assert.equal(isValidSegment(id), true, '派生的 id 必须能过内核的段校验')
  assert.throws(() => accountIdFromFingerprint('nope'), TypeError)
})

test('grant 的构造与从严解读', () => {
  const grant = makeGrant('tok', 'https://platform.deepseek.com')
  assert.deepEqual(readGrant(grant), { token: 'tok', issuer: 'https://platform.deepseek.com' })

  assert.equal(readGrant(undefined), null, '没有记录是正常状态，不是错误')
  assert.throws(() => readGrant({ kind: 'api-key', payload: {} }), /不是 grant/)
  assert.throws(() => readGrant({ kind: 'grant', payload: { version: 1, token: 'x' } }), /缺少非空 issuer/)
  assert.throws(() => readGrant({ kind: 'grant', payload: { version: 2, token: 'x', issuer: 'y' } }), /版本/)
  assert.throws(() => readGrant({ kind: 'grant', payload: [] }), /必须是对象/)
  assert.throws(() => readGrant({ kind: 'grant', payload: { version: 1, token: '', issuer: 'y' } }), /非空 token/)
})

test('指纹读取对坏记录返回 null 而不是抛错', () => {
  // 事件监听器走这条路径：一条坏记录不该把事件分发打歪。
  assert.equal(fingerprintOfRecord({ kind: 'grant', payload: 'garbage' }), null)
  assert.equal(fingerprintOfRecord(undefined), null)
  assert.equal(
    fingerprintOfRecord(makeGrant('tok', 'https://platform.deepseek.com')),
    fingerprintOfToken('tok'),
  )
})

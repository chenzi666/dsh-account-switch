#!/usr/bin/env node
/**
 * 真格式演练：在一份凭证库副本上跑完整的多账号流程，逐步断言。
 *
 * 存在的理由：单测用的是合成的 YAML，而真实 `.credentials.yaml` 有自己的一套
 * 排版（官方 `yaml` 包写出来的缩进与次序）和真人塞进去的注释。这一步用真格式
 * 验证「解析 → 存档 → 切换 → 其余部分逐字不动」这条链路。
 *
 * 安全闸：默认拒绝在 `$DSH_HOME` 上运行。它要真的改文件，而把真人正在用的
 * 凭证库拿来当演练场是这类工具最容易犯的错。
 *
 * 用法：
 *   node scripts/drill.mjs <隔离 home 路径> --i-know-this-writes-files
 *
 * @module dsh-account-switch/drill
 */

import { readFileSync } from 'node:fs'
import { captureActive, listAccounts, overview, useAccount } from '../lib/core.js'
import { resolveDshHome } from '../lib/home.js'
import { makeGrant } from '../lib/keys.js'
import { createFileBackend, readRecordsSection } from '../lib/slots.js'

const [, , targetHome, ...flags] = process.argv

if (targetHome === undefined) {
  process.stderr.write('用法：node scripts/drill.mjs <隔离 home 路径> --i-know-this-writes-files\n')
  process.exit(2)
}
if (!flags.includes('--i-know-this-writes-files')) {
  process.stderr.write('拒绝运行：本演练会真的写入凭证库，请加 --i-know-this-writes-files 明确授权。\n')
  process.exit(2)
}

const home = resolveDshHome(targetHome)
const live = resolveDshHome()
if (home === live) {
  process.stderr.write(`拒绝运行：目标就是正在使用的 DSH_HOME（${home}）。请指向一份隔离副本。\n`)
  process.exit(2)
}

const backend = createFileBackend(home)
const ISSUER = 'https://platform.deepseek.com'
let failures = 0

/**
 * 断言并打印。
 * @param label - 这一步在验什么。
 * @param condition - 结果。
 * @param detail - 追加信息。
 */
function check(label, condition, detail = '') {
  process.stdout.write(`${condition ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : `  ${detail}`}\n`)
  if (!condition) failures += 1
}

/** 当前 default 的 token，缺失时给一个可读标记。 */
async function currentToken() {
  const record = await backend.readDefault()
  return record === undefined ? '（无）' : readRecordsSection(readFileSync(backend.filename, 'utf8')).get('deepseek-account-platform/default')?.payload?.token ?? '（不可读）'
}

process.stdout.write(`\n演练目标：${backend.filename}\n\n`)

process.stdout.write('① 初始状态\n')
const before = await overview(backend, home)
const beforeText = readFileSync(backend.filename, 'utf8')
check('凭证库可读', before.defaultState !== 'broken')
check('账号库为空', before.accounts.length === 0, `default=${before.defaultState}`)
check('default 里有账号', before.defaultState === 'grant')

process.stdout.write('\n② 归档当前账号（启动归档的等价动作）\n')
const first = await captureActive(backend, home, { label: '演练账号 A' })
check('入库成功', first.created === true, first.account?.id)
check('昵称生效', first.account?.label === '演练账号 A')
const idA = first.account.id

process.stdout.write('\n③ 再归档一次：必须幂等\n')
const repeat = await captureActive(backend, home)
check('没有新增账号', repeat.created === false)
check('id 不变', repeat.account.id === idA, repeat.account.id)

process.stdout.write('\n④ 模拟官方登录第二个账号（直接覆盖 default）\n')
await backend.writeDefault(makeGrant('fixture-token-B', ISSUER))
check('default 已被 B 覆盖', (await currentToken()) === 'fixture-token-B')

process.stdout.write('\n⑤ 归档 B\n')
const second = await captureActive(backend, home, { label: '演练账号 B' })
check('入库成功', second.created === true, second.account?.id)
check('是不同账号', second.account.id !== idA)
const idB = second.account.id

const two = await listAccounts(backend, home)
check('账号库有两个账号', two.accounts.length === 2)
check('活跃指向 B', two.activeId === idB)
check('A 已存档', two.accounts.find((account) => account.id === idA)?.archived === true)

process.stdout.write('\n⑥ 切回 A\n')
const back = await useAccount(backend, home, idA)
check('切换不是空操作', back.noop === false)
check('default 变回 A 的 token', (await currentToken()) === 'fixture-token-A')

process.stdout.write('\n⑦ 两个槽位都必须活着\n')
check('A 槽位完好', (await backend.readSlot(idA))?.payload.token === 'fixture-token-A')
check('B 槽位完好', (await backend.readSlot(idB))?.payload.token === 'fixture-token-B')

process.stdout.write('\n⑧ 官方持有的东西逐字未动\n')
const afterText = readFileSync(backend.filename, 'utf8')
const afterRecords = readRecordsSection(afterText)
check('device 未变', afterRecords.get('deepseek-account-platform/device')?.payload.id === '0ffc769c-6289-4ed2-92f0-a70036d31cc2')
check('browser-session 未变', afterRecords.get('client-connection/browser-session')?.payload.secret === 'fixture-secret')
check('refs 段未变', afterRecords.has('deepseek-account-platform/default') && /sk-FIXTURE/.test(afterText))
check('行数只增不减', afterText.split('\n').length > beforeText.split('\n').length)
check('三处原始内容仍在', ['0ffc769c', 'sk-FIXTURE', 'fixture-secret'].every((needle) => afterText.includes(needle)))

process.stdout.write(failures === 0 ? '\n全部通过。\n\n' : `\n${failures} 项失败。\n\n`)
process.exit(failures === 0 ? 0 : 1)

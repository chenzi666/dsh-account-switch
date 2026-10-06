#!/usr/bin/env node
/**
 * `dsh-account` —— 命令行入口。
 *
 * 它直接读写 `.credentials.yaml`，靠的是官方 `credentials-local` 自带的 fs watcher：
 * 文件一变，运行中的 Harness 立刻 `reconcileFromDisk()` 并对内广播
 * `credentials/record-updated`。所以**不用重启、不用连进程**，切完就是切完了。
 *
 * 锁用的是和官方 `@deepseek-ai/dsh-atomic-write` 完全相同的约定
 * （`<file>.lock`、`wx` 创建、内容为 pid），因此 CLI 与 Harness 抢同一把锁，
 * 两边同时写不会互相踩。
 *
 * @module dsh-account-switch/cli
 */

import { parseArgs } from 'node:util'
import { overview, captureActive, parkActive, useAccount, forgetAccount, labelAccount, identifyAccounts } from '../lib/core.js'
import { resolveDshHome } from '../lib/home.js'
import { createFileBackend } from '../lib/slots.js'

const USAGE = `dsh-account —— DeepSeek Harness 多账号管理

用法
  dsh-account list                       列出全部账号，标出当前活跃的那个
  dsh-account status                     打印当前状态与存储位置
  dsh-account capture [--label 名称]     把当前活跃账号归档进账号库
  dsh-account park [--label 名称]        归档并撤下 default，腾出位置登录下一个账号
  dsh-account use <id|名称>              切换活跃账号（立即生效，无需重启）
  dsh-account rename <id|名称> <新名称>  改昵称
  dsh-account remove <id|名称> [--force] 从账号库移除
  dsh-account identify                   补全平台身份并合并同一账号的重复记录

选项
  --home <路径>   覆盖 DSH_HOME
  --json          以 JSON 输出，便于脚本消费
  --verbose       打印细节与告警
  -h, --help      显示本帮助

加账号的完整流程
  1. 登录第一个账号          插件自动把它归档进账号库
  2. dsh-account park        撤下它，官方 UI 回到未登录态（不注销服务端 token）
  3. 在 UI 里登录第二个账号  同样自动归档
  4. dsh-account use <id>    想用哪个切哪个，不用重新登录

说明
  账号 token 存在 $DSH_HOME/.credentials.yaml 的
  deepseek-account-platform/account-<id> 槽位里，昵称等元数据存在
  $DSH_HOME/accounts/registry.json。活跃账号永远是
  deepseek-account-platform/default —— 本工具只把它指向别的槽位。
`

/** 打印到 stderr 并返回给定退出码。 */
function fail(message, code = 1) {
  process.stderr.write(`dsh-account: ${message}\n`)
  process.exit(code)
}

/**
 * 以终端显示宽度计长。CJK 与全角符号占两列，直接按 code unit 数对齐会歪。
 * @param text - 待测文本。
 * @returns 显示列数。
 */
function displayWidth(text) {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x20000
    width += wide ? 2 : 1
  }
  return width
}

/**
 * 按显示宽度补空格。
 * @param text - 原文。
 * @param target - 目标显示宽度。
 * @returns 补好的文本。
 */
function pad(text, target) {
  const missing = target - displayWidth(text)
  return missing > 0 ? text + ' '.repeat(missing) : text
}

/** 时间戳转本地可读串，坏值原样返回。 */
function shortTime(value) {
  if (typeof value !== 'string') return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 打印账号列表。
 * @param result - {@link overview} 的返回值。
 */
function printList(result) {
  const { accounts, defaultState } = result
  if (accounts.length === 0) {
    process.stdout.write('账号库是空的。先登录一次账号，或运行 `dsh-account capture`。\n')
  } else {
    const idWidth = Math.max(...accounts.map((account) => displayWidth(account.id)))
    const labelWidth = Math.max(...accounts.map((account) => displayWidth(account.label)))
    for (const account of accounts) {
      const marker = account.active ? '●' : ' '
      const flags = account.archived ? '' : '  [无存档]'
      process.stdout.write(
        `${marker} ${pad(account.id, idWidth)}  ${pad(account.label, labelWidth)}  ` +
          `切换 ${account.switchCount} 次  最近 ${shortTime(account.lastUsedAt)}${flags}\n`,
      )
    }
  }
  if (defaultState === 'empty') {
    process.stdout.write('\n当前没有登录任何账号（default 槽位为空）。\n')
  } else if (defaultState === 'broken') {
    process.stdout.write(`\n⚠ default 槽位里的记录无法解读：${result.defaultReason}\n`)
  }
}

/**
 * 打印告警。
 * @param warnings - 告警列表。
 * @param verbose - 是否输出。
 */
function printWarnings(warnings, verbose) {
  if (!verbose || warnings.length === 0) return
  for (const warning of warnings) process.stdout.write(`提示：${warning}\n`)
}

/** 主流程。 */
async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      label: { type: 'string' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const [command = 'list', ...rest] = positionals
  if (values.help || command === 'help') {
    process.stdout.write(USAGE)
    return
  }

  const home = resolveDshHome(values.home)
  const backend = createFileBackend(home)
  const emit = (payload) => {
    if (values.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  }

  switch (command) {
    case 'list': {
      const result = await overview(backend, home)
      if (values.json) emit(result)
      else {
        printList(result)
        printWarnings(result.warnings, values.verbose)
      }
      return
    }

    case 'status': {
      const result = await overview(backend, home)
      if (values.json) emit(result)
      else {
        process.stdout.write(`DSH home : ${home}\n`)
        process.stdout.write(`凭证库   : ${backend.filename}\n`)
        process.stdout.write(`账号注册 : ${result.accounts.length} 个\n`)
        process.stdout.write(`活跃账号 : ${result.activeId ?? '（无）'}\n`)
        process.stdout.write(`槽位状态 : ${result.defaultState}\n`)
        if (result.defaultReason !== null) process.stdout.write(`槽位问题 : ${result.defaultReason}\n`)
        printWarnings(result.warnings, true)
      }
      return
    }

    case 'capture': {
      const result = await captureActive(backend, home, { label: values.label })
      if (result.account === null) fail('当前没有登录任何账号，没有可归档的内容。')
      if (values.json) emit(result)
      else {
        process.stdout.write(
          `${result.created ? '已入库新账号' : '已刷新已有账号'} ${result.account.id}（${result.account.label}）\n`,
        )
      }
      return
    }

    case 'park': {
      const result = await parkActive(backend, home, { label: values.label })
      if (result.parked === false) fail('当前没有登录任何账号，没有可撤下的内容。')
      if (values.json) emit(result)
      else {
        process.stdout.write(
          `已撤下 ${result.account.id}（${result.account.label}）：存档完好，服务端 token 未注销。\n` +
            '现在官方 UI 显示未登录，可以直接去登录下一个账号。\n',
        )
      }
      return
    }

    case 'use': {
      const selector = rest[0]
      if (selector === undefined) fail('用法：dsh-account use <id|名称>')
      const result = await useAccount(backend, home, selector)
      if (values.json) emit(result)
      else if (result.noop) process.stdout.write(`${result.account.id}（${result.account.label}）本来就是活跃账号。\n`)
      else {
        process.stdout.write(
          `已切到 ${result.account.id}（${result.account.label}）。` +
            '下一个模型请求即用新账号，无需重启 Harness。\n',
        )
      }
      return
    }

    case 'rename': {
      const [selector, label] = rest
      if (selector === undefined || label === undefined) fail('用法：dsh-account rename <id|名称> <新名称>')
      const account = await labelAccount(backend, home, selector, label)
      if (values.json) emit(account)
      else process.stdout.write(`${account.id} 现在叫「${account.label}」。\n`)
      return
    }

    case 'remove': {
      const selector = rest[0]
      if (selector === undefined) fail('用法：dsh-account remove <id|名称> [--force]')
      const result = await forgetAccount(backend, home, selector, { force: values.force })
      if (values.json) emit(result)
      else {
        process.stdout.write(`已移除 ${result.account.id}（${result.account.label}）。\n`)
        if (result.wasActive) process.stdout.write('它同时是活跃账号，default 槽位已一并清空。\n')
      }
      return
    }

    case 'identify': {
      // 只读操作：逐条问平台「这个 token 是谁」，据答案补全身份并合并同一账号的重复记录。
      // 每次重新登录都会换新 token，所以同一账号会在库里留下多条；老记录没有平台 userId，
      // 本地分辨不出来，只能问一次。
      if (!values.json) {
        const before = await overview(backend, home)
        process.stdout.write(`开始核对 ${before.accounts.length} 条记录的平台身份（只读取账号资料，不改动平台上的任何东西）…\n`)
      }
      const report = await identifyAccounts(backend, home, {
        dryRun: values['dry-run'],
        onProgress: ({ id, ok, name, reason }) => {
          if (values.json) return
          process.stdout.write(ok ? `  ✓ ${id}${name === null || name === undefined ? '' : `  ${name}`}\n` : `  · ${id}  跳过：${reason}\n`)
        },
      })
      if (values.json) emit(report)
      else {
        process.stdout.write('\n')
        if (report.groups.length > 0) {
          process.stdout.write(`发现 ${report.groups.length} 组重复（同一账号的多条记录）：\n`)
          for (const group of report.groups) process.stdout.write(`  ${group.userId}  ←  ${group.ids.join(', ')}\n`)
        } else {
          process.stdout.write('没有发现重复记录。\n')
        }
        process.stdout.write(`已核对 ${report.checked} 条，识别出 ${report.identified} 条，合并掉 ${report.merged} 条。\n`)
        if (report.renamed > 0) process.stdout.write(`其中 ${report.renamed} 条用平台昵称替换了自动生成的名称。\n`)
        if (report.failures.length > 0) {
          process.stdout.write(`${report.failures.length} 条无法识别（token 可能已失效）：\n`)
          for (const failure of report.failures) process.stdout.write(`  · ${failure.id}  ${failure.reason}\n`)
        }
      }
      return
    }

    default:
      fail(`未知命令「${command}」。运行 dsh-account --help 查看用法。`)
  }
}

main().catch((error) => {
  fail(error.message)
})

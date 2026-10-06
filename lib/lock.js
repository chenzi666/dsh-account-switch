/**
 * 跨进程互斥。
 *
 * DSH 插件与 CLI 是两个进程，会同时改同一批文件（注册表、凭证库）。`wx` 独占创建
 * 是这一步能拿到的最强保证：创建即获取，无需检查-再写的竞态窗口。陈旧锁按 mtime
 * 判定并回收，否则上一个进程被强杀就会永久堵住后续所有写入。
 *
 * 锁文件与数据文件同目录：跨卷 rename 不原子，而锁和数据必须同处一个卷。
 *
 * @module dsh-account-switch/lock
 */

import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 超过这个年龄的锁视为上一个持有者已死。 */
export const DEFAULT_STALE_MS = 10_000

/** 拿不到锁时的最大等待时长。 */
export const DEFAULT_WAIT_MS = 5_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 独占创建锁文件，失败则退避重试。
 * @param lockPath - 锁文件绝对路径。
 * @param options - `staleMs` 与 `waitMs` 覆盖默认值。
 * @returns 释放函数；重复调用安全。
 * @throws Error 等待超过 `waitMs` 仍拿不到锁。
 */
export async function acquireLock(lockPath, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + waitMs
  let delay = 15
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeFileSync(fd, `${process.pid}\n`)
      closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          rmSync(lockPath, { force: true })
        } catch {
          /* 锁已被回收：无事可做 */
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        // 锁在判定途中消失：立刻重试争抢。
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`获取锁超时（${waitMs}ms）：${lockPath}`)
      }
      await sleep(delay)
      delay = Math.min(delay * 2, 250)
    }
  }
}

/**
 * 在锁内跑一段操作，无论成功失败都释放。
 * @param lockPath - 锁文件绝对路径。
 * @param fn - 临界区。
 * @param options - 传给 {@link acquireLock} 的覆盖项。
 * @returns fn 的返回值。
 */
export async function withLock(lockPath, fn, options) {
  const release = await acquireLock(lockPath, options)
  try {
    return await fn()
  } finally {
    release()
  }
}

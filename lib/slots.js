/**
 * 槽位读写层。
 *
 * 同一套语义，两个后端：
 *   - {@link createServiceBackend} —— 跑在 DSH 进程内，走官方 `ctx.credentials` seam，
 *     写入自带文件锁、原子落盘与 `credentials/record-updated` 广播；
 *   - {@link createFileBackend} —— 跑在 CLI 进程里，DSH 没启动时直接改
 *     `.credentials.yaml`。这不是绕过官方：`credentials-local` 带 fs watcher，
 *     文件一变就 `reconcileFromDisk()` 并对外广播变化，所以两条路径的**最终效果相同**，
 *     区别只是谁来写这一次。
 *
 * 文件后端刻意复用官方同一套渲染语义（`parseDocument` → `setIn` → `toString`），
 * 因为官方文档原地编辑以保留注释与未触碰条目的排版；重新序列化整篇会把这些抹掉，
 * 让每次切换在仓库里留下一大块无意义 diff。
 *
 * @module dsh-account-switch/slots
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { DEFAULT_KEY, SLOT_PREFIX, SCOPE, isSlotKey, slotIdFromKey, slotKeyFor } from './keys.js'
import { credentialsPath } from './home.js'
import { withLock } from './lock.js'

/** 与服务端一致的版本戳。 */
const DOCUMENT_VERSION = 1

/**
 * 只放行 JSON 能表达的值。与 `credentials-local` 的 `assertJsonValue` 同义：
 * 一条带 Date、函数或原型的 payload 会在官方解析器那里被拒，宁可在这里先拒。
 * @param where - 出错时用于指位的描述。
 * @param value - 待校验的值。
 * @param seen - 环检测集合。
 */
function assertJsonValue(where, value, seen = new Set()) {
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (Number.isFinite(value)) return
      break
    default:
      if (typeof value === 'object' && !seen.has(value)) {
        if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
          seen.add(value)
          for (const nested of Object.values(value)) assertJsonValue(where, nested, seen)
          seen.delete(value)
          return
        }
      }
  }
  throw new TypeError(`${where} 含 JSON 无法表达的值`)
}

/**
 * 校验一条 record 能否被官方解析器接受。
 * @param key - 完整凭证 key。
 * @param record - 候选记录。
 */
export function assertStorableRecord(key, record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`record "${key}" 必须是映射`)
  }
  if (record.kind !== 'grant') {
    throw new TypeError(`record "${key}" 的 kind 必须是 "grant"（本插件只写账号授权）`)
  }
  for (const field of Object.keys(record)) {
    if (field !== 'kind' && field !== 'payload') {
      throw new TypeError(`record "${key}" 含未知字段 "${field}"（官方白名单只允许 kind/payload）`)
    }
  }
  assertJsonValue(`record "${key}" payload`, record.payload)
}

/**
 * 服务后端：DSH 进程内。
 * @param ctx - cordis 上下文，需已注入 `credentials`。
 * @returns 槽位后端。
 */
export function createServiceBackend(ctx) {
  const credentials = ctx.credentials
  return {
    kind: 'service',
    /** @returns 活跃账号 record 或 undefined。 */
    readDefault: () => credentials.readRecord(DEFAULT_KEY),
    /** @param id - 账号 id。 @returns 该槽位 record 或 undefined。 */
    readSlot: (id) => credentials.readRecord(slotKeyFor(id)),
    /**
     * 覆盖 `default`。改动必然发 `credentials/record-updated`，
     * 于是账号服务与 UI 会自动重读，无需重启任何东西。
     * @param record - 新 record。
     */
    async writeDefault(record) {
      assertStorableRecord(DEFAULT_KEY, record)
      await credentials.modifyRecord(DEFAULT_KEY, () => record)
    },
    /** 清掉活跃槽位（登出语义）。 */
    async deleteDefault() {
      if ((await credentials.readRecord(DEFAULT_KEY)) !== undefined) {
        await credentials.deleteRecord(DEFAULT_KEY)
      }
    },
    /**
     * 写入存档槽位。
     * @param id - 账号 id。
     * @param record - 新 record。
     */
    async writeSlot(id, record) {
      const key = slotKeyFor(id)
      assertStorableRecord(key, record)
      await credentials.modifyRecord(key, () => record)
    },
    /**
     * 删除存档槽位；槽位本就不存在时静默返回。
     * @param id - 账号 id。
     */
    async deleteSlot(id) {
      const key = slotKeyFor(id)
      if ((await credentials.readRecord(key)) !== undefined) await credentials.deleteRecord(key)
    },
    /**
     * 枚举本插件维护的槽位 id。`listRecords` 不在 seam 的抽象基类上，
     * 缺失时降级为「空列表」而不是抛错——枚举失败不该挡住切换。
     * @returns 槽位 id 数组。
     */
    async listSlotIds() {
      if (typeof credentials.listRecords !== 'function') return []
      const records = await credentials.listRecords()
      return records.map((entry) => String(entry.key)).filter(isSlotKey).map(slotIdFromKey)
    },
  }
}

/**
 * 用官方同款语义渲染一次 record 改动：解析现有文档（保住注释与排版），
 * 指向性写入或删除目标条目，再序列化。
 * @param text - 当前文档文本；文件不存在时传 undefined。
 * @param key - 目标 key。
 * @param record - 新 record，或 undefined 表示删除。
 * @returns 新文档文本。
 */
export function renderRecordEdit(text, key, record) {
  const document = text === undefined ? new Document({}) : parseDocument(text)
  document.setIn(['version'], DOCUMENT_VERSION)
  if (record === undefined) {
    document.deleteIn(['records', key])
  } else {
    document.setIn(['records', key], record)
  }
  return document.toString()
}

/**
 * 从文档文本里读出 records 段。解析失败返回空映射，由调用方决定是否报错。
 * @param text - 文档文本。
 * @returns `Map<string, object>`。
 */
export function readRecordsSection(text) {
  const records = new Map()
  if (typeof text !== 'string' || text.length === 0) return records
  let root
  try {
    root = parseDocument(text).toJS()
  } catch {
    return records
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return records
  const section = root.records
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return records
  for (const [key, value] of Object.entries(section)) {
    records.set(key, value)
  }
  return records
}

/**
 * 文件后端：CLI 进程，DSH 未运行时使用。
 *
 * 写路径与官方一致——同目录临时文件 + 原子改名——并且复用同一把文档锁文件名与
 * 官方 `withFileLock` 无冲突：官方锁是它自己进程内的，我们所做的只是保证 CLI 之间
 * 不互相覆盖。
 *
 * @param home - DSH home。
 * @returns 槽位后端。
 */
export function createFileBackend(home) {
  const filename = credentialsPath(home)
  const lockPath = `${filename}.lock`

  const readText = () => {
    try {
      return readFileSync(filename, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }

  const applyEdit = (key, record) => {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    const nextText = renderRecordEdit(readText(), key, record)
    // 落盘前自检：宁可这次切换失败，也不留一份官方解析器读不动的文档。
    const reparsed = readRecordsSection(nextText)
    if (record === undefined) {
      if (reparsed.has(key)) throw new Error(`渲染后 "${key}" 仍然存在，已放弃写入`)
    } else if (JSON.stringify(reparsed.get(key)) !== JSON.stringify(record)) {
      throw new Error(`渲染后 "${key}" 与目标不一致，已放弃写入`)
    }
    const tmp = `${filename}.${process.pid}.tmp`
    writeFileSync(tmp, nextText, { mode: 0o600 })
    renameSync(tmp, filename)
  }

  return {
    kind: 'file',
    filename,
    readDefault: async () => readRecordsSection(readText()).get(DEFAULT_KEY),
    readSlot: async (id) => readRecordsSection(readText()).get(slotKeyFor(id)),
    async writeDefault(record) {
      assertStorableRecord(DEFAULT_KEY, record)
      await withLock(lockPath, async () => applyEdit(DEFAULT_KEY, record))
    },
    async deleteDefault() {
      await withLock(lockPath, async () => {
        if (readRecordsSection(readText()).has(DEFAULT_KEY)) applyEdit(DEFAULT_KEY, undefined)
      })
    },
    async writeSlot(id, record) {
      const key = slotKeyFor(id)
      assertStorableRecord(key, record)
      await withLock(lockPath, async () => applyEdit(key, record))
    },
    async deleteSlot(id) {
      const key = slotKeyFor(id)
      await withLock(lockPath, async () => {
        if (readRecordsSection(readText()).has(key)) applyEdit(key, undefined)
      })
    },
    async listSlotIds() {
      return [...readRecordsSection(readText()).keys()]
        .filter(isSlotKey)
        .map(slotIdFromKey)
        .filter((id) => id !== null)
    },
  }
}

export { SCOPE, SLOT_PREFIX, DEFAULT_KEY, slotKeyFor }

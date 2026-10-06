/**
 * DSH home 定位。
 *
 * 与内核 `resolveDshHome` 的取舍保持一致：显式传入优先，其次 `DSH_HOME`，
 * 最后落到 `~/.dsh`。CLI 与插件走同一个函数，因此两边永远指向同一套文件。
 *
 * @module dsh-account-switch/home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 环境变量名，与 `dsh-credentials-local` 读的是同一个。 */
export const HOME_ENV = 'DSH_HOME'

/**
 * 解析 DSH home 目录。
 * @param explicit - 调用方显式指定的路径，优先级最高。
 * @returns 绝对路径。
 */
export function resolveDshHome(explicit) {
  const candidate =
    (typeof explicit === 'string' && explicit.length > 0 ? explicit : undefined) ??
    (typeof process.env[HOME_ENV] === 'string' && process.env[HOME_ENV].length > 0 ? process.env[HOME_ENV] : undefined) ??
    join(homedir(), '.dsh')
  return resolve(candidate)
}

/**
 * 本插件的元数据目录。
 * @param home - DSH home。
 * @returns `$DSH_HOME/accounts`。
 */
export function accountsDir(home) {
  return join(home, 'accounts')
}

/**
 * 凭证库路径。与 `dsh-credentials-local` 的默认解析结果一致，
 * 便于 CLI 在 DSH 没运行时也能直接档案化 token。
 * @param home - DSH home。
 * @returns `$DSH_HOME/.credentials.yaml`。
 */
export function credentialsPath(home) {
  return join(home, '.credentials.yaml')
}

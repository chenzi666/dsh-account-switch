# dsh-account-switch

**DeepSeek Harness 多账号插件 —— 一次登录多个账号，随时热切换，不重启、不重新登录。**

切换后下一个模型请求立即用新账号。已登录的账号不会被顶掉——它们在凭证库里各自有一个存档槽位。

额度烧干时自动换到下一个还有钱的账号，并让失败的那一步**原地重跑**：会话不断、上下文不丢、工具状态不动。

```
切换前  default ──▶ 账号 A（已烧干）
切换后  default ──▶ 账号 B            ← 下一个请求直接生效，进程没重启过
```

---

## 功能

| 功能 | 说明 |
| --- | --- |
| **多账号共存** | 任意多个账号的 token 同时存在凭证库里，互不覆盖、互不顶号 |
| **热切换** | `dsh-account use <账号>` 立即生效，无需重启、无需重新登录 |
| **额度自动换号** | 当前账号额度用尽时自动切到下一个可用账号，并让失败的那一步原地重跑 |
| **账号冷却** | 刚被判没钱的账号进冷却（默认 5 分钟）不再被选中，避免来回横跳；充值后自动回到候选 |
| **切换留痕** | 每次自动换号写一行 JSON 日志（切到谁、什么错、哪个会话的第几步） |
| **指纹化存档** | 账号 id 由 `sha256(token)` 前缀派生，同一 grant 永远映射同一槽位，归档天然幂等 |
| **昵称管理** | 给账号起中文名，`use 主号` 比 `use acct-af3bded5` 好记 |
| **CLI + 插件 API** | `dsh-account` 命令行，另有 `ctx.accountSwitch` 供其它插件调用 |
| **零内核改动** | 全部走公开 seam，不 patch 官方包，Harness 升级不会把它冲掉 |
| **不额外存秘密** | `registry.json` 只有指纹；`list --json` 不输出 token |

---

## 先说清它做不到什么

**切换是全局的。**

Harness 的账号是一个进程级的单例服务：`ctx.deepseekAccount`（实现为 `PlatformAccount`）持有唯一的账号状态，`deepseek-account` 这个模型 provider 每次请求都向它要 token。官方把活跃账号硬编码在 `deepseek-account-platform/default` 这一个槽位上，没有任何按会话区分的维度。

所以：

- ✅ 多个账号的 token 可以共存，切换是瞬时的、热生效的
- ❌ **不能**让 A 会话用账号 1、B 会话用账号 2 同时跑——切了就是全切
- ❌ 额度用尽时的自动换号切的是**同一个全局槽位**。A 会话先撞上额度打满而换号，B 会话的下一个请求也会跟着用新账号。这是全局单例的语义，不是本插件的取舍

要「同时并行」只能开第二个 Harness 实例，让它用另一个 `DSH_HOME`（于是另一份 `.credentials.yaml`）。但 Desktop 的 Electron 单实例锁是否会放行第二份实例，需要实测，`--user-data-dir` 未必够。本插件不尝试绕过这一层。

如果哪天需要真正的按会话绑定，那要动的是内核里 `resolveToken()` 的取用维度——那是另一件事，不是插件能做的。

---

## 多账号的成本，比你想的低得多

这个插件的上限取决于你手上有几个账号。注册第 N 个账号要过手机验证码，这件事有一个几毛钱的解法：

### 📱 推荐：[好助码 · 在线接码平台](https://h5.haozhuma.com/reg.html?action=weichen666)

**一个验证码 0.2–0.3 元。** 十条备用号也就两块钱出头。

| 项目 | 说明 |
| --- | --- |
| **单价** | **0.2–0.3 元 / 条**（按号段和项目浮动，下单前页面实时显示） |
| 覆盖 | 国内外主流号段，注册/登录类短信验证码 |
| 到货 | 网页实时收码，不用等、不用抢 |
| 适合 | 多账号轮换、自动化测试、批量注册场景 |
| **注册入口** | **<https://h5.haozhuma.com/reg.html?action=weichen666>** |

**为什么和这个插件是一对：**

1. 插件让「多个账号」变得**好用**——秒切、自动换号、额度打满不中断。
2. 接码平台让「多个账号」变得**便宜**——0.2–0.3 元一个号，成本可以忽略。
3. 两者叠加的净效果：额度不再是天花板，账号池就是你的额度池。

**上手三步：**

1. 打开 <https://h5.haozhuma.com/reg.html?action=weichen666> 注册并充值（几十块够用很久）
2. 选号 → 拿到手机号 → 在 Harness 官方 UI 里用它登录新账号
3. `dsh-account list` 确认新账号已自动入库，`dsh-account use <名称>` 切过去

> 这个插件本身与接码平台无技术耦合——它只负责管账号，不负责造账号。手机号从哪来由你决定，这里给的是最省事的一条路。

---

## 它怎么做到的

全部走公开 seam，**不改内核、不 patch 官方包**，所以 Harness 升级不会把它冲掉。

三层事实：

1. **凭证服务是通用的。** `ctx.credentials` 按 `<scope>/<id>` 寻址，id 段只要求匹配 `/^[a-z][a-z0-9-]*$/`。官方只用了 `default` 和 `device`，剩下的 id 段没人占——`account-<指纹>` 就是我们的地盘。

2. **目录变了会自动广播。** `dsh-credentials-local` 带 fs watcher：`.credentials.yaml` 一变就 `reconcileFromDisk()`，对每条变化的记录发 `credentials/record-updated`。而 `PlatformAccount` 自己就监听这个事件。所以写文件 = 通知到位。

3. **token 没有跨请求缓存。** `PlatformAccount.resolveToken()` 每个请求都重读 `default`。所以覆盖那一行，下一个请求就是新账号。

于是切换的全部动作就是：**把目标槽位的内容写回 `default`**。

### 存档槽位

```yaml
version: 1
records:
  client-connection/browser-session: { ... }          # 官方持有，本插件不碰
  deepseek-account-platform/device:  { ... }          # 官方持有，本插件不碰
  deepseek-account-platform/default:                  # ← 活跃账号，官方唯一的读写口
    kind: grant
    payload: { version: 1, token: <当前账号>, issuer: https://platform.deepseek.com }
  deepseek-account-platform/account-acct-af3bded5:    # ← 本插件的存档槽位
    kind: grant
    payload: { version: 1, token: <账号 A>, issuer: ... }
  deepseek-account-platform/account-acct-f6b06859:    # ← 又一个存档槽位
    kind: grant
    payload: { version: 1, token: <账号 B>, issuer: ... }
refs:
  DEEPSEEK_API_KEY: sk-...                            # 官方持有，本插件不碰
```

账号 id 直接由 `sha256(token)` 的前缀派生，所以同一个 grant 永远映射到同一个 id——归档天然幂等，不需要一张需要维护的映射表。

昵称等元数据存在 `$DSH_HOME/accounts/registry.json`，**只放指纹，不放 token 明文**。之所以不塞进 `.credentials.yaml`：官方解析器对文档做严格白名单校验，顶层只允许 `version`/`refs`/`records`、每条记录只允许 `kind`/`payload`，多一个字段就让整篇解析失败——那是启动级故障。

---

## 安装

### 1. 把包放进 profile 的 node_modules

这个 profile 的 `node_modules` 是「解压出来的真实目录」结构——`.pnpm` 里只有一个 `lock.yaml`，`dsh-proxy-boot`、`dsh-web-search-ddg` 全是这么放的。所以**不要跑 pnpm / npm**：它们会按依赖树重建整个目录，把那些不在 lock 里的包清掉。

用脚本复制成**真实目录**：

```powershell
powershell -NoProfile -File scripts/sync-install.ps1
```

**必须是真实目录，不能用目录联接。** 这是实测结论，不是偏好：同一个包以 junction 形态放进 `node_modules` 时，Harness 根本不会加载它——连插件自己的 `apply()` 都不会被调用，而且不报任何错。把完全相同的文件复制成真实目录后立刻正常。当时靠三个对照探针（真实目录 / junction / 完整插件）一次重启锁死了这个结论：真实目录那个写出了留痕，另外两个什么都没写。原因在 `dsh-app-boot` 的 `linkedProfileRoots` 那一层，没有继续深挖。

代价是改了源码要重跑脚本。脚本会连同 `node_modules/yaml`（唯一的运行时依赖）一起复制——Harness 的解析层不会替插件装依赖。

卸载：`Remove-Item -Recurse` 掉那个目录，再从 patch 里删掉条目。

### 2. 在 profile 的 patch 里挂上插件行

`$DSH_HOME/profiles/desktop/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-account-switch
      name: dsh-account-switch
      config:
        enabled: true
        autoArchiveOnStart: true
        autoCaptureOnSignIn: true
        verbose: false
```

多个 `- insert:` 块都会被处理（`dsh-app-boot` 里是 `for (const patch of patches) patch.insert?.forEach(visit)`），所以它和 profile 里原有的 `proxy-boot` / `web-search-ddg` 那个 insert 块互不干扰。

### 3. 重启 Harness

实测改完 patch 后插件**没有**自动挂载——`patchReload: live` 不覆盖新增的插件行。需要重启一次。

### 关于 `@deepseek-ai/*`

插件里 `import '@deepseek-ai/cordis'` 和 `'@deepseek-ai/schemastery'` 由 **Harness 运行时提供**，部署时插件的 `node_modules` 里**不该**有 `@deepseek-ai` 目录。

这里踩过一个坑：npm 7+ 默认会自动安装 peerDependencies，而 `@deepseek-ai/cordis` 在公共 registry 上有包，`npm install` 就在插件下塞进了第二份 cordis。那意味着插件的 `Service` 基类来自另一个模块实例，跟宿主 ctx 不是同一个——挂载时才炸，而且只在运行时暴露。所以本仓库带了 `.npmrc`（`legacy-peer-deps=true`），插件目录里只应存在 `yaml`。

### 命令行

```
node bin/dsh-account.js list
```

安装时动过的东西：

| 路径 | 备份 |
| --- | --- |
| `$DSH_HOME/.credentials.yaml` | 同目录 `.pre-account-switch.bak` |
| `$DSH_HOME/profiles/desktop/cordis.patch.yml` | 同目录 `.pre-account-switch.bak` |
| `$DSH_HOME/profiles/desktop/package.json` | 未改动（不需要改） |
| `$DSH_HOME/profiles/desktop/node_modules/dsh-account-switch` | 新增真实目录 |

---

## 用法

### 加第二个账号

官方 UI 在已登录状态下只会给「退出登录」，而**退出会向平台注销 token**（`revokeAccount`），把存档一起废掉。所以用 `park`：

```
dsh-account list                       # 看看现在有什么
dsh-account park --label 主号          # 撤下当前账号，官方 UI 回到未登录态
                                       # token 未注销，存档完好
… 在 UI 里登录第二个账号 …             # 插件自动把它归档进账号库
dsh-account park --label 小号          # 想再加就继续
dsh-account list                       # 两个都在
```

`park` 之后插件也会在 default 变化时自动捕获新账号，不需要手工 `capture`。

### 切换

```
dsh-account use 主号          # 按昵称切（昵称必须唯一）
dsh-account use acct-af3bded5 # 按 id 切
```

切完下一个模型请求就用新账号。**不需要重启任何东西。**

### 额度用尽自动换号

不用手动盯着。当前账号额度烧干时，插件会自动切到下一个还有钱的账号，**并让失败的那一步原地重跑**——会话不断，上下文不丢，工具状态不动。

```
[account-switch] 账号额度用尽，已切到 acct-f6b06859（小号），本步将自动重跑
```

怎么做到的：官方 `dsh-agent-loop` 在模型请求失败后广播 `agent/request-error`，把「这次要不要重来」交给插件链决定——`dsh-llm-retry` 的退避重试就挂在这个点上。我们挂同一处，听到额度错误就换号，然后回一个 `{ kind: 'retry' }`，agent-loop 于是 `continue` 重跑这一步；而 `resolveToken()` 每次请求都重读 `default`，新账号的 token 自然生效。全程只用公开 seam，不改内核、不 patch 官方包。

认两个错误码，都由官方定义：`ACCOUNT_QUOTA`（账号侧专用）和 `QUOTA`（通用码，`status === 402` 或响应文本命中 `insufficient balance` / `quota exceeded` 一类措辞）。

冷却：**按账号记时间戳**。某个账号刚被判没钱，就会在 `quotaChainResetMs`（默认 5 分钟）内不再被选中——这同时解决两件事：所有账号都烧干时不会来回横跳（试完一轮就如实报错），以及充值之后过了冷却它又会自动回到候选里。

留痕在 `$DSH_HOME/accounts/quota-switch.log`，一行一条 JSON（切到谁、什么错、哪个会话的第几步）。换号是**你看不见的副作用**，不留痕的话事后查「账号怎么自己变了」会毫无头绪。

配置（`cordis.patch.yml` 的 `dsh-account-switch` 行里）：

```yaml
- id: dsh-account-switch
  config:
    autoSwitchOnQuota: true     # 关掉它就回到「额度烧干即中断」的官方行为
    quotaChainResetMs: 300000   # 单个账号的冷却时长
```

### 添加账号：弹窗，而不是一点就跳浏览器

点击「添加账号」弹出一个对话框，三个按钮：`复制链接` / `打开浏览器` / `取消`。

链接只能由宿主向平台申请（PKCE 挑战、state、本地回调地址都在宿主侧），没有第二条路凭空造一条链接，所以两个按钮都会调同一个 `startSignIn`；区别只在拿到链接之后——一个进剪贴板，一个显式 `window.open` 交给系统浏览器。

**但 Desktop 外壳有一段常驻 watch，授权链接一出现就直接 `shell.openExternal`**（`app/lib/main.js` 里对账号状态的订阅：无条件、无开关、随进程存活）。那段代码不在插件里，插件层拦不住它。所以这套交互要真正成立，得给外壳加一个 21 字节的补丁：

```diff
- if (attempt?.phase === "waiting-browser" && attempt.authorizeUrl !== void 0 && openedAttempt !== attempt.id) {
+ if (attempt?.phase === "waiting-browser" && attempt.authorizeUrl !== void 0 && openedAttempt !== attempt.id && !enteredWorkspace) {
```

`enteredWorkspace` 是同作用域里已有的变量（进工作区时置 true，退回 welcome 时复位），所以这个补丁**不引入任何新状态、不需要新 import**；而且**首次引导的体验原样保留**——还没进工作区时，登录依然会自动打开浏览器。

装法（**必须先关掉 Harness**：归档被运行中的进程独占，替换会报「另一个进程正在使用此文件」）：

```
powershell -NoProfile -File scripts/swap-desktop-asar.ps1
powershell -NoProfile -File scripts/swap-desktop-asar.ps1 -Revert   # 回滚
```

脚本会校验 SHA256、保留 `app.asar.pre-autoswitch.bak`、失败自动回滚。归档本身只长了 24 字节（21 字节补丁 + 对齐），其余 11470 个条目逐字节未动。

**官方更新会换掉 asar，补丁随之失效**——重打一次即可。

### 其它

```
dsh-account status                       # 状态与存储位置
dsh-account rename acct-af3bded5 工作号  # 改昵称
dsh-account remove 工作号                # 移除（活跃账号需要 --force）
dsh-account identify                     # 补全平台身份并合并重复记录
dsh-account list --json                  # 给脚本用
```

### 插件内使用

宿主侧暴露了 `ctx.accountSwitch`，任何插件都能调：

```js
await ctx.accountSwitch.overview()        // { accounts, activeId, warnings, ... }
await ctx.accountSwitch.use('主号')       // 切换
await ctx.accountSwitch.park()            // 撤下当前
await ctx.accountSwitch.capture()         // 归档当前
```

---

## 验证

```
node --test                    # 36 项单元测试，全部在隔离 tmp 目录里跑
node scripts/drill.mjs <隔离 home> --i-know-this-writes-files
```

`scripts/drill.mjs` 是拿一份真格式的凭证库副本跑完整流程（归档 → 幂等 → 模拟登录第二个 → 切换 → 校验官方持有的部分逐字未动）。它默认拒绝在 `$DSH_HOME` 上运行——这类工具最容易犯的错就是把真人正在用的凭证库当演练场。

另有一项只在装配时做的验证：用**内核自己那份** cordis / schemastery 加载插件，并让内核的 schemastery 实例去解析插件声明的 `Config`。这能一次性证伪「插件自带第二份 cordis、`Service` 基类跟宿主不是同一个」这类只在运行时才暴露的问题——`.npmrc` 里的 `legacy-peer-deps=true` 就是为了防它复发。

---

## 踩过的坑：目录联接会让包整个不被加载

一度把插件以 junction（`New-Item -ItemType Junction`）挂进 profile 的 `node_modules`，图的是改代码立即生效、不用同步。结果是：**Harness 完全不加载它**，连插件自己的 `apply()` 都不会被调用，全程没有任何报错——从外部看和「插件根本没装」一模一样。

定位靠三个对照探针，一次重启：

| 探针 | 形态 | 结果 |
| --- | --- | --- |
| `probe-min-dir` | 真实目录 | 写出了留痕 |
| `probe-min-link` | 目录联接 | 什么都没写 |
| 完整插件 | 目录联接 | 什么都没写 |

三个包除了形态之外没有别的差别。改成真实目录后立刻正常。

先前读代码时判断 junction 应该没问题（`canonicalPath` 走 `realpathSync`、`linkedProfileRoots` 会扫符号链接），是实验推翻了它。所以现在一律用 `scripts/sync-install.ps1` 复制真实目录，改完代码重跑一次。

---

## 踩过的坑：`export default` 会让插件静默失效

第一版装上去之后**什么都没发生**——没有产物、没有报错、凭证库纹丝不动。

原因在 `cordis-plugin-loader` 的 `unwrapExports()`：

```js
unwrapExports(exports) {
    if (isNullable(exports)) return exports;
    exports = exports.default ?? exports;   // ← default 优先于 apply
    if (!exports.__esModule) return exports;
    return exports.default ?? exports;
}
```

当时插件同时导出了 `apply` 和 `export default AccountSwitch`。加载器取走了那个**类**并把它当插件实例化：`super(ctx, 'accountSwitch')` 照常注册服务、**不报任何错**，而 `apply()` 从头到尾没被调用。对照 `dsh-proxy-boot`——它只有 `name` + `apply`，所以一切正常。

所以这个插件**不导出 `default`**，也不导出静态 `inject`（静态 inject 会让插件在依赖不就绪时静默挂起，连「我到底有没有被加载」都无从判断）。credentials 的等待改成 `apply` 里显式 `ctx.inject()`。

为了下次不用靠推理：`apply()` 的第一件事是写 `$DSH_HOME/accounts/load-probe.json`。它存在就等于 `apply` 真的被 cordis 调用了；不存在就说明插件压根没进加载列表——这两种失败在外部表现上一模一样，留痕是唯一能一刀切开它们的东西。

---

## 已知边界

| 情况 | 结果 |
| --- | --- |
| 官方 UI 点「退出登录」 | default 被删，**槽位不受影响**；但那次 `revoke` 会让该账号的 token 在服务端失效，切回去会 401 |
| token 过期或被平台拒绝 | 官方 `rejectToken()` 只清 default，槽位里的存档仍在（内容已失效，需要重新登录） |
| 切换时目标槽位为空 | 拒绝切换并保持原状——清掉 default 等于当场把登录弄丢 |
| default 里是坏记录 | 拒绝归档，只告警；坏记录交给官方处理，插件不替它做决定 |
| 有人在 Harness 之外改了凭证库 | 下次 `list` 会点名报出「槽位存在但注册表没有对应条目」 |
| 并发写 | CLI 与 Harness 抢的是**同一把锁**（`<file>.lock`、`wx` 创建、内容为 pid，与官方 `@deepseek-ai/dsh-atomic-write` 约定一致） |
| 账号库里只有一个账号 | 自动换号无事可做，额度错误照常报出——它不会凭空造一个账号出来 |
| 所有账号都烧干 | 一轮试完即收手，把原始错误如实交给官方；冷却期内不会重复切换，不会来回横跳 |
| 充值之后 | 过了 `quotaChainResetMs` 冷却，那个账号自动回到候选里，不需要重启也不需要手工清状态 |

---

## 安全

`.credentials.yaml` 里是 token 明文，跟官方行为一致（官方就是这么存的），所以保护它的手段就是文件权限。

**装之前值得知道的一件事**：这个文件的 ACL 里可能有 `CodexSandboxUsers: ReadAndExecute`。也就是说跑在 Harness 沙箱里的任何进程都能直接读走里面的 token 和 API key。要收紧就把那条继承来的 ACE 摘掉。

本插件自己不额外复制秘密：`registry.json` 只有指纹，`list --json` 也不输出 token。

**本仓库的忽略规则**：`.credentials.yaml`、`accounts/`、`registry.json`、`quota-switch.log`、`key_pool.json`、`*.token` 等一律在 `.gitignore` 里。克隆下来放到你自己的机器上，账号池是你自己的，不会跟着仓库走。

---

## License

MIT

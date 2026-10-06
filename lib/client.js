/**
 * dsh-account-switch —— 浏览器端（设置页里的「账号」页）。
 *
 * 这是手写的 bundle，没有构建步骤。格式照抄 `@deepseek-ai/dsh-client-ui-settings-plugins`
 * 的产物：外层是 `window.__ModuleLoader__.load({ id, factory })`，`factory` 收到一个
 * `require`，用它取运行时提供的模块（react、槽位服务等），最后返回 `module.exports`。
 * 因为没有 JSX 编译，组件一律用 `react.createElement` 写。
 *
 * 与宿主侧的约定只有一条：整块数据都从 host 注册的 `accountSwitch` wire namespace 取。
 * 取用走运行时的 `ctx.get('remote')`，**不写进 `inject`** —— 理由见下面 `inject` 那段。
 * 真正的逻辑在 host 的 `core.js` 里，与 CLI 共用同一份，
 * 所以这里不复制任何一条判断——UI 只负责显示和发起动作。
 *
 * 已挂载事件的刷新走 `ctx.remote.$on`（Gateway 转发的 Cordis 事件），所以在别处
 * （比如 CLI）改了账号库，这个页面会自己更新。
 */

window.__ModuleLoader__.load({
  id: 'dsh-account-switch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** 本页拥有的字典命名空间。 */
    const NS = 'settings.account-switch'

    /**
     * 界面的构建标记，显示在标题旁。
     *
     * 存在的理由很具体：关掉设置窗再打开**不会**重新加载这个 bundle（那是同一个 React 应用），
     * 只有整页刷新或重启 Harness 才会。没有标记的话，「界面看起来没变」既可能是代码没生效，
     * 也可能是功能本身有问题，两者分不开。改这个文件时顺手改一下它。
     */
    const UI_BUILD = 'b12'

    const zh = {
      nav: '账号',
      title: '账号',
      intro: '登录多个 DeepSeek 账号并随时切换。切换是全局的——切完所有会话都用新账号。',
      loading: '正在读取账号库…',
      empty: '账号库还是空的。登录一个账号后，插件会自动把它收录进来。',
      active: '使用中',
      archived: '无存档',
      switch: '切换',
      rename: '重命名',
      remove: '移除',
      confirm: '确认移除',
      save: '保存',
      cancel: '取消',
      add: '添加账号',
      addHint: '在浏览器里完成授权即可。当前账号不会被注销，会自动存进账号库。',
      added: '已发起登录。完成浏览器里的授权后，新账号会被自动收录。',
      dialogTitle: '添加账号',
      dialogIntro: '授权在系统浏览器里完成。选一种方式开始——先复制链接，可以在别的浏览器或无痕窗口里打开。',
      dialogOpen: '打开浏览器',
      dialogCopy: '复制链接',
      dialogClose: '取消',
      dialogStarting: '正在向平台申请授权链接…',
      dialogStarted: '已发起授权。完成浏览器里的授权后，新账号会自动进入账号库。',
      dialogCopied: '链接已复制。到浏览器里完成授权即可。',
      dialogCopyFailed: '复制失败，请从浏览器地址栏手动复制。',
      dialogNoLink: '没能拿到授权链接（平台未回应，或链接还没生成）。稍后重试一次。',
      dialogDone: '授权完成，账号已入库。',
      dialogFinish: '完成',
      switches: '切换',
      times: '次',
      recent: '最近',
      never: '—',
      busy: '处理中…',
    }

    const en = {
      nav: 'Accounts',
      title: 'Accounts',
      intro: 'Sign in to several DeepSeek accounts and switch between them at will. Switching is global: every session uses the new account.',
      loading: 'Reading the account store…',
      empty: 'The account store is empty. Sign in once and the plugin files it automatically.',
      active: 'In use',
      archived: 'not archived',
      switch: 'Switch',
      rename: 'Rename',
      remove: 'Remove',
      confirm: 'Confirm',
      save: 'Save',
      cancel: 'Cancel',
      add: 'Add account',
      addHint: 'Finish the authorization in your browser. The current account is not revoked — it gets filed automatically.',
      added: 'Sign-in started. Once the browser authorization completes, the new account is filed automatically.',
      dialogTitle: 'Add account',
      dialogIntro: 'Authorization happens in your system browser. Pick how to start — copying the link lets you open it in another browser or a private window.',
      dialogOpen: 'Open browser',
      dialogCopy: 'Copy link',
      dialogClose: 'Cancel',
      dialogStarting: 'Requesting an authorization link…',
      dialogStarted: 'Sign-in started. Once the browser authorization completes, the new account is filed automatically.',
      dialogCopied: 'Link copied. Finish the authorization in your browser.',
      dialogCopyFailed: 'Copy failed — copy the link from the browser address bar instead.',
      dialogNoLink: 'No authorization link yet (the platform did not answer, or the link is still being created). Try again in a moment.',
      dialogDone: 'Authorization complete; the account is filed.',
      dialogFinish: 'Done',
      switches: 'switches',
      times: '',
      recent: 'last',
      never: '—',
      busy: 'Working…',
    }

    const styles = {
      section: { maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '12px' },
      heading: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' },
      hint: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
      },
      dot: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1 },
      dotActive: { fontSize: '10px', color: 'var(--dsw-alias-state-business-primary, #4d6bfe)', lineHeight: 1 },
      label: { fontSize: '14px', color: 'var(--dsw-alias-label-primary)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      id: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      meta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      spacer: { flex: 1 },
      button: {
        font: 'inherit',
        fontSize: '13px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: '13px',
        padding: '5px 12px',
        borderRadius: '6px',
        border: '0.5px solid transparent',
        background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
        color: '#fff',
        cursor: 'pointer',
      },
      buttonDanger: {
        font: 'inherit',
        fontSize: '13px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-state-error-primary, #d33)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #d33)',
        cursor: 'pointer',
      },
      input: {
        font: 'inherit',
        fontSize: '13px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        maxWidth: '220px',
      },
      note: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      error: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #d33)' },
      toolbar: { display: 'flex', alignItems: 'center', gap: '10px' },
      /*
       * 自绘弹窗，不 require 官方的 Modal。
       *
       * bundle 的 `require` 能拿到运行时模块，但部件库不在本插件的 inject 里，
       * 换一个 Harness 版本就可能改名；而弹窗本身只需要一层遮罩加一张卡片。
       * 背景色给 `Canvas` 兜底：DSH 的主题变量若哪天改名，系统色仍会跟随
       * 明暗模式，不会出现「暗色主题下一块白板」。
       */
      overlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      },
      dialog: {
        width: 'min(460px, calc(100vw - 32px))',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '20px',
        borderRadius: '12px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-primary, Canvas)',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.28)',
      },
      dialogTitle: { margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      dialogText: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
      dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
    }

    /** 把错误对象压成一行可读文本——Remote 抛回来的可能是任意形状。 */
    function describe(cause) {
      if (cause && typeof cause.message === 'string') return cause.message
      return String(cause)
    }

    /** 时间戳转本地短串；空值给一个破折号。 */
    function shortTime(value, fallback) {
      if (typeof value !== 'string' || value.length === 0) return fallback
      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
    }

    /**
     * 「添加账号」弹窗。
     *
     * 存在的理由：这个动作以前是一点就走——宿主侧一发起，Desktop 外壳就把系统浏览器
     * 打开了（`shell.openExternal`，挂在对账号状态的常驻 watch 上）。而登录链接是 host
     * 公开返回的 `AccountView.attempt.authorizeUrl`，所以完全有条件先问一句。
     *
     * 现在点击只打开这张卡片；是否发起、以及发起之后怎么用那条链接，由这里的按钮决定：
     *   · 打开浏览器 —— 交给系统默认浏览器；
     *   · 复制链接   —— 复制到剪贴板，自己贴到别的浏览器或无痕窗口里打开。
     *
     * 两个动作都调同一个 startSignIn：链接只能由平台生成（PKCE 挑战、state 与回调地址
     * 都在 host 侧），没有第二条路可以凭空造一条链接出来。
     */
    function AddAccountDialog(props) {
      const t = props.t
      const busy = props.busy === true
      const note = props.note
      const error = props.error
      return h(
        'div',
        {
          style: styles.overlay,
          // 点遮罩关闭：只在空闲时允许——正在发起时关掉，会让人以为这次没发起。
          onClick: busy ? undefined : props.onClose,
        },
        h(
          'div',
          {
            style: styles.dialog,
            role: 'dialog',
            'aria-modal': 'true',
            // 卡片内部的点击不该冒泡到遮罩上，否则点一下就关。
            onClick: (event) => event.stopPropagation(),
          },
          h('h3', { style: styles.dialogTitle }, t('dialogTitle')),
          // 完成之后那句「选一种方式开始」就自相矛盾了，留着只会让人以为自己漏了一步。
          props.done === true ? null : h('p', { style: styles.dialogText }, t('dialogIntro')),
          busy ? h('p', { style: styles.hint }, t('dialogStarting')) : null,
          note !== null && note !== undefined ? h('p', { style: styles.note }, note) : null,
          error !== null && error !== undefined ? h('p', { style: styles.error }, error) : null,
          h(
            'div',
            { style: styles.dialogActions },
            /*
             * 授权完成后只剩一个动作：关掉它。
             *
             * 这时再摆「复制链接 / 打开浏览器」是纯噪音——链接已经用过了、浏览器也开过了，
             * 那两个按钮此刻只会让人以为还有一步没做完。
             */
            props.done === true
              ? h(
                  'button',
                  { type: 'button', style: styles.buttonPrimary, onClick: props.onClose },
                  t('dialogFinish'),
                )
              : [
                  h(
                    'button',
                    { key: 'cancel', type: 'button', style: styles.button, disabled: busy, onClick: props.onClose },
                    t('dialogClose'),
                  ),
                  h(
                    'button',
                    { key: 'copy', type: 'button', style: styles.button, disabled: busy, onClick: props.onCopy },
                    t('dialogCopy'),
                  ),
                  h(
                    'button',
                    { key: 'open', type: 'button', style: styles.buttonPrimary, disabled: busy, onClick: props.onOpen },
                    t('dialogOpen'),
                  ),
                ],
          ),
        ),
      )
    }

    /**
     * 设置页里的「账号」区块。
     *
     * `props.t` 与 `props.call` 由宿主在注册时注入。`call` 必须是一个稳定的引用，
     * 否则下面 `refresh` 的依赖每次渲染都会变，`useEffect` 会自己把自己转成死循环。
     */
    function AccountSection(props) {
      const t = props.t
      const call = props.call
      const addAccount = props.addAccount
      const waitForLink = props.waitForAuthorizeUrl

      const [state, setState] = react.useState({ phase: 'loading', accounts: [], activeId: null, warnings: [] })
      const [busy, setBusy] = react.useState(null)
      const [note, setNote] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [editing, setEditing] = react.useState(null)
      const [confirming, setConfirming] = react.useState(null)
      /** 「添加账号」弹窗的状态；关闭时为 null。 */
      const [dialog, setDialog] = react.useState(null)
      /** 发起登录那一刻的账号数量，用来把「库里多了一个」当成授权完成的信号。 */
      const addBaseline = react.useRef(null)

      const refresh = react.useCallback(async () => {
        try {
          const next = await call('overview')
          setState({ phase: 'ready', accounts: next.accounts ?? [], activeId: next.activeId ?? null, warnings: next.warnings ?? [] })
        } catch (cause) {
          setState({ phase: 'failed', accounts: [], activeId: null, warnings: [] })
          setError(describe(cause))
        }
      }, [call])

      react.useEffect(() => {
        refresh()
      }, [refresh])

      // 在别处改了账号库（CLI、登录流程）时自己跟上。
      react.useEffect(() => {
        if (!props.subscribe) return undefined
        return props.subscribe(refresh)
      }, [props.subscribe, refresh])

      /** 跑一个账号动作：置忙、执行、刷新列表、把失败摊到页面上。 */
      const run = react.useCallback(
        async (key, action, success) => {
          setBusy(key)
          setError(null)
          setNote(null)
          try {
            await action()
            await refresh()
            if (success) setNote(success)
          } catch (cause) {
            setError(describe(cause))
          } finally {
            setBusy(null)
            setConfirming(null)
            setEditing(null)
          }
        },
        [refresh],
      )

      /** 给授权链接补上主题参数——登录页与当前明暗模式保持一致。 */
      const withTheme = (url) => {
        try {
          const next = new URL(url)
          const dark =
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
          next.searchParams.set('theme', dark ? 'dark' : 'light')
          return next.href
        } catch {
          return url
        }
      }

      /**
       * 发起一次添加账号。
       *
       * 两条路都走同一个 `startSignIn`——登录链接只能由平台生成（PKCE 挑战、state 与
       * 本地回调地址都在宿主侧），没有第二条路可以凭空造一条链接出来。差别只在拿到
       * 链接之后：`copy` 把它放进剪贴板，`open` 显式交给系统浏览器。
       *
       * 链接通常**不在** `startSignIn` 的返回值里：那个调用返回的是它那一刻的状态，
       * 而链接要等宿主向平台请求 `auth_init` 回来才有。所以拿到返回先看一眼，没有就
       * 用 `waitForLink` 等它出现——等待期间弹窗一直停在「正在申请授权链接…」。
       */
      const beginAdd = react.useCallback(
        async (mode) => {
          setDialog({ busy: true, note: null, error: null, done: false })
          addBaseline.current = state.accounts.length
          try {
            const view = await addAccount()
            const attempt = view === null || view === undefined ? null : view.attempt
            let raw = attempt === null || attempt === undefined ? undefined : attempt.authorizeUrl
            if (typeof raw !== 'string' || raw.length === 0) raw = await waitForLink(15_000)
            const link = typeof raw === 'string' && raw.length > 0 ? withTheme(raw) : null
            if (link === null) throw new Error(t('dialogNoLink'))
            if (mode === 'copy') {
              let copied = true
              try {
                await navigator.clipboard.writeText(link)
              } catch {
                copied = false
              }
              // 复制之后用户仍会去浏览器完成授权，所以基线留着：
              // 账号入库时弹窗会自动翻成「已完成」。
              setDialog({ busy: false, note: copied ? t('dialogCopied') : t('dialogCopyFailed'), error: null, done: false })
              return
            }
            /*
             * 自己把浏览器叫起来。
             *
             * Desktop 外壳只在**首次引导**（还没进工作区）时替用户打开授权页——工作区里
             * 那一步已经被去掉了，所以这里必须显式打开，否则点了「打开浏览器」什么都不会发生。
             * Electron 主进程的 `setWindowOpenHandler` 会把 http(s) 的 window.open 转成
             * `shell.openExternal`，交给系统默认浏览器；在 Web 形态下它就是普通的开新标签。
             */
            window.open(link, '_blank')
            setDialog({ busy: false, note: t('dialogStarted'), error: null, done: false })
          } catch (cause) {
            // 这次没发起成功，基线得撤掉，否则之后列表因别的原因为增长会被误读成授权完成。
            addBaseline.current = null
            setDialog({ busy: false, note: null, error: describe(cause), done: false })
          }
        },
        [addAccount, waitForLink, state.accounts.length, t],
      )

      /*
       * 授权完成的信号：账号库里多了一条。
       *
       * 刻意不订阅 attempt 的相位流——那是宿主侧另一条 wire 通道，多挂一条依赖就多一处
       * 会在版本升级后失效的地方。而归档是宿主 `reconcile()` 在授权成功后的必然动作，
       * 列表长度变化足够当信号，复用的还是页面本来就有的刷新回调。
       */
      react.useEffect(() => {
        if (dialog === null || addBaseline.current === null) return
        if (state.accounts.length > addBaseline.current) {
          addBaseline.current = null
          // 到了这一步，「复制链接 / 打开浏览器」已经没有意义：链接用过了、浏览器也开过了。
          setDialog({ busy: false, note: t('dialogDone'), error: null, done: true })
        }
      }, [state.accounts.length, dialog, t])

      const rows = state.accounts.map((account) => {
        const isEditing = editing !== null && editing.id === account.id
        const isConfirming = confirming === account.id
        const controls = []

        if (isEditing) {
          controls.push(
            h(
              'button',
              {
                key: 'save',
                type: 'button',
                style: styles.buttonPrimary,
                disabled: busy !== null,
                onClick: () => run(`rename:${account.id}`, () => call('rename', account.id, editing.draft)),
              },
              t('save'),
            ),
            h(
              'button',
              { key: 'cancel', type: 'button', style: styles.button, onClick: () => setEditing(null) },
              t('cancel'),
            ),
          )
        } else {
          if (!account.active) {
            controls.push(
              h(
                'button',
                {
                  key: 'switch',
                  type: 'button',
                  style: styles.buttonPrimary,
                  disabled: busy !== null,
                  onClick: () => run(`use:${account.id}`, () => call('use', account.id)),
                },
                t('switch'),
              ),
            )
          }
          controls.push(
            h(
              'button',
              {
                key: 'rename',
                type: 'button',
                style: styles.button,
                disabled: busy !== null,
                onClick: () => {
                  setError(null)
                  setNote(null)
                  setEditing({ id: account.id, draft: account.label })
                },
              },
              t('rename'),
            ),
            h(
              'button',
              {
                key: 'remove',
                type: 'button',
                style: isConfirming ? styles.buttonDanger : styles.button,
                disabled: busy !== null,
                onClick: () => {
                  if (!isConfirming) {
                    setConfirming(account.id)
                    return
                  }
                  run(`forget:${account.id}`, () => call('forget', account.id, { force: account.active }))
                },
              },
              isConfirming ? t('confirm') : t('remove'),
            ),
          )
        }

        return h(
          'li',
          { key: account.id, style: styles.row },
          h('span', { style: account.active ? styles.dotActive : styles.dot, title: account.active ? t('active') : '' }, account.active ? '●' : '○'),
          isEditing
            ? h('input', {
                style: styles.input,
                value: editing.draft,
                autoFocus: true,
                onChange: (event) => setEditing({ id: account.id, draft: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') run(`rename:${account.id}`, () => call('rename', account.id, editing.draft))
                  if (event.key === 'Escape') setEditing(null)
                },
              })
            : h('span', { style: styles.label }, account.label),
          h('code', { style: styles.id }, account.id),
          h(
            'span',
            { style: styles.meta },
            `${t('switches')} ${account.switchCount} ${t('times')}`.trim(),
          ),
          h('span', { style: styles.spacer }),
          ...controls,
        )
      })

      const children = [
        h('h2', { key: 'h', style: styles.heading }, `${t('title')} · UI ${UI_BUILD}`),
        h('p', { key: 'i', style: styles.intro }, t('intro')),
        /*
         * 「添加账号」放在列表**上面**。
         *
         * 它原先在列表末尾：账号攒到七八个之后，这条工具栏就被挤出视口，
         * 想加个账号得先滚到底——而账号越多，越可能还要再加。
         */
        h(
          'div',
          { key: 't', style: styles.toolbar },
          h(
            'button',
            {
              type: 'button',
              style: styles.buttonPrimary,
              disabled: busy !== null,
              // 只开弹窗。发起登录这一步交给弹窗里的按钮，不再一点就走。
              onClick: () => {
                setError(null)
                setNote(null)
                setDialog({ busy: false, note: null, error: null, done: false })
              },
            },
            t('add'),
          ),
          h('span', { style: styles.hint }, t('addHint')),
        ),
      ]

      if (state.phase === 'loading') {
        children.push(h('p', { key: 'l', style: styles.hint }, t('loading')))
      } else if (rows.length === 0) {
        children.push(h('p', { key: 'e', style: styles.hint }, t('empty')))
      } else {
        children.push(h('ul', { key: 'u', style: styles.list }, ...rows))
      }

      if (note !== null) children.push(h('p', { key: 'n', style: styles.note }, note))
      if (error !== null) children.push(h('p', { key: 'x', style: styles.error }, error))

      if (dialog !== null) {
        children.push(
          h(AddAccountDialog, {
            key: 'add-dialog',
            t,
            busy: dialog.busy,
            note: dialog.note,
            error: dialog.error,
            done: dialog.done === true,
            onClose: () => {
              // 忙的时候不许关：发起已经出去了，这时候消失只会让人以为没发起。
              if (dialog.busy) return
              addBaseline.current = null
              setDialog(null)
            },
            onCopy: () => beginAdd('copy'),
            onOpen: () => beginAdd('open'),
          }),
        )
      }

      return h('div', { style: styles.section }, ...children)
    }

    /**
     * 浏览器侧依赖只声明必定存在的服务。
     *
     * **刻意不写 `remote.accountSwitch`**：那是本插件 host 侧注册的命名空间，一旦 host
     * 侧注册失败，这条 entry 就会永远 pending —— 而 DSH 的 web boot 要求每条 entry 都
     * activate，一条 pending 就足以让整个界面起不来（实测就是这么崩的）。改成运行时取用，
     * 缺席时页面报一行「不可用」，而不是拖着全站一起崩。
     */
    const inject = ['slots', 'locale']

    /**
     * 挂在设置页里。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'account-switch: section dictionaries')

      // 自己把 host 的 accountSwitch 挂到浏览器端。
      //
      // 不能指望 `dsh-api-remotes`：它的浏览器半边挂的是一份**构建期编译进去的** contribution
      // 白名单（`TYPERT_REMOTE$1..$24`），第三方命名空间永远进不去那份名单——这是这一整轮
      // 排查的终点。但 `ctx.remote.$mount()` 是公开的，插件可以自己挂。
      //
      // 浏览器侧对 codec 的要求低得意外：gateway 的 `requireStrictInputs` 只看 `mode`，
      // 而两端都不调用 `create()`（只在 registry 里检查它是个函数）。所以不需要 zod，
      // 给一个最轻的实现就够。
      const mountContribution = () => {
        const remote = ctx.get('remote')
        if (remote === undefined || typeof remote.$mount !== 'function') return undefined

        const codec = (field) => ({
          mode: 'strict',
          typeSymbol: `dsh-account-switch#accountSwitch/${field}`,
          create: () => ({ parse: (value) => value }),
        })
        const direct = (method, parameters) => ({
          id: `dsh-account-switch#accountSwitch/${method}`,
          service: 'accountSwitchRemote',
          namespace: 'accountSwitch',
          method,
          invocation: { kind: 'direct' },
          parameters: parameters.map((wire) => ({ name: wire, wire, source: 'json', codec: codec(wire) })),
          result: codec(`${method}:result`),
        })

        return remote.$mount({
          package: 'dsh-account-switch',
          descriptors: [
            direct('overview', []),
            direct('use', ['selector']),
            direct('park', []),
            direct('capture', []),
            direct('rename', ['selector', 'label']),
            direct('forget', ['selector', 'options']),
          ],
        })
      }

      ctx.effect(() => {
        let disposed = false
        let unmount
        const mounting = mountContribution()
        if (mounting === undefined) return undefined
        mounting
          .then((dispose) => {
            if (disposed) dispose()
            else unmount = dispose
          })
          .catch((error) => {
            // 挂不上就维持现状：页面会显示服务未就绪，而不是把设置页拖垮。
            console.warn('[account-switch] 挂载 remote contribution 失败', error)
          })
        return () => {
          disposed = true
          if (unmount !== undefined) unmount()
        }
      }, 'account-switch: remote contribution')

      // 这两个都只创建一次、引用恒定：组件把 refresh 挂在它们上面，引用一变就会自我循环。
      //
      // 取命名空间必须用 `ctx.get('remote.accountSwitch')`，不能写成 `remote.accountSwitch`：
      // 每个命名空间是一个独立的 cordis 服务（键名 `remote.<namespace>`），属性访问会被依赖
      // 保护拦下并抛 "cannot get property ... without inject"。而它也不能写进 inject ——
      // 那个服务正是这个插件自己挂上去的，声明依赖等于等自己，会永远 pending
      // （之前那次 web boot 崩溃就是这么来的）。所以：自己挂，然后按名字取。
      //
      // 每次调用的返回值**总是**被包装成 `{ ok: true, value }` 或 `{ ok: false, error }`
      // （见 gateway 浏览器半边的 invoke()）。直接把包装当结果用，会安静地拿到 undefined ——
      // 之前页面显示「账号库还是空的」就是这个：在 `{ok,value}` 上取 `.accounts` 得到
      // undefined，再被兜底成空数组。解包收在这里，调用点就不必各自记得。
      const unwrap = (result) => {
        if (result === null || result === undefined) return result
        if (result.ok === true) return 'value' in result ? result.value : result
        if (result.ok === false) {
          const message = result.error === undefined ? undefined : result.error.message
          throw new Error(message ?? '账号调用失败。')
        }
        return result
      }

      const call = async (method, ...args) => {
        const target = ctx.get('remote.accountSwitch')
        if (target === undefined) {
          throw new Error('账号服务未就绪：remote.accountSwitch 缺席（挂载步骤或宿主侧没有完成）。')
        }
        return unwrap(await target[method](...args))
      }
      const subscribe = (listener) => {
        const remote = ctx.get('remote')
        if (remote === undefined || typeof remote.$on !== 'function') return undefined
        return remote.$on('credentials/record-updated', listener)
      }

      /**
       * 直接发起官方登录流程——**不需要先撤下当前账号**。
       *
       * `PlatformAccount.startSignIn()` 没有任何「必须已登出」的前置条件；它完成时把新 token
       * 写进 `default`，而宿主侧的 `reconcile()` 会先把旧账号抢救进存档槽位再归档新值，所以
       * 覆盖是安全的。之前那版让用户先 park 再去「模型」页登录，是把官方账号页的界面限制
       * （它只给「退出登录」）误当成了架构限制。
       *
       * @returns 登录发起结果。
       */
      const addAccount = async () => {
        const account = ctx.get('remote.account')
        if (account === undefined || typeof account.startSignIn !== 'function') {
          throw new Error('账号服务未就绪：remote.account 缺席。')
        }
        // 回调地址必须是**显式端口的 loopback http origin**——宿主侧的 `loginOrigin()` 会逐条
        // 校验协议、主机名、端口、路径。Electron 里 `window.location.origin` 是 `dsh-app://app`，
        // 会被直接拒掉，所以优先取 `__DSH_TRANSPORT__` 的 streamBaseUrl（官方就是这么做的）。
        const transport = globalThis.__DSH_TRANSPORT__
        const origin =
          transport !== undefined && typeof transport.streamBaseUrl === 'string'
            ? new URL(transport.streamBaseUrl).origin
            : window.location.origin
        try {
          return await unwrap(
            await account.startSignIn(
              {
                version: '0.2.0-rc.2',
                locale: ctx.locale.getSnapshot().active === 'zh' ? 'zh-CN' : 'en',
                timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
              },
              origin,
              'desktop',
            ),
          )
        } catch (error) {
          // 把回调地址一并带出来：宿主侧的 loginOrigin() 对它逐条校验，出问题时那行是唯一的线索。
          throw new Error(`${error?.message ?? String(error)}（回调地址 ${origin}）`)
        }
      }

      /**
       * 等授权链接出现。
       *
       * 为什么需要等：`startSignIn` 返回的是**那一刻**的状态——它内部把
       * `authorization.begin()` 挂成异步任务后立刻 `return getState()`，而 `authorizeUrl`
       * 要等宿主向平台请求 `auth_init` 回来才写进 attempt（相位从 `initializing` 翻到
       * `waiting-browser`）。所以第一次发起时返回值里通常还没有链接；这不是失败，是还没到。
       *
       * 官方的账号页用 `account.watch()` 那条流跟状态；这里只要一条链接，轮询 `getState()`
       * 就够——它是**无参直调**，返回同一份 AccountView，不必把流协议那一层也搬进来。
       *
       * @param timeoutMs - 最长等多久。
       * @returns 链接，或 null（超时 / 已失败 / 服务不可用）。
       */
      const waitForAuthorizeUrl = async (timeoutMs) => {
        const account = ctx.get('remote.account')
        if (account === undefined || typeof account.getState !== 'function') return null
        const deadline = Date.now() + timeoutMs
        for (;;) {
          let view
          try {
            view = unwrap(await account.getState())
          } catch {
            return null
          }
          const attempt = view === null || view === undefined ? null : view.attempt
          const url = attempt === null || attempt === undefined ? undefined : attempt.authorizeUrl
          if (typeof url === 'string' && url.length > 0) return url
          // 已经明确失败/取消/过期：不必熬满超时。
          if (
            attempt !== null &&
            attempt !== undefined &&
            (attempt.phase === 'failed' || attempt.phase === 'cancelled' || attempt.phase === 'expired')
          ) {
            return null
          }
          if (Date.now() >= deadline) return null
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      }

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'accounts',
            order: 20,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t, call, subscribe, addAccount, waitForAuthorizeUrl }),
          },
          AccountSection,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

/**
 * `dsh-proxy-control` 的配置界面（客户端半边）。
 *
 * 手写纯 JS，不经过打包器：模块由宿主的客户端模块系统按
 * `package.json` 的 `dsh.client` 声明扫描，通过 `exports["./client"]` 加载，
 * 这里用 `window.__ModuleLoader__.load()` 注册自己。界面用 React.createElement
 * 构造（仓库里没有 JSX 编译步骤），数据走宿主注册的
 * `/proxy-control/*` 回环接口。
 */

window.__ModuleLoader__.load({
	id: 'dsh-proxy-control',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		const React = require('react')
		const h = React.createElement
		const { useCallback, useEffect, useState, useSyncExternalStore } = React

		const NS = 'proxy-control'

		const zh = {
			title: '代理',
			intro: '让 Harness 的出站请求经由你指定的代理。改动立即生效，无需重启。',

			mode: '代理来源',
			modeHelp:
				'「内置」= 插件不干预，路由由 DSH 决定（启动前导出的变量，或 $DSH_HOME/.env）\n「系统」读 Windows 的代理设置\n「手动」用你自己填的地址。',
			modeBuiltin: '内置',
			modeSystem: '系统',
			modeManual: '手动',
			modeInactive: '未选中',

			builtin: '内置代理',
			builtinHelp:
				'DSH 启动时只读两处：启动前导出的进程环境变量，以及 $DSH_HOME/.env（可在其中写 HTTP_PROXY / HTTPS_PROXY），两处都没有就是直连。\n该文件只在启动时读一次，所以本次运行中这一项不会变，「重新读取」只是重新显示，改 .env 必须重启。\n注意：只设 HTTPS_PROXY 时，http:// 目标仍然直连。',
			builtinRefresh: '重新读取',
			envSourceLabel: '来源：',
			envFromProcess: '启动前导出的环境变量',

			system: '系统代理',
			systemHelp:
				'支持 host:port 与 http=…;https=… 两种写法\n没有打开或没配地址就是直连，这也是有效状态。\n不解析 PAC，以及系统 bypass 列表里的通配写法（127.*、<local>）本 Harness 不支持，会被整份忽略。',
			systemRefresh: '重新探测',
			systemPac: 'PAC 脚本（本 Harness 不解析）',
			systemWebOnly: '这一项只在桌面版提供：它读的是运行 dsh 那台机器的 Windows 设置，Web 端不提供。',
			systemWindowsOnly: '这一项只在 Windows 上有：它读的是 Windows 的 Internet Settings。',

			address: '代理地址',
			addressHelp:
				'例如 http://127.0.0.1:7890。SOCKS 暂不支持：Harness 的联网抓取（web_fetch）只能经由 http/https 代理，SOCKS 覆盖不到它。',

			bypass: '直连名单（简单分流）',
			bypassHelp:
				'一条写主机名，连同它的子域名一起匹配（写 example.com 也会放行 api.example.com）\n* 放行全部\n可以带 :端口\n不支持 CIDR（10.0.0.0/8 这类）。回环地址始终直连。内置模式下本项不生效，以环境变量里的 NO_PROXY 为准。',

			testUrl: '自测地址',
			testUrlHelp:
				'自测走的是 Harness 自己的调用路径（全局 fetch，也就是 LLM 请求、搜索、MCP 用的那条），所以它回答的是"你的配置生效后会怎样"：会经哪个代理、或者直连，以及实际通不通。',

			layerPlugin: '本插件的配置',
			layerLaunch: '启动环境（.env 或已导出的变量）',
			testing: '处理中…',
			test: '测试',
			testOk: '连通',
			testFail: '不通',
			directShort: '直连',
			ms: '毫秒',
			via: '经由',
			installed: '生效中的代理',
			loadFailed: '读取状态失败',
			saveFailed: '保存失败',
			testFailed: '测试失败'
		}

		const en = {
			title: 'Proxy',
			intro: "Route the Harness's outbound requests through a proxy you choose. Changes apply immediately, no restart.",

			mode: 'Proxy source',
			modeHelp:
				'"Built-in" = the plugin stays out of it, routing is up to DSH (variables exported before launch, or $DSH_HOME/.env)\n"System" reads the Windows proxy settings\n"Manual" uses the address you enter.',
			modeBuiltin: 'Built-in',
			modeSystem: 'System',
			modeManual: 'Manual',
			modeInactive: 'not selected',

			builtin: 'Built-in proxy',
			builtinHelp:
				'At launch DSH reads only two places: process variables exported before launch, and $DSH_HOME/.env (where HTTP_PROXY / HTTPS_PROXY can be written). Neither present means direct.\nThat file is read once at launch, so this cannot change during the run: "Read again" only re-displays it, and editing .env requires a restart.\nNote: setting only HTTPS_PROXY leaves http:// targets direct.',
			builtinRefresh: 'Read again',
			envSourceLabel: 'source:',
			envFromProcess: 'variables exported before launch',

			system: 'System proxy',
			systemHelp:
				'Accepts both host:port and http=…;https=… forms\nBeing off, or having no address configured, means direct — also a valid state.\nPAC is not parsed, and wildcard entries in the system bypass list (127.*, <local>) are not supported by this Harness — the list is dropped wholesale.',
			systemRefresh: 'Detect again',
			systemPac: 'PAC script (this Harness does not parse it)',
			systemWebOnly: 'This one is desktop-only: it reads the Windows settings of the machine running dsh, and the web build does not offer it.',
			systemWindowsOnly: 'This one exists on Windows only: it reads the Windows Internet Settings.',

			address: 'Proxy address',
			addressHelp:
				'For example http://127.0.0.1:7890. SOCKS is not supported yet: the Harness web fetch can only go through an http/https proxy, so SOCKS cannot cover it.',

			bypass: 'Direct list (simple splitting)',
			bypassHelp:
				'An entry names a host and also covers its subdomains (example.com lets api.example.com through too)\n* bypasses everything\na :port may be given\nCIDR is not supported (10.0.0.0/8 and the like). Loopback is always direct. This does not apply in Built-in mode, which follows the environment NO_PROXY instead.',

			testUrl: 'Self-test address',
			testUrlHelp:
				'The self-test goes through the Harness\'s own call path (global fetch — the one LLM requests, search and MCP use), so it answers "what will my configuration do": which proxy it routes through, or direct, and whether it actually works.',

			layerPlugin: "this plugin's configuration",
			layerLaunch: 'the launch environment (.env or exported variables)',
			testing: 'Working…',
			test: 'Test',
			testOk: 'reachable',
			testFail: 'unreachable',
			directShort: 'direct',
			ms: 'ms',
			via: 'via',
			installed: 'Proxy in effect',
			loadFailed: 'Could not read the state',
			saveFailed: 'Could not save',
			testFailed: 'Test failed'
		}

		/** 调用宿主接口；非 2xx 时把宿主给的 error 抛出来。 */
		async function call(path, init) {
			const response = await fetch(path, Object.assign({ cache: 'no-store' }, init))
			let body = null
			try {
				body = await response.json()
			} catch {
				body = null
			}
			if (!response.ok) throw new Error((body && body.error) || String(response.status))
			return body
		}

		const api = {
			state: () => call('/proxy-control/state'),
			config: (patch) =>
				call('/proxy-control/config', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(patch)
				}),
			test: (body) =>
				call('/proxy-control/test', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body || {})
				}),
			refresh: () =>
				call('/proxy-control/refresh', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}'
				})
		}

		/**
		 * 悬停说明的气泡样式。
		 *
		 * 用一张小样式表而不是内联样式：`:hover` 做不到内联。类名带前缀避免撞上别人的样式，
		 * 颜色全部走主题变量，深色/浅色都跟着走。没有 document 时（测试环境）静默跳过。
		 */
		const STYLE_ID = 'dsh-proxy-control-style'
		function injectStyles() {
			if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = [
				// 悬停提示的公共部分：外层负责定位与"悬停/聚焦时显示"，内层是气泡本身。
				// 外层而不是按钮承担悬停 —— 按钮 disabled 时收不到鼠标事件，外层照样收得到。
				'.dpc-tipwrap{position:relative;display:inline-flex}',
				// white-space:pre-line 才是让说明里手写的 \n **真的换行**的那一步：默认的 normal
				// 会把换行当普通空白整个压掉，于是一条分了三行写的长说明会挤成一整段。
				// pre-line 只保留换行、其余空白照常合并，正好是"段落分隔"想要的语义。
				'.dpc-tip{display:none;position:absolute;z-index:30;top:20px;left:-6px;width:340px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);box-shadow:var(--dsw-elevation-soft,0 4px 16px rgba(0,0,0,.12));font-size:12px;line-height:18px;white-space:pre-line}',
				// 短提示（图标按钮用）：一句话，居中在图标正下方。
				//
				// `width:max-content` 不是可有可无的：绝对定位 + `left:50%` + `width:auto` 时，
				// 收缩到合适的**可用宽度**等于"包含块宽度 − left 偏移"，而包含块只有那个 28px 的
				// 图标按钮 —— 于是可用宽度只剩十来像素。允许折行（继承上面的 pre-line）的文本
				// 就会挤成一列，一个字一行。`max-content` 让盒子直接按最长那行的宽度撑开，
				// 与"可用宽度"无关，所以一行放得下就一行；`max-width` 只在真的超长时才让它折成两行。
				'.dpc-tip-short{width:max-content;max-width:260px;top:30px;left:50%;transform:translateX(-50%);padding:6px 10px;text-align:center}',
				'.dpc-tipwrap:hover .dpc-tip,.dpc-tipwrap:focus-within .dpc-tip{display:block}',
				'.dpc-help{position:relative;display:inline-flex}',
				'.dpc-help-button{width:15px;height:15px;padding:0;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:1;cursor:help}',
				'.dpc-help-button:hover{color:var(--dsw-alias-label-primary)}',
				'.dpc-help:hover .dpc-help-tip,.dpc-help:focus-within .dpc-help-tip{display:block}',
				// 图标按钮：正方形、只放一个描边图标，语义靠 aria-label 与悬停提示。
				'.dpc-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
				'.dpc-icon:enabled:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}',
				'.dpc-icon:disabled{opacity:0.5;cursor:default}',
				'.dpc-icon svg{display:block}'
			].join('')
			document.head.appendChild(style)
		}
		injectStyles()

		const COLOR = {
			text: 'var(--dsw-alias-label-primary)',
			dim: 'var(--dsw-alias-label-tertiary)',
			secondary: 'var(--dsw-alias-label-secondary)',
			border: 'var(--dsw-alias-border-l2)',
			field: 'var(--dsw-alias-bg-module-platform)',
			good: 'var(--dsw-static-green-500)',
			warn: 'var(--dsw-static-amber-500)'
		}

		const fieldStyle = {
			boxSizing: 'border-box',
			width: '100%',
			padding: '8px 10px',
			border: '0.5px solid ' + COLOR.border,
			borderRadius: 'var(--dsw-radius-sm)',
			background: COLOR.field,
			color: COLOR.text,
			font: 'inherit',
			fontSize: '13px'
		}

		/** 未选中时整体压暗，配合 disabled 让"这一项此刻不起作用"一眼可见。 */
		const disabledStyle = (active) => ({ opacity: active ? 1 : 0.55 })

		/**
		 * 标题旁的小问号，悬停或键盘聚焦时展开长说明。
		 *
		 * 长说明始终出现在 DOM 里（只是被 CSS 藏着），所以测试可以直接断言它的内容。
		 */
		function Help(props) {
			return h(
				'span',
				{ className: 'dpc-help' },
				h('button', { type: 'button', className: 'dpc-help-button', tabIndex: -1, 'aria-label': '说明' }, '?'),
				h('span', { className: 'dpc-help-tip dpc-tip' }, props.text)
			)
		}

		/**
		 * 图标按钮用的图形。
		 *
		 * 内联 SVG 而不是图标字体或组件库：客户端半边是手写纯 JS、不打包，内联是唯一
		 * 不用额外依赖也不怕缺字形的做法。描边路径取自 Feather 图标集（MIT）。
		 */
		const ICONS = {
			/** 重新读取/重新探测：环形箭头。 */
			refresh: [
				['polyline', { points: '23 4 23 10 17 10' }],
				['polyline', { points: '1 20 1 14 7 14' }],
				['path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }]
			],
			/** 测试连接：信号波。 */
			signal: [
				['path', { d: 'M5 12.55a11 11 0 0 1 14.08 0' }],
				['path', { d: 'M1.42 9a16 16 0 0 1 21.16 0' }],
				['path', { d: 'M8.53 16.11a6 6 0 0 1 6.95 0' }],
				['line', { x1: '12', y1: '20', x2: '12.01', y2: '20' }]
			]
		}

		/** 画一个描边图标；颜色跟随按钮的 currentColor，禁用时随透明度一起变暗。 */
		function Icon(props) {
			const shapes = ICONS[props.name] || []
			return h(
				'svg',
				{
					width: 15,
					height: 15,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true'
				},
				shapes.map(([tag, attributes], index) => h(tag, Object.assign({ key: 's' + index }, attributes)))
			)
		}

		/**
		 * 图标按钮：按钮上只有一个图标，功能写在悬停提示里。
		 *
		 * 提示挂在**外层 span** 而不是按钮上：禁用时按钮收不到鼠标事件，外层照样收得到 ——
		 * 而"为什么这个按钮是灰的"恰恰是用户最需要提示的时候。
		 */
		function IconButton(props) {
			return h(
				'span',
				{ className: 'dpc-tipwrap' },
				h('button', { type: 'button', className: 'dpc-icon', disabled: props.disabled === true, onClick: props.onClick, 'aria-label': props.label }, h(Icon, { name: props.icon })),
				h('span', { className: 'dpc-tip dpc-tip-short' }, props.tip)
			)
		}

		/**
		 * 一行设置：主行（标题 + 可选悬停说明 + 可选状态标记，右侧控件）+ 可选页脚。
		 *
		 * 行里**不放解释性文字** —— 解释都在 `?` 的悬停面板里。行内只留"当前事实"：未选中的标记，
		 * 以及 `footer`（例如"此刻实际在生效的是哪个代理"、自测结果）。
		 *
		 * 这类事实**另起一行放在主行下方**，而不是塞进主行里：塞进去会把主行撑高，
		 * 而主行是 `alignItems:center` 的，于是右侧控件（三个单选、输入框）会跟着上下跳 ——
		 * 出现在下方则主行高度不动，只有这一行的总高度变化。
		 */
		function Row(props) {
			return h(
				'div',
				{ style: { padding: '14px 0', borderBottom: '0.5px solid ' + COLOR.border } },
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: '16px' } },
					h(
						'div',
						{ style: { flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px' } },
						h('div', { style: { color: COLOR.text, fontSize: '14px', lineHeight: '22px' } }, props.label),
						props.help ? h(Help, { text: props.help }) : null,
						props.badge ? h('span', { style: { color: COLOR.dim, fontSize: '12px' } }, props.badge) : null
					),
					h('div', { style: Object.assign({ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px' }, disabledStyle(props.active !== false)) }, props.children)
				),
				props.footer ? h('div', { style: Object.assign({ marginTop: '6px', fontSize: '12px', lineHeight: '18px' }, disabledStyle(props.active !== false)) }, props.footer) : null
			)
		}

		/** 从地址里认出协议类型，只用于展示。 */
		function schemeOf(value) {
			const text = String(value || '').trim().toLowerCase()
			if (text.startsWith('https://')) return 'HTTPS'
			if (text.startsWith('http://')) return 'HTTP'
			if (text.startsWith('socks')) return 'SOCKS'
			return ''
		}

		function Panel(props) {
			const locale = props.locale
			const t = locale.bind(NS)
			const snapshot = useSyncExternalStore(
				(listener) => locale.subscribe(listener),
				() => locale.getSnapshot()
			)
			const copy = String((snapshot && snapshot.active) || '').toLowerCase().startsWith('zh') ? zh : en

			const [status, setStatus] = useState(null)
			const [draft, setDraft] = useState(null)
			const [error, setError] = useState('')
			const [busy, setBusy] = useState('')
			const [result, setResult] = useState(null)
			const [detection, setDetection] = useState(null)

			/** 用服务端状态刷新界面。 */
			const adopt = useCallback((next) => {
				setStatus(next)
				setDraft({ proxy: next.settings.proxy, noProxy: next.settings.noProxy, testUrl: next.settings.testUrl })
			}, [])

			const load = useCallback(async () => {
				try {
					adopt(await api.state())
					setError('')
				} catch (cause) {
					setError(copy.loadFailed + '：' + (cause.message || cause))
				}
			}, [adopt, copy])

			useEffect(() => {
				load()
			}, [load])

			/** 保存一个补丁并采纳返回的状态。 */
			const save = useCallback(
				async (patch) => {
					setBusy('save')
					try {
						adopt(await api.config(patch))
						setError('')
					} catch (cause) {
						setError(copy.saveFailed + '：' + (cause.message || cause))
					} finally {
						setBusy('')
					}
				},
				[adopt, copy]
			)

			/**
			 * 屏幕上手打的那三个字段是否还没落盘。
			 *
			 * 用它来判断"失焦要不要写一次"：绝大多数失焦（点进又点出、Tab 穿过）什么都没改，
			 * 那时写一次配置既没必要，还会白白让宿主重装一遍策略。
			 */
			const draftIsDirty = () =>
				status !== null && draft !== null && (draft.proxy !== status.settings.proxy || draft.noProxy !== status.settings.noProxy || draft.testUrl !== status.settings.testUrl)

			/**
			 * 提交三个手打字段（失焦时调用，回车也走它）。
			 *
			 * 之所以"失焦即存"：切来源、重新读取、测试连接都是点了就生效的，只有这三个字段
			 * 还要额外按一次"保存"，那种不一致比"忘了保存"更容易出错。
			 */
			const commitDraft = () => {
				if (busy !== '' || !draftIsDirty()) return undefined
				return save({ proxy: draft.proxy, noProxy: draft.noProxy, testUrl: draft.testUrl })
			}

			const runTest = useCallback(async () => {
				// 先把屏幕上的改动落盘，再测。测试图标就贴在自测地址输入框后面，点它的时候
				// 用户很可能刚改完地址或名单；不先保存就会测到**旧配置**，结果行还会一本正经地
				// 报出一个用户已经改掉的地址。
				//
				// 注意这不是"失焦就测试"：失焦只负责保存，测试永远只由这个图标触发。
				// （点击图标本身会先让输入框失焦、顺带触发一次保存，这里再判一次是为了
				// "保存还没回来"的那一瞬间也测的是新配置。）
				if (draftIsDirty()) await save({ proxy: draft.proxy, noProxy: draft.noProxy, testUrl: draft.testUrl })
				setBusy('test')
				setResult(null)
				try {
					// 只把**测试地址**发过去：路由必须由宿主按当前生效的配置决定。
					// 送一个代理地址过去就等于绕开全局 dispatcher，测出来的不是配置的效果。
					setResult(await api.test(draft ? { testUrl: draft.testUrl } : {}))
				} catch (cause) {
					setResult({ ok: false, error: copy.testFailed + '：' + (cause.message || cause) })
				} finally {
					setBusy('')
				}
			}, [draft, status, save, copy])

			/**
			 * 重新读取"外部来源"。内置（`.env` / 已导出的变量）与系统（注册表）都不是在这里编辑的，
			 * 所以两行各自带一个按钮走同一条路径：强制重读 → 同步策略 → 拿回新状态。
			 */
			const runRefresh = useCallback(async () => {
				setBusy('refresh')
				try {
					const answer = await api.refresh()
					setDetection(answer.detection)
					adopt(answer.state)
					setError('')
				} catch (cause) {
					setError(copy.loadFailed + '：' + (cause.message || cause))
				} finally {
					setBusy('')
				}
			}, [adopt, copy])

			if (status === null || draft === null) {
				return h('div', { style: { color: COLOR.dim, fontSize: '13px', padding: '16px 0' } }, error || copy.testing)
			}

			const effective = status.effective || {}
			const warnings = status.warnings || []
			const environment = status.environment || {}
			const onChange = (key) => (event) => setDraft(Object.assign({}, draft, { [key]: event.target.value }))
			const mode = status.settings.mode
			const systemMode = mode === 'system'
			const envMode = mode === 'env'
			const manualMode = mode === 'manual'

			/**
			 * 「系统代理」在这里能不能用；不能用时给一句具体原因。
			 *
			 * 两种不可用：Web 端（读的是宿主机的 Windows 设置，不在支持范围内）、非 Windows
			 * （没有 Internet Settings 可读）。宿主在状态里用 desktop 与 system.supported 说明，
			 * 界面只负责照说 —— 不允许用户选一个只会得到直连的来源。
			 */
			const systemUnavailable =
				status.system !== undefined && status.system.supported === false
					? status.desktop === false
						? copy.systemWebOnly
						: copy.systemWindowsOnly
					: ''

			/**
			 * 三选一里的一个选项；点一下立刻保存（mode 是 volatile，会就地生效）。
			 *
			 * 切到"内置/系统"后再强制重读一次那一边的值：它们的值都是在别处编辑的，
			 * 用户切换过来时想看的是**此刻**的实际情况，而不是 5 秒缓存里的旧值。
			 *
			 * `system` 在这里不可用时（Web 端、或非 Windows）连选都不让选：选了只会得到
			 * 直连加一句解释，不如直接禁掉，原因写在那一行的 `?` 里。
			 */
			const modeOption = (value, label) =>
				h(
					'label',
					{ style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: busy === '' ? 'pointer' : 'default' } },
					h('input', {
						type: 'radio',
						name: 'proxy-control-mode',
						value: value,
						checked: mode === value,
						disabled: busy !== '' || (value === 'system' && systemUnavailable !== ''),
						// 返回 Promise：React 不看返回值，但测试可以 await 到"保存 + 重读"都完成。
						onChange: () =>
							(async () => {
								await save({ mode: value })
								if (value !== 'manual') await runRefresh()
							})()
					}),
					label
				)

			/**
			 * 系统代理一行：只显示结果 —— 代理服务器，或者「直连」。
			 *
			 * 为什么是直连、去哪里打开它，都写在标题旁的 `?` 里和下面的「当前状态」里；
			 * 行内只留一个能一眼扫过的结论。
			 */
			const systemLine =
				status.system === undefined || status.system.supported === false
					? copy.directShort
					: status.system.enabled && status.system.server
						? status.system.server
						: copy.directShort

			/** 内置一行：同样只显示结果 —— 环境里的代理，或者「直连」。 */
			const envLine = environment.available !== false && environment.proxy ? environment.proxy : copy.directShort

			/**
			 * 值的来源（哪个文件、哪一层）放进悬停说明里：它在排查时很有用，但放在行内会让
			 * 这一行变长，而这一行只需要"是什么"。
			 */
			const envOrigin = environment.path || (environment.source === 'process' ? copy.envFromProcess : environment.source) || environment.envFile || '$DSH_HOME/.env'

			/**
			 * 「此刻实际在生效的是什么」—— 行内的那句话，放在「代理来源」那一行里。
			 *
			 * 读数来自策略模块自己（`proxyRouteFor`），所以它说的就是 `web_fetch` 会照做的；
			 * 括号里点名是这一层（本插件的配置）还是启动环境那层。没有代理就是「直连」。
			 */
			const effectiveText =
				copy.installed +
				'：' +
				(effective.installed || copy.directShort) +
				(effective.layer === 'launch' || effective.layer === 'plugin' ? '（' + (effective.layer === 'launch' ? copy.layerLaunch : copy.layerPlugin) + '）' : '')

			/**
			 * 自测结果那一句话，放在「自测地址」那一行里（紧跟着输入框与测试图标）。
			 *
			 * 先说**配置说会怎样**（经哪个代理 / 直连），再说实际结果 —— 直连也是一种有效结果。
			 */
			const testReport = result
				? (result.ok ? copy.testOk : copy.testFail) +
					' · ' +
					(result.via ? copy.via + ' ' + result.via : copy.directShort) +
					(result.status === undefined ? '' : ' · ' + result.status) +
					(result.latencyMs === undefined ? '' : ' · ' + result.latencyMs + ' ' + copy.ms) +
					(result.error ? ' · ' + result.error : '')
				: ''

			/**
			 * 需要提醒但又没有自己那一行的东西：策略装不上的原因、冲突提示、直连名单的警告。
			 *
			 * 以前它们和"当前状态"挤在一个带分隔线的块里；那两行标签去掉之后，这里只剩这些
			 * 真出了问题才会出现的话，所以不再需要标题与分隔线。
			 */
			const diagnostics = [effective.error, ...(effective.notes || []), ...warnings].filter((line) => typeof line === 'string' && line !== '')

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', color: COLOR.text, fontFamily: 'var(--dsw-font-family)' } },
				h(
					'div',
					{ style: { padding: '4px 0 12px' } },
					h('div', { style: { fontSize: '14px', lineHeight: '22px' } }, t('intro')),
					error ? h('div', { style: { color: COLOR.warn, fontSize: '12px', lineHeight: '18px', marginTop: '8px' } }, error) : null
				),

				// 代理来源：内置 / 系统 / 手动，三选一。
				// 早先这里还有一个"启用代理"总开关 —— 它与"内置"完全重复（两者都是"把控制权交回
				// 启动器那层"），所以删掉了：少一个可以自相矛盾的组合，也就少一类"关着但其实是代理
				// 在生效"的困惑。
				h(
					Row,
					// 「此刻实际在生效的是什么」就写在这一行**下方**：来源和它的当前值放在一起看才成话，
					// 但塞进主行会把单选按钮挤得上下跳，所以走页脚。
					{ label: copy.mode, help: copy.modeHelp, footer: h('div', { style: { color: COLOR.dim } }, effectiveText) },
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' } },
						modeOption('env', copy.modeBuiltin),
						modeOption('system', copy.modeSystem),
						modeOption('manual', copy.modeManual)
					)
				),

				// 三行来源**常驻**，未选中的置灰而不是隐藏：这样能同时看到另两个来源此刻是什么，
				// 也能看清"切换会拿走哪些字段"，不会出现"切过去东西都不见了"的困惑。
				h(
					Row,
					// 「来源」不再塞进 `?` 里：`?` 只放通用解释（两处是哪两处、什么时候读、有什么坑），
					// 而这台机器上**实际读的是哪儿**属于"这一行读出来的结果"，走下面的结果文本 ——
					// 和另外两行的做法一致（自测结果、生效中的代理都在各自行下方）。
					{
						label: copy.builtin,
						help: copy.builtinHelp,
						active: envMode,
						badge: envMode ? undefined : copy.modeInactive,
						footer: h('div', { style: { color: COLOR.dim } }, copy.envSourceLabel + envOrigin)
					},
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: '10px' } },
						h('span', { style: { color: COLOR.dim, fontSize: '13px', maxWidth: '320px' } }, envLine),
						h(IconButton, { icon: 'refresh', label: copy.builtinRefresh, tip: busy === 'refresh' ? copy.testing : copy.builtinRefresh, disabled: busy !== '' || !envMode, onClick: runRefresh })
					)
				),

				h(
					Row,
					// Web 端（或非 Windows）不提供这一项，提示里补一句具体原因，而不是让人对着置灰的行猜。
					{ label: copy.system, help: systemUnavailable === '' ? copy.systemHelp : copy.systemHelp + ' ' + systemUnavailable, active: systemMode, badge: systemMode ? undefined : copy.modeInactive },
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: '10px' } },
						h('span', { style: { color: COLOR.dim, fontSize: '13px', maxWidth: '320px' } }, systemLine),
						h(IconButton, { icon: 'refresh', label: copy.systemRefresh, tip: busy === 'refresh' ? copy.testing : copy.systemRefresh, disabled: busy !== '' || !systemMode, onClick: runRefresh })
					)
				),

				h(
					Row,
					{ label: copy.address, help: copy.addressHelp, active: manualMode, badge: manualMode ? undefined : copy.modeInactive },
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: '8px', width: '320px' } },
						h('input', {
							type: 'text',
							value: draft.proxy,
							placeholder: 'http://127.0.0.1:7890',
							style: fieldStyle,
							disabled: busy !== '' || !manualMode,
							onChange: onChange('proxy'),
							onBlur: commitDraft,
							onKeyDown: (event) => { if (event.key === 'Enter') commitDraft() }
						}),
						schemeOf(draft.proxy) ? h('span', { style: { color: COLOR.secondary, fontSize: '12px' } }, schemeOf(draft.proxy)) : null
					)
				),

				// 直连名单在"内置"模式下不起作用（那种模式以环境变量里的 NO_PROXY 为准），
				// 所以同样置灰，而不是让它看起来可编辑。
				h(
					Row,
					{ label: copy.bypass, help: copy.bypassHelp, active: !envMode, badge: envMode ? copy.modeInactive : undefined },
					h('textarea', {
						value: draft.noProxy,
						rows: 3,
						placeholder: 'api.deepseek.com',
						style: Object.assign({}, fieldStyle, { width: '320px', resize: 'vertical', fontFamily: 'var(--ds-font-family-code)' }),
						disabled: busy !== '' || envMode,
						onChange: onChange('noProxy'),
						onBlur: commitDraft
					})
				),

				h(
					Row,
					{
						label: copy.testUrl,
						help: copy.testUrlHelp,
						// 自测结果写在**输入框下方**（这一行的页脚），不挤在按钮右边：它是"我刚按的那一下
						// 的结果"，放在按钮右边既会把输入框往左推，也会让结果那句话无处折行。
						footer: testReport ? h('div', { style: { color: result.ok ? COLOR.good : COLOR.warn } }, testReport) : null
					},
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: '8px' } },
						h('input', {
							type: 'text',
							value: draft.testUrl,
							placeholder: 'https://www.gstatic.com/generate_204',
							style: Object.assign({}, fieldStyle, { width: '320px' }),
							disabled: busy !== '',
							onChange: onChange('testUrl'),
							onBlur: commitDraft
						}),
						h(IconButton, { icon: 'signal', label: copy.test, tip: busy === 'test' ? copy.testing : copy.test, disabled: busy !== '', onClick: runTest })
					)
				),

				// 系统模式下的补充说明：PAC 与探测过程中记下的提示。
				systemMode && status.system && (status.system.autoConfigUrl || (detection && detection.notes && detection.notes.length))
					? h(
							'div',
							{ style: { color: COLOR.dim, fontSize: '12px', lineHeight: '18px', padding: '10px 0 0' } },
							status.system.autoConfigUrl ? h('div', null, copy.systemPac + '：' + status.system.autoConfigUrl) : null,
							detection && detection.notes && detection.notes.length ? h('div', null, detection.notes.join('；')) : null
						)
					: null,

				// 这里**没有操作区**：切来源、重新读取/重新探测、测试连接都是点了就生效的图标/单选，
				// 手打的三个字段则在**失焦时**自动落盘（见 commitDraft）。早先这里有一个「保存」按钮，
				// 但界面上一半操作即时生效、另一半要记得按按钮，那种不一致本身就是个坑。

				// 只剩下"确实出了问题才出现"的几行：策略装不上的原因、冲突提示、直连名单的警告。
				// 它们各自属于某个字段或某次操作，但都不值得为它们各开一行，所以放在最后，
				// 不带标题也不带分隔线 —— 一条也不出现时这里什么都不渲染。
				diagnostics.length > 0
					? h(
							'div',
							{ style: { paddingTop: '12px', fontSize: '12px', lineHeight: '18px', color: COLOR.warn } },
							diagnostics.map((line, index) => h('div', { key: 'd' + index }, line))
						)
					: null
			)
		}

		exports.inject = ['slots', 'locale']
		exports.apply = function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-proxy-control：词典')
			const t = ctx.locale.bind(NS)
			ctx.slots.inject('settings.section', () =>
				ctx.slots.register(
					{ name: 'settings.section', id: NS, order: 100, label: () => t('title'), locale: NS },
					() => h(Panel, { locale: ctx.locale })
				)
			)
		}

		return module.exports
	}
})

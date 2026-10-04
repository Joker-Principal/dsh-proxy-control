/**
 * `dsh-proxy-control` —— 在运行中控制 Harness 的出站代理。
 *
 * ## 为什么需要它
 *
 * Harness 只在启动时解析一次代理策略：`runProfile()` 会在挂载任何插件之前调用
 * `installProxyFromEnvironment(启动环境)`，所以内置方式改代理的唯一办法是编辑
 * `$DSH_HOME/.env` 然后重启。本插件在运行中重新执行同一次安装，配置来自它自己的
 * Config 条目，因此在设置界面里开关或修改代理，**下一次请求就生效**。
 *
 * ## 为什么必须驱动运行时那一份策略模块
 *
 * 插件自己不实现代理，而是调用 `@deepseek-ai/dsh-http-proxy` 里的
 * `installProxyFromEnvironment` —— 也就是启动器加载过的那一份。
 *
 * **模块实例本身就是设计的一部分**：`dsh-web-fetch-http` 每次都向*同一个实例*询问
 * `proxyRouteFor(url)`，一旦回答"直连"，它就自己解析地址、绕开任何 dispatcher
 * （见它的 `requestOnce`）。如果本插件旁边另装一份同名的包，结果就是全局 dispatcher
 * 走了代理、而 `web_fetch` 仍在直连 —— 一个悄悄半残的代理。所以这里按运行时的安装
 * 锚点解析，保证只有一个实例、一份策略、每个 URL 一个答案。
 *
 * ## 为什么"分流"用直连名单而不是按类别开关
 *
 * 传输层的决策点只有一个，而且只能看到目标 `origin`（协议+主机+端口），看不到是
 * 哪个调用方发出的。具体到本应用：LLM 对话与 web 搜索打的是**同一个 URL**
 * （`https://api.deepseek.com/anthropic/v1/messages`），在 DSH 这一层根本无法分开；
 * 而真正细的分流（域名/GeoIP/进程）代理软件自己做得更好。所以这里提供"直连名单"
 * 一个字段来表达简单分流：把 `api.deepseek.com` 填进去，就是"模型与搜索直连、
 * 其余走代理"。
 *
 * ## 为什么配置字段都是 volatile
 *
 * `SettingsForms.describe()` 只暴露 volatile 字段 —— 这是本插件能出现在设置里、
 * 并且改动**不重挂插件**就能生效的原因：Loader 会把新值原地写进运行中插件的引用，
 * 然后发 `loader/volatile-update` 事件。本插件监听该事件并重新安装策略。
 *
 * @module dsh-proxy-control
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { anchorFor, findInstallAnchor, importFromRuntime } from "./runtime.js";
import { chooseSystemProxy, inspectProxyUrl, normalizeSettings } from "./logic.js";
import { mountProxyRoutes } from "./routes.js";
import { readWindowsSystemProxy, isDesktopHost } from "./system-proxy.js";

/** Loader 身份与日志前缀；profile 里的行 id 也是 `proxy-control`。 */
export const name = "proxy-control";

/** 承载策略的运行时库。 */
const POLICY_PACKAGE = "@deepseek-ai/dsh-http-proxy";
/** 构造 Config 必须用的 schema 库（要用运行时那一份，保证 volatile 语义一致）。 */
const SCHEMA_PACKAGE = "@deepseek-ai/schemastery";

/** 系统代理探测结果的缓存时长：界面刷新时不至于每次都起一个 `reg.exe`。 */
const DETECTION_TTL_MS = 5000;

/** 自测的超时。 */
const PROBE_TIMEOUT_MS = 10000;

/**
 * 旧版本写过、现在已经删掉的配置字段。
 *
 * - `autoDetect`：最早的布尔字段（"地址留空时跟随系统"），后被互斥的 `mode` 取代。
 * - `enabled`：总开关，后被 `mode: "env"`（内置 = 插件不插手）取代 —— 两者在路由上完全等价，
 *   同一个结果没必要有两条路径，见 STATE.md 的决策 6。
 *
 * 必须显式清理，原因是两个行为叠在一起：
 * 1. schemastery **会原样保留** schema 里没有的键（实测 `Schema.object({ a })({ a: true, autoDetect: false })`
 *    返回的对象里仍然有 `autoDetect`），所以旧字段会一路活着进到运行中的配置里；
 * 2. 设置界面只渲染 schema 里有的字段 —— 于是这种遗留键**看不见、也删不掉**（界面永远
 *    没有它的输入框），而 `{ ...当前配置, ...改动 }` 这种合并又会把它一直带下去。
 *
 * 结果就是 profile 的 `cordis.patch.yml` 里永久留着一个不生效的字段，手工编辑配置的人
 * 无法判断它到底还起不起作用。保存是唯一会把配置落盘的路径，所以在这里清掉。
 */
const RETIRED_FIELDS = ["autoDetect", "enabled"];

/**
 * 构造 Config。
 *
 * 这一步必须在模块加载期完成（`Config` 是模块导出，Loader 挂载前就要读它来校验和
 * 投影配置），那时还没有 ctx，所以锚点只能用 `process.argv` 那两条线索。失败是
 * **故意致命**的：没有 Config 就没有设置界面，挂上去反而像成功。
 */
const schemaModule = await importFromRuntime(SCHEMA_PACKAGE, findInstallAnchor());
const z = schemaModule.default ?? schemaModule;

/** 插件配置，由设置界面渲染；每个字段都是 volatile。 */
export const Config = z.object({
	mode: z.union(["manual", "system", "env"]).default("env").description("代理地址从哪来，三者互斥：env 采用启动环境里的代理变量（$DSH_HOME/.env 或已导出的变量，插件不插手），system 用 Windows 系统代理，manual 手动填写。").volatile(),
	proxy: z.string().default("").description("手动模式下的代理地址，例如 http://127.0.0.1:7890。只接受 http:// 与 https://。").volatile(),
	noProxy: z.string().default("").description("直连名单（这就是简单分流）：填在这里的主机不走代理，逗号或空格分隔。例如填 api.deepseek.com 就是「模型与搜索直连、其余走代理」。回环地址始终直连。").volatile(),
	testUrl: z.string().default("").description("自测时访问的地址，留空用 https://www.gstatic.com/generate_204。").volatile()
});

/**
 * 读一个配置字段。解析后 volatile 字段是引用对象，要 `.get()`；
 * 裸值分支是防御性的，以防将来 Loader 直接给值。
 *
 * @param config - 解析后的插件配置。
 * @param field - 字段名。
 * @param fallback - 字段缺失时的取值。
 * @returns 字段当前的值。
 */
function fieldValue(config, field, fallback) {
	const raw = config?.[field];
	if (raw === undefined || raw === null) return fallback;
	return typeof raw.get === "function" ? raw.get() : raw;
}

/**
 * 把异常整理成一行诊断。
 *
 * @param error - 抛出的值。
 * @returns 可读信息。
 */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}

/** 承载启动环境代理变量的文件名（在 Harness 主目录下）。 */
const ENV_FILE_NAME = ".env";

/**
 * 解析 Harness 主目录。
 *
 * 只用来把 `env` 模式的提示指到确切的文件上 —— 用户看到"启动环境里没有代理设置"时，
 * 必须同时知道该把变量写到哪里，否则这句话帮不上忙。
 *
 * @param ctx - 插件上下文。
 * @returns 主目录绝对路径。
 */
function dshHome(ctx) {
	const fromContext = typeof ctx?.get === "function" ? ctx.get("profileContext")?.home : undefined;
	if (typeof fromContext === "string" && fromContext !== "") return fromContext;
	const fromEnvironment = String(process.env.DSH_HOME ?? "").trim();
	if (fromEnvironment !== "") return fromEnvironment;
	return join(homedir(), ".dsh");
}

/**
 * 这个主目录下的 `.env` 路径。
 *
 * @param ctx - 插件上下文。
 * @returns 绝对路径。
 */
function environmentFile(ctx) {
	return join(dshHome(ctx), ENV_FILE_NAME);
}

/**
 * 把设置摆成 `installProxyFromEnvironment` 期望的"启动环境快照"形状。
 *
 * 两种大小写都写：策略解析器小写优先、大写兜底，而且这些值随后会被原样发布给
 * 子进程。`ALL_PROXY` 不写 —— 策略自己不发布它，写了只会让父子进程的判断分叉。
 *
 * @param effective - 生效的设置。
 * @returns 暴露 `get(name) -> { value }` 的快照。
 */
function environmentFor(effective) {
	const values = {
		http_proxy: effective.proxy,
		HTTP_PROXY: effective.proxy,
		https_proxy: effective.proxy,
		HTTPS_PROXY: effective.proxy
	};
	if (effective.noProxy !== "") {
		values.no_proxy = effective.noProxy;
		values.NO_PROXY = effective.noProxy;
	}
	return { get: (variable) => (Object.hasOwn(values, variable) ? { value: values[variable] } : undefined) };
}

/** 运行时策略模块，进程内只加载一次。 */
let policyModule;

/**
 * 加载策略模块并确认它提供了需要的函数。
 *
 * @param ctx - 插件上下文。
 * @returns 策略模块。
 */
async function loadPolicyModule(ctx) {
	if (policyModule !== undefined) return policyModule;
	const loaded = await importFromRuntime(POLICY_PACKAGE, anchorFor(ctx));
	if (typeof loaded.installProxyFromEnvironment !== "function") throw new Error(`${POLICY_PACKAGE} 没有导出 installProxyFromEnvironment`);
	policyModule = loaded;
	return loaded;
}

/**
 * 用来问策略模块"现在到底会不会走代理"的样本地址。
 *
 * 必须是公网主机：回环地址被策略强制绕过，拿它当样本永远得到"直连"。
 */
const DECISION_SAMPLE = "https://example.com/";

/**
 * 问策略模块自己：此刻对**某个具体地址**，它会不会走代理。
 *
 * 这是**唯一诚实**的读数来源。`proxyRouteFor()` 正是 `dsh-web-fetch-http` 每次都问的
 * 那个函数，所以它给出的答案就是 `web_fetch` 会照做的答案。反过来说，插件不能只报
 * "我自己装了什么"：启动器在插件挂载前装的那一层我们看不见，一旦它在生效（用户把代理
 * 写在 `.env` 里），只报自己那层就会在界面上显示「直连」，而流量其实正在走代理。
 *
 * 要按**具体 URL** 问而不是固定样本：协议不同答案就可能不同（例如只设了
 * `HTTPS_PROXY` 时，`https://` 走代理而 `http://` 直连）。
 *
 * @param ctx - 插件上下文。
 * @param url - 要判定的地址。
 * @returns `{ proxied, proxy, error? }`。
 */
async function routeFor(ctx, url) {
	try {
		const policy = await loadPolicyModule(ctx);
		const decision = policy.proxyRouteFor(url);
		return { proxied: decision.proxied === true, proxy: decision.proxy ?? "" };
	} catch (error) {
		return { proxied: false, proxy: "", error: message(error) };
	}
}

/**
 * 用一个公网样本问出"当前生效的路由"。
 *
 * @param ctx - 插件上下文。
 * @returns `{ proxied, proxy, error? }`。
 */
async function probeDecision(ctx) {
	return await routeFor(ctx, new URL(DECISION_SAMPLE));
}

/**
 * 安装策略并跟随配置变更。
 *
 * @param ctx - 插件上下文。
 * @param config - 解析后的 Config，字段是 volatile 引用。
 */
export function apply(ctx, config) {
	/** 读配置为纯值。 */
	const settings = () =>
		normalizeSettings({
			mode: fieldValue(config, "mode", "env"),
			proxy: fieldValue(config, "proxy", ""),
			noProxy: fieldValue(config, "noProxy", ""),
			testUrl: fieldValue(config, "testUrl", "")
		});

	/** 当前已安装策略的释放函数。 */
	let release;
	/** 已处理过的配置签名，用来让同步幂等。 */
	let applied;
	/** 真正装上的代理地址；空串表示直连。 */
	let activeProxy = "";
	/** 最近一次安装失败的原因。 */
	let lastError = "";
	/** 串行化安装与释放：全局 dispatcher 是进程级状态。 */
	let queue = Promise.resolve();
	/** 后台关闭旧 agent 的进度，卸载时等它收尾。 */
	let closing = Promise.resolve();
	let stopped = false;
	/** 系统代理探测的缓存。 */
	let detection;

	/**
	 * 探测系统代理，带短缓存。
	 *
	 * @param options - `refresh` 为真时忽略缓存。
	 * @returns 探测结果。
	 */
	const detectSystemProxy = async (options = {}) => {
		const now = Date.now();
		if (options.refresh !== true && detection !== undefined && now - detection.at < DETECTION_TTL_MS) return detection.value;
		const value = await readWindowsSystemProxy();
		detection = { at: now, value };
		return value;
	};

	/**
	 * 启动环境的快照 —— 启动器在挂载任何插件之前 `provide` 的那一份，记录着用户到底
	 * 给了什么（已导出的变量，还是 `.env` 里的哪一行）。
	 *
	 * **必须用这份快照，绝不能读活的 `process.env`**：我们自己一安装就会把解析结果写进
	 * `process.env`，读活的值等于读到自己刚写的东西 —— env 模式会静默地镜像手动模式，
	 * 看起来"读到了环境"其实什么都没读到。官方的 `launchEnvironmentOf()` 在拿不到快照时
	 * 正好会回落到活环境，所以这里不用它，而是直接用 `ctx.get()`。
	 *
	 * 每次现读而不是在 `apply` 时读一次：服务可能晚一点才出现，而这里一次读取没有成本。
	 *
	 * @returns 快照，或 undefined。
	 */
	const launchSnapshot = () => (typeof ctx.get === "function" ? ctx.get("launchEnvironment") : undefined);

	/**
	 * 读启动环境里的一个变量（与策略解析器同样的顺序：小写优先、大写兜底，空值视为未设置）。
	 *
	 * @param lower - 小写的变量名。
	 * @returns `{ value, source, path }`，未设置时为 undefined。
	 */
	const readLaunch = (lower) => {
		const snapshot = launchSnapshot();
		for (const variable of [lower, lower.toUpperCase()]) {
			const entry = snapshot?.get?.(variable);
			const value = String(entry?.value ?? "").trim();
			if (value !== "") return { value, source: entry.source, path: entry.path };
		}
		return undefined;
	};

	/**
	 * 启动环境里的代理概览：值、来自哪一层、以及那个文件。
	 *
	 * 界面靠它显示"环境变量里是什么、来自哪里"，冲突提示也靠它。
	 *
	 * @returns 概览；`available` 表示拿没拿到快照。
	 */
	const launchProxy = () => {
		const http = readLaunch("http_proxy");
		const https = readLaunch("https_proxy");
		const all = readLaunch("all_proxy");
		const noProxy = readLaunch("no_proxy");
		const chosen = https ?? http ?? all;
		return {
			available: launchSnapshot() !== undefined,
			proxy: chosen?.value ?? "",
			source: chosen?.source ?? "",
			path: chosen?.path ?? "",
			httpProxy: http?.value ?? "",
			httpsProxy: https?.value ?? "",
			allProxy: all?.value ?? "",
			noProxy: noProxy?.value ?? ""
		};
	};

	/**
	 * 启动环境里也有代理时会与插件冲突 —— 说清后果，并给出消除歧义的做法。
	 *
	 * 子进程跟随的是启动环境那份值（策略模块把最外层安装时的 `process.env` 记了账，
	 * 插件没有 API 能改它），所以两者不一致时，子进程和本进程的路由会分叉。
	 *
	 * @returns 一到两条提示。
	 */
	const conflictNotes = () => {
		const environment = launchProxy();
		if (environment.proxy === "") return [];
		const from = environment.path !== undefined && environment.path !== "" ? environment.path : environment.source === "process" ? "已导出的环境变量" : environment.source;
		return [`启动环境里也有代理（${environment.proxy}，来自 ${from}）。子进程会跟随它，插件只决定本进程内的路由；要消除歧义，就只留一个来源。`];
	};

	/**
	 * 决定此刻该用哪个代理。
	 *
	 * 三个来源互斥：内置（启动环境）、Windows 系统代理、手动。
	 *
	 * @returns `{ settings, proxy, reason, notes, problem?, snapshot?, release? }`。
	 *   `proxy` 是给人看的（日志与界面）；`snapshot` 是真正交给策略模块去解析的东西；
	 *   `release: true` 表示"插件这一层什么都不装"。
	 */
	const resolveEffective = async () => {
		const current = settings();
		if (current.mode === "env") {
			// 内置 = **插件不插手**：什么都不装，让启动器在挂载插件前装好的那一层自然生效。
			//
			// 这正是早先那个 `enabled` 总开关关闭时的语义 —— 两者在路由上完全等价，所以只留这一个。
			// 措辞必须把"环境里到底有没有东西"说出来：有代理时不能说成直连，没有时也要说清查过
			// 哪个文件（否则用户以为 `.env` 在生效，其实一直是直连）。
			const environment = launchProxy();
			const reason = !environment.available
				? "拿不到启动环境快照 —— 无法判断里面有没有代理；插件不插手，路由以策略模块的判定为准"
				: environment.proxy === ""
					? `启动环境里没有代理设置（查过 ${environmentFile(ctx)}），按直连处理`
					: `启动环境里有 ${environment.proxy}，插件不插手（那就是启动器那层在生效）`;
			return { settings: current, proxy: "", release: true, reason, notes: [] };
		}
		const conflict = conflictNotes();
		if (current.mode === "system") {
			const detection = await detectSystemProxy();
			const chosen = chooseSystemProxy(detection);
			if (chosen.proxy === "") {
				return {
					settings: current,
					proxy: "",
					reason: chosen.reason,
					notes: [...(chosen.notes ?? []), ...conflict],
					// 系统里开着代理、地址却不能用，才算"没做成事"；单纯没开系统代理是正常状态。
					problem: detection?.enable === true
				};
			}
			return { settings: current, proxy: chosen.proxy, reason: "取自 Windows 系统代理", notes: [...(chosen.notes ?? []), ...conflict], snapshot: environmentFor({ ...current, proxy: chosen.proxy }) };
		}
		if (current.proxy === "") return { settings: current, proxy: "", reason: "手动模式尚未填写代理地址", notes: conflict, problem: true };
		const inspected = inspectProxyUrl(current.proxy);
		if (!inspected.ok) return { settings: current, proxy: "", reason: inspected.reason, notes: conflict, problem: true };
		return { settings: current, proxy: inspected.value, reason: "手动指定", notes: conflict, snapshot: environmentFor({ ...current, proxy: inspected.value }) };
	};

	/**
	 * 让已安装的策略与当前设置一致。
	 *
	 * 永远**先释放再安装**。这不是风格问题：释放会把策略从 `dsh-http-proxy` 内部的
	 * 栈上弹掉、恢复它下面那层 dispatcher，所以先装后放会把刚装好的策略拆掉。
	 */
	const sync = async () => {
		if (stopped) return;
		const effective = await resolveEffective();
		// 幂等键必须涵盖**结果的全部成因**，不能只看最终地址：从"插件不插手"变成
		// "配了却用不了"时两者都是"直连"，只比地址就会认定"没变化"而不再评估，
		// 于是该报的拒绝原因永远不报。reason 与 problem 一起进键，状态一变就重新处理。
		const key = JSON.stringify({ mode: effective.settings.mode, proxy: effective.proxy, noProxy: effective.settings.noProxy, problem: effective.problem === true, release: effective.release === true, reason: effective.reason });
		if (key === applied) return;
		applied = key;
		const previous = release;
		release = undefined;
		activeProxy = "";
		if (previous !== undefined) {
			// 调它但**不 await**：释放函数会先同步恢复上一层的 dispatcher 与内部状态，
			// 之后才异步关闭旧 agent，而 `close()` 会等在途请求跑完 —— 在负载下那可能是
			// 好几秒。await 它等于让出站请求在这几秒里直连，也就是悄悄绕开了刚配好的代理。
			// 内部状态既然已经同步换回来了，立刻装新的就是安全的，旧 agent 在后台收尾。
			try {
				const done = Promise.resolve(previous());
				closing = Promise.all([closing, done]).then(
					() => undefined,
					(error) => ctx.logger.warn("%s：关闭旧连接失败：%s", name, message(error))
				);
			} catch (error) {
				ctx.logger.warn("%s：释放上一份策略失败：%s", name, message(error));
			}
		}
		if (stopped) return;
		if (effective.proxy === "") {
			// 用户明确要了代理却用不了，是"没做成事"，得让他看见；
			// 什么都没配就是正常状态，一行 info 即可。
			lastError = effective.problem === true ? effective.reason : "";
			// 内置模式**不是**"未启用代理"：插件只是不插手，环境里可能正好有代理在生效，
			// 所以这句措辞必须分开，不能一律写成"出站请求直连"。
			if (effective.release === true) {
				ctx.logger.info("%s：不干预路由（%s）", name, effective.reason);
			} else {
				const line = "%s：未启用代理（%s），出站请求直连";
				if (effective.problem === true) ctx.logger.warn(line, name, effective.reason);
				else ctx.logger.info(line, name, effective.reason);
			}
			for (const note of effective.notes ?? []) ctx.logger.warn("%s：%s", name, note);
			return;
		}
		try {
			const policy = await loadPolicyModule(ctx);
			release = await policy.installProxyFromEnvironment(effective.snapshot, (diagnostic) => {
				ctx.logger.warn("%s：%s", name, diagnostic);
			});
			// 装完之后问模块自己有没有真的在路由，而不是假定"我装了就生效了"。
			// 官方解析器可能拒绝这份配置（例如里面写了 SOCKS），这里若照抄"我请求的值"，
			// 就会向界面报出一个实际上没生效的代理。
			const decision = await probeDecision(ctx);
			activeProxy = decision.proxied ? decision.proxy : "";
			lastError = decision.proxied ? "" : "策略模块没有采用这份代理配置（原因见上一条日志）";
			if (decision.proxied) {
				// 内置模式走不到这里（它什么都不装），所以直连名单只可能来自手动/系统模式。
				const bypass = effective.settings.noProxy === "" ? "" : `，直连名单 ${effective.settings.noProxy}`;
				ctx.logger.info("%s：出站请求经由 %s（%s）%s", name, decision.proxy, effective.reason, bypass);
			} else {
				ctx.logger.warn("%s：%s 没有生效，出站请求保持直连", name, effective.proxy);
			}
			for (const note of effective.notes ?? []) ctx.logger.warn("%s：%s", name, note);
		} catch (error) {
			lastError = message(error);
			// 本进程用不了的代理绝不该阻止 agent 启动：记一行，保持直连。
			ctx.logger.warn("%s：无法使用 %s（%s），出站请求保持直连", name, effective.proxy, lastError);
		}
	};

	/** 排一次同步到串行队列上。 */
	const reconcile = () => {
		queue = queue.then(() => sync(), () => sync());
		return queue;
	};

	/**
	 * 把配置写回 profile 的 patch 文件。
	 *
	 * 走 `configEditor.edit()`（和官方 `agent-default-model` 同一条路径）：它会校验、
	 * 落盘、然后立刻做一次 Loader 协调 —— volatile 字段因此原地生效；写失败还会
	 * 自动回滚。
	 *
	 * @param patch - 要合并进配置的字段。
	 */
	const writeConfig = async (patch) => {
		const entry = ctx.fiber?.entry;
		const editor = typeof ctx.get === "function" ? ctx.get("configEditor") : undefined;
		if (entry === undefined || editor === undefined) {
			throw new Error("当前运行环境没有配置编辑器，无法从界面保存；请直接编辑 profile 的 cordis.patch.yml");
		}
		await editor.edit(entry, (current) => {
			const next = { ...(current ?? {}), ...patch };
			// 顺手清掉旧版本遗留的字段，否则它会永远跟着配置落盘而又不在界面上（见 RETIRED_FIELDS）。
			for (const field of RETIRED_FIELDS) delete next[field];
			return next;
		});
	};

	/**
	 * 自测：用**真实的调用路径**访问一次测试地址，回报"配置说会怎样"和"实际怎样"。
	 *
	 * 关键在于走**全局 `fetch`**：那正是 LLM 请求、`web_search`、HTTP MCP 用的那条路
	 * （它们都调 `globalThis.fetch`，而它解析的是策略模块装上去的全局 dispatcher）。
	 * 早先的实现自己 `new ProxyAgent(...)` 再显式传 dispatcher，测的只是"这个代理能不能用"，
	 * 既绕过了全局 dispatcher，也绕过了 `NO_PROXY` 与 loopback 的判定 —— 换句话说，
	 * 它测的不是"你的配置生效后会怎样"。
	 *
	 * 于是这次探测同时给出两件事：
	 *
	 * - `via`：策略模块对**这个地址**的判定（会走哪个代理，或直连）；
	 * - `ok` / `status` / `error`：真的发出去之后的结果。
	 *
	 * 两者合起来才是"配置的效果"：直连也是一种有效结果，测出来同样有意义。
	 *
	 * 一处如实说明：`web_fetch` 在**未走代理**时用的是它自己那套解析地址 + 固定地址的
	 * Agent，不经过全局 dispatcher。所以本探测对"走代理"这一支与它同源（同一个 dispatcher
	 * 对象），对"直连"那一支测的是同一张网、同一条 DNS，但不是它那段代码。
	 *
	 * @param options - 可覆盖测试地址。
	 * @returns `{ ok, status?, latencyMs, url, via, direct, error? }`。
	 */
	const probe = async (options = {}) => {
		const current = settings();
		const target = options.testUrl !== undefined && options.testUrl !== "" ? options.testUrl : current.testUrl;
		// 按**这个具体地址**问路由：协议不同答案可能不同。
		let route = { proxied: false, proxy: "" };
		try {
			route = await routeFor(ctx, new URL(target));
		} catch {
			// 地址本身不合法，交给下面的 fetch 去报错。
		}
		const via = route.proxied ? route.proxy : "";
		const started = Date.now();
		try {
			const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
			await response.body?.cancel();
			return { ok: response.status < 400, status: response.status, latencyMs: Date.now() - started, url: target, via, direct: via === "" };
		} catch (error) {
			return { ok: false, error: message(error), latencyMs: Date.now() - started, url: target, via, direct: via === "" };
		}
	};

	/**
	 * 汇总给界面看的完整状态。
	 *
	 * @param options - `refreshSystem` 为真时强制重新探测系统代理。
	 * @returns 状态对象。
	 */
	const state = async (options = {}) => {
		// 先把排队的同步做完再报告。否则保存配置之后立刻读状态，拿到的是**上一份**配置的
		// 结果：界面上刚点完来源却显示旧状态，甚至短暂地显示「直连」。
		await queue;
		const current = settings();
		const effective = await resolveEffective();
		// 只有系统模式才需要这份探测结果；其它模式不起 reg.exe。
		// 界面上"内置 / 系统 / 手动"三行都常驻（未选中的置灰而不是隐藏），所以系统探测
		// 结果总要带上。它有 5 秒缓存，而界面只在挂载与保存后各取一次状态，不会频繁起 reg.exe。
		const system = await detectSystemProxy({ refresh: options.refreshSystem === true });
		// 生效中的代理由**策略模块自己**回答，而不是"我装了什么"：启动器在插件挂载前装的
		// 那一层我们看不见，一旦它在生效（用户把代理写在 .env 里），只报自己那层就会在界面
		// 上显示「直连」而流量其实正在走代理。layer 用来区分是谁在起作用。
		const decision = await probeDecision(ctx);
		const installed = decision.proxied ? decision.proxy : "";
		return {
			platform: process.platform,
			// 桌面版还是 Web 端：界面据此把「系统代理」那一行置灰（并在提示里说明原因）。
			desktop: isDesktopHost(),
			settings: {
				mode: current.mode,
				proxy: current.proxy,
				noProxy: current.noProxy,
				testUrl: current.testUrl
			},
			warnings: current.noProxyWarnings,
			effective: {
				installed,
				// plugin = 本插件这一层；launch = 启动器那层（.env 或已导出的变量）；none = 直连
				layer: installed === "" ? "none" : activeProxy === "" ? "launch" : "plugin",
				source: effective.reason,
				error: lastError || decision.error || "",
				notes: effective.notes ?? []
			},
			environment: { ...launchProxy(), envFile: environmentFile(ctx) },
			system:
				system === undefined
					? undefined
					: {
							supported: system.supported === true,
							enabled: system.enable === true,
							server: system.server ?? "",
							autoConfigUrl: system.autoConfigUrl ?? "",
							error: system.error
						}
		};
	};

	reconcile();
	ctx.on("loader/volatile-update", () => {
		void reconcile();
	});

	// 界面接口只在有 webServer 的环境里挂载；没有界面的 profile 照样能用代理。
	ctx.inject(["webServer"], (ui) => {
		ui.effect(
			() =>
				mountProxyRoutes(ui.webServer, {
					state: () => state(),
					save: (patch) => writeConfig(patch),
					probe: (options) => probe(options),
					// 界面里"内置"和"系统"两行的重新读取都走这里：两边的值都来自外部，
					// 强制绕过缓存重读一次，然后同步策略并回状态。
					refresh: async () => {
						const detectionValue = await detectSystemProxy({ refresh: true });
						await reconcile();
						return {
							detection: {
								supported: detectionValue.supported === true,
								enabled: detectionValue.enable === true,
								server: detectionValue.server ?? "",
								bypass: detectionValue.bypass ?? "",
								autoConfigUrl: detectionValue.autoConfigUrl ?? "",
								error: detectionValue.error
							},
							chosen: chooseSystemProxy(detectionValue),
							state: await state()
						};
					}
				}),
			"proxy-control：配置界面接口"
		);
	});

	ctx.effect(() => () => {
		stopped = true;
		return queue
			.then(async () => {
				const previous = release;
				release = undefined;
				applied = undefined;
				activeProxy = "";
				if (previous !== undefined) await previous();
				await closing;
			})
			.catch((error) => {
				ctx.logger.warn("%s：释放策略失败：%s", name, message(error));
			});
	});
}

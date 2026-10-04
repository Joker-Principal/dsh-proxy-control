/**
 * 纯逻辑层：代理地址校验、直连名单解析、配置归一化、系统代理选择。
 *
 * 这里刻意不 import 任何 `node:` 或 `undici` 模块，所以测试可以直接调用，
 * 不需要 ctx、不需要运行时、不需要网络。
 *
 * @module dsh-proxy-control/logic
 */

/** Harness 的传输策略接受的代理协议。 */
export const SUPPORTED_SCHEMES = ["http:", "https:"];

/** 能识别出来、但本 Harness 用不了的协议 —— 用来给出具体原因而不是笼统的"非法"。 */
export const SOCKS_SCHEMES = ["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"];

/** 自测默认打这个地址：一个极小的 204 端点，能同时验证"通不通"和"绕不绕得出去"。 */
export const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";

/** 界面里的占位提示，也用作 README 的示例。 */
export const PROXY_PLACEHOLDER = "http://127.0.0.1:7890";

/**
 * 校验一个代理地址，并说明它为什么可用或不可用。
 *
 * @param value - 用户填写的原始值。
 * @returns `{ ok, value?, type?, reason?, empty?, socks?, hasCredentials? }`。
 */
export function inspectProxyUrl(value) {
	const text = String(value ?? "").trim();
	if (text === "") return { ok: false, empty: true, reason: "未填写代理地址" };
	let parsed;
	try {
		parsed = new URL(text);
	} catch {
		return { ok: false, reason: "不是合法的 URL（要带协议，例如 http://127.0.0.1:7890）" };
	}
	if (SUPPORTED_SCHEMES.includes(parsed.protocol)) {
		return {
			ok: true,
			value: text,
			type: parsed.protocol.slice(0, -1),
			hasCredentials: parsed.username !== "" || parsed.password !== ""
		};
	}
	if (SOCKS_SCHEMES.includes(parsed.protocol)) {
		return {
			ok: false,
			socks: true,
			reason: `${parsed.protocol}// 暂不支持：联网抓取（web_fetch）只能经由 http/https 代理，SOCKS 覆盖不到它。请改用代理软件提供的 HTTP 端口（混合端口通常就是 HTTP）`
		};
	}
	return { ok: false, reason: `${parsed.protocol}// 不是受支持的代理协议（只接受 http:// 和 https://）` };
}

/**
 * 解析直连名单。
 *
 * 匹配规则来自 Harness 的传输策略：一条写主机名，连同它的子域名一起匹配；
 * 前缀 `.` 或 `*.` 含义相同；`*` 放行全部；可以带 `:端口`。
 * **不支持 CIDR** —— 策略的匹配器只做主机名后缀比较，`10.0.0.0/8` 这样的条目
 * 会被静默当成一个普通主机名，永远匹配不上，所以这里显式报出来。
 *
 * @param value - 用户填写的名单文本（逗号、空格、换行皆可分隔）。
 * @returns `{ text, entries, warnings }`，`text` 是规范化后的名单。
 */
export function parseNoProxyList(value) {
	const entries = [];
	const warnings = [];
	for (const raw of String(value ?? "").split(/[\s,]+/u)) {
		const entry = raw.trim();
		if (entry === "") continue;
		if (entry === "*") {
			entries.push(entry);
			continue;
		}
		if (entry.includes("/")) {
			warnings.push(`${entry}：不支持 CIDR，这条会被忽略；请写成主机名或域名后缀`);
			continue;
		}
		entries.push(entry);
	}
	return { text: entries.join(","), entries, warnings };
}

/**
 * 代理地址的来源，三者互斥：
 * - `env`    采用启动环境里的代理变量（`$DSH_HOME/.env` 或已导出的变量）——**插件不插手**，
 *            把路由交回启动器在挂载插件前装好的那一层，并如实报告它此刻是什么
 * - `system` 读 Windows 系统代理
 * - `manual` 用户手填
 */
export const PROXY_MODES = ["manual", "system", "env"];

/** 配置缺失或非法时采用哪个来源：`env` 是**惰性**的（插件什么都不装），适合当默认值。 */
export const DEFAULT_MODE = "env";

/**
 * 把插件的原始配置归一化成运行时用的形状。
 *
 * 每一个字段都可能来自 volatile 引用、裸值或缺失，这里统一成纯值。
 *
 * 早先版本还有一个 `enabled` 总开关，但它与"内置"来源在路由上完全等价（两者都是
 * "把控制权交回启动器那层"），差别只在可观测性 —— 所以那个开关被删掉了，见 `lib/index.js`
 * 的 `RETIRED_FIELDS`。
 *
 * @param raw - 原始配置值。
 * @returns 归一化后的设置。
 */
export function normalizeSettings(raw) {
	const noProxy = parseNoProxyList(raw?.noProxy);
	return {
		mode: PROXY_MODES.includes(raw?.mode) ? raw.mode : DEFAULT_MODE,
		proxy: String(raw?.proxy ?? "").trim(),
		noProxy: noProxy.text,
		noProxyWarnings: noProxy.warnings,
		testUrl: String(raw?.testUrl ?? "").trim() || DEFAULT_TEST_URL
	};
}

/**
 * 解析 Windows 的 `ProxyServer` 值。
 *
 * 两种形态：`127.0.0.1:7890`（所有协议同一个）和
 * `http=127.0.0.1:7890;https=127.0.0.1:7891`（按协议分别指定）。
 *
 * @param value - 注册表里的原始字符串。
 * @returns `{ all?, byScheme }`。
 */
export function parseWindowsProxyServer(value) {
	const text = String(value ?? "").trim();
	if (text === "") return { byScheme: {} };
	if (!text.includes("=")) return { all: text, byScheme: {} };
	const byScheme = {};
	for (const part of text.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		const scheme = part.slice(0, separator).trim().toLowerCase();
		const target = part.slice(separator + 1).trim();
		if (scheme !== "" && target !== "") byScheme[scheme] = target;
	}
	return { byScheme };
}

/**
 * 把探测到的系统代理翻译成一份可用的设置。
 *
 * 显式填写的 `proxy` 永远优先于自动探测：一个是用户明确要求的，一个是环境的默认值，
 * 两者冲突时不该让后者悄悄覆盖前者。
 *
 * @param detection - `readWindowsSystemProxy()` 的结果。
 * @returns `{ proxy, reason, notes }`；`proxy` 为空表示没有可用的系统代理。
 */
export function chooseSystemProxy(detection) {
	const notes = [];
	if (detection?.autoConfigUrl) {
		notes.push("系统配置了 PAC 自动配置脚本，本 Harness 不解析 PAC，已忽略");
	}
	if (detection?.supported === false) {
		return { proxy: "", reason: "当前平台没有可读的系统代理设置，按直连处理", notes };
	}
	if (detection?.enable !== true) {
		// 没开系统代理是一种**有效状态**（直连），不是错误；去哪打开它写在界面的悬停说明里。
		return { proxy: "", reason: "系统代理未启用，按直连处理", notes };
	}
	const { all, byScheme } = parseWindowsProxyServer(detection.server);
	const candidate = byScheme.https ?? byScheme.http ?? all ?? "";
	if (candidate === "") {
		return { proxy: "", reason: "系统代理已启用但未配置服务器地址，按直连处理", notes };
	}
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate) ? candidate : `http://${candidate}`;
	const inspected = inspectProxyUrl(withScheme);
	if (!inspected.ok) return { proxy: "", reason: inspected.reason, notes };
	// Windows 的 bypass 列表里大量是 `127.*`、`192.168.*`、`<local>` 这类通配写法，
	// 本 Harness 的匹配器只做主机名后缀比较，照搬过去会变成一堆永不匹配的垃圾条目，
	// 所以整份丢弃：回环地址本来就被策略强制直连，这也是实际会用到的那部分。
	if (String(detection.bypass ?? "").trim() !== "") {
		notes.push("系统 bypass 列表里的通配写法（如 127.*、<local>）本 Harness 不支持，已忽略；回环地址始终直连");
	}
	return { proxy: inspected.value, reason: "", notes };
}

/**
 * 从 `reg query` 的输出里解析出键值。
 *
 * 值的名字可能含空格（例如 `User Agent`），所以按 `REG_*` 类型标记切分，
 * 而不是按空白切分。
 *
 * @param output - 命令的完整标准输出。
 * @returns 名字到 `{ type, value }` 的映射。
 */
export function parseRegQueryOutput(output) {
	const values = {};
	for (const line of String(output ?? "").split(/\r?\n/u)) {
		const match = /^\s+(\S.*?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*?)\s*$/u.exec(line);
		if (match === null) continue;
		values[match[1]] = { type: match[2], value: match[3] };
	}
	return values;
}

/**
 * 把注册表里的一个 DWORD 值读成数字。
 *
 * @param entry - `parseRegQueryOutput()` 给出的条目。
 * @returns 0/1 之外的形态也照样解析；缺失或非法时为 undefined。
 */
export function readRegDword(entry) {
	if (entry === undefined) return undefined;
	const text = String(entry.value).trim();
	const parsed = text.startsWith("0x") || text.startsWith("0X") ? Number.parseInt(text.slice(2), 16) : Number.parseInt(text, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

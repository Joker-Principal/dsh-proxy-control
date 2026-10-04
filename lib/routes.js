/**
 * 配置界面用的本地接口。
 *
 * 这些接口能改写"流量往哪走"，所以按三层来判断调用方是否可信 —— 只查对端地址是不够的：
 *
 * 1. **对端必须是回环**（`127.0.0.1` / `::1` / `localhost`）。这挡的是局域网：把代理配置
 *    交给别人等于让对方决定你的凭据往哪发。
 * 2. **`Host` 头不能是非回环地址**。这一条挡的是浏览器。回环判断对浏览器毫无意义 ——
 *    恶意网页发起的请求也是从本机发出的，`remoteAddress` 一样是 `127.0.0.1`。而浏览器
 *    允许网页向任意域名发请求，只要 DNS 解析到回环，请求就落到这里（DNS 重绑定）；
 *    这时 `Host` 是攻击者的域名，而页面自身成了"同源"，CORS 完全不起作用。
 *    官方 `dsh-host-webserver` 明确声明自己**不携带认证或来源策略**，浏览器那层认证
 *    （签名的 cookie）也只覆盖它自己的 index 与 Connection 路由，所以第三方路由必须自己设防。
 *    浏览器一定会发 `Host`，所以这个头缺失时放行（见 `requireLoopbackHost`）。
 * 3. **POST 的 `content-type` 不能是可以"免预检"跨站发送的那三种**。带
 *    `application/json` 的跨站请求一定会触发 CORS 预检，而本路由不返回任何
 *    `Access-Control-Allow-*` 头，于是被浏览器拦下；只有 `text/plain` /
 *    `application/x-www-form-urlencoded` / `multipart/form-data` 能绕过预检。
 *
 * 这三点合起来的效果：配置只能被"用回环地址打开的这个界面"改动。**没有**用 `Origin` 头来
 * 判断，是因为 Electron 从 `file://` 加载界面、fetch 经 IPC 桥接，那种请求的 `Origin`
 * 可能是 `null`，照它拒绝会把桌面端自己挡在外面。
 *
 * @module dsh-proxy-control/routes
 */

/** 请求体上限：配置项都是短字符串，16KB 远远够用。 */
const BODY_LIMIT_BYTES = 16 * 1024;

/** 允许从界面写入的字段（全是字符串）；其它字段一律忽略，避免界面越权改配置。 */
const WRITABLE_FIELDS = ["mode", "proxy", "noProxy", "testUrl"];

/** 字符串字段的长度上限。 */
const FIELD_LIMIT = 4096;

/** 回环对端地址的各种写法。 */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** `Host` 头里可接受的回环主机名（IPv6 字面量按规范带方括号）。 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1", "localhost"]);

/**
 * 能跨站发送而**不触发 CORS 预检**的三种 `content-type`。
 *
 * 这三种是规范里的"可安全列出"取值，也正是唯一能绕过预检的形态；其余取值（包括
 * `application/json`）要跨站发送就必须先过预检，而本路由不返回任何 CORS 头。
 */
const UNPREFLIGHTABLE_CONTENT_TYPES = new Set(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]);

/**
 * 判断请求是否来自本机。
 *
 * 注意：只看对端地址挡不住浏览器 —— 恶意网页的请求也是从本机发出的，见文件头。
 *
 * @param request - HTTP 请求。
 * @returns 是回环时为 true。
 */
function isLoopback(request) {
	return LOOPBACK_ADDRESSES.has(request.socket?.remoteAddress ?? "");
}

/**
 * 从 `Host` 头里取出主机名，去掉端口、统一小写。
 *
 * @param request - HTTP 请求。
 * @returns 主机名；缺失或无法解析时为空串。
 */
function hostName(request) {
	const text = String(request.headers?.host ?? "").trim().toLowerCase();
	if (text === "") return "";
	if (text.startsWith("[")) {
		const end = text.indexOf("]");
		return end === -1 ? "" : text.slice(0, end + 1);
	}
	const colon = text.lastIndexOf(":");
	// 只有一个冒号且后面全是数字才算端口：IPv6 字面量会带多个冒号，别把 `::1` 切坏。
	if (colon !== -1 && text.indexOf(":") === colon && /^\d+$/u.test(text.slice(colon + 1))) return text.slice(0, colon);
	return text;
}

/**
 * 取出 `content-type` 的媒体类型（丢掉 `;charset=` 之类的参数）。
 *
 * @param request - HTTP 请求。
 * @returns 小写的媒体类型；没有该头时为空串。
 */
function mediaType(request) {
	const raw = request.headers?.["content-type"];
	if (typeof raw !== "string") return "";
	return raw.split(";")[0].trim().toLowerCase();
}

/**
 * 回一个 JSON 响应。
 *
 * @param response - HTTP 响应。
 * @param status - 状态码。
 * @param body - 可序列化的响应体。
 */
function sendJson(response, status, body) {
	const text = `${JSON.stringify(body)}\n`;
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
	response.end(text);
}

/**
 * 只放行指定方法，否则回 405。
 *
 * @param request - HTTP 请求。
 * @param response - HTTP 响应。
 * @param method - 允许的方法。
 * @returns 方法匹配时为 true。
 */
function requireMethod(request, response, method) {
	if (request.method === method) return true;
	response.writeHead(405, { allow: method });
	response.end();
	return false;
}

/**
 * 非回环来源直接拒绝。
 *
 * @param request - HTTP 请求。
 * @param response - HTTP 响应。
 * @returns 允许继续时为 true。
 */
function requireLoopbackPeer(request, response) {
	if (isLoopback(request)) return true;
	sendJson(response, 403, { error: "只接受本机请求" });
	return false;
}

/**
 * `Host` 头必须是回环地址。
 *
 * 这是挡 DNS 重绑定的那一道：那种攻击里对端地址、甚至"同源"判断都会显示为本机，
 * 唯一露馅的地方就是 `Host` —— 它是攻击者的域名。
 *
 * **头缺失时放行**：浏览器一定会发 `Host`（HTTP/1.1 必需），所以"没有这个头"不可能是网页
 * 发来的；那更可能是某个本机客户端（例如 Electron 经 IPC 桥接发的请求）没带上它，
 * 而那种情况已被对端回环检查覆盖。宁可在这里留一点余地，也不要把桌面端自己挡在外面。
 *
 * @param request - HTTP 请求。
 * @param response - HTTP 响应。
 * @returns 允许继续时为 true。
 */
function requireLoopbackHost(request, response) {
	const host = hostName(request);
	if (host === "" || LOOPBACK_HOSTNAMES.has(host)) return true;
	sendJson(response, 403, { error: "只接受以回环地址访问的请求" });
	return false;
}

/**
 * POST 的 `content-type` 不能是能免预检跨站发送的那三种。
 *
 * 缺这个头时放行：真实界面一定带 `application/json`，而"没有 content-type 的简单请求"
 * 并不存在（浏览器给字符串 body 自动补 `text/plain`，那会被下面挡住）。
 *
 * @param request - HTTP 请求。
 * @param response - HTTP 响应。
 * @returns 允许继续时为 true。
 */
function requireUnpreflightableContentType(request, response) {
	const type = mediaType(request);
	if (type === "" || !UNPREFLIGHTABLE_CONTENT_TYPES.has(type)) return true;
	sendJson(response, 415, { error: `不接受 ${type} 请求体；请用 application/json` });
	return false;
}

/**
 * 读取并解析 JSON 请求体。
 *
 * @param request - HTTP 请求。
 * @returns 解析出的对象。
 * @throws 超长或不是合法 JSON 时。
 */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > BODY_LIMIT_BYTES) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
}

/**
 * 过滤界面提交的配置片段。
 *
 * @param body - 解析后的请求体。
 * @returns 只含白名单字段、且类型正确的片段。
 * @throws 类型不对或没有可写字段时。
 */
export function sanitizeConfigPatch(body) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("请求体必须是对象");
	const patch = {};
	for (const field of WRITABLE_FIELDS) {
		if (!Object.hasOwn(body, field)) continue;
		const value = body[field];
		if (typeof value !== "string") throw new Error(`字段 ${field} 必须是字符串`);
		patch[field] = value.slice(0, FIELD_LIMIT);
	}
	if (Object.keys(patch).length === 0) throw new Error("没有可保存的字段");
	return patch;
}

/**
 * 挂载配置界面的接口。
 *
 * @param webServer - `ctx.webServer` 服务。
 * @param deps - 宿主侧能力：`state`、`save`、`probe`、`detect`。
 * @returns 一个释放函数。
 */
export function mountProxyRoutes(webServer, deps) {
	/**
	 * 包一层：先做来源、方法与请求体形态的检查，再把异常转成 400/500 JSON，
	 * 免得一个抛错把请求挂死在那里。
	 *
	 * @param method - 允许的方法。
	 * @param handler - 真正的处理逻辑；返回响应体。
	 * @returns 可交给 `webServer.register` 的处理函数。
	 */
	const route = (method, handler) => async (request, response) => {
		try {
			if (!requireLoopbackPeer(request, response)) return;
			if (!requireLoopbackHost(request, response)) return;
			if (!requireMethod(request, response, method)) return;
			if (method === "POST" && !requireUnpreflightableContentType(request, response)) return;
			const body = method === "POST" ? await readJsonBody(request) : {};
			sendJson(response, 200, await handler(body));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!response.headersSent) sendJson(response, 400, { error: message });
		}
	};

	const disposers = [
		webServer.register({ kind: "exact", path: "/proxy-control/state", handler: route("GET", () => deps.state()) }),
		webServer.register({
			kind: "exact",
			path: "/proxy-control/config",
			handler: route("POST", async (body) => {
				const patch = sanitizeConfigPatch(body);
				await deps.save(patch);
				return await deps.state();
			})
		}),
		webServer.register({
			kind: "exact",
			path: "/proxy-control/test",
			handler: route("POST", async (body) => {
				// 刻意**不接受** proxy 覆盖：自测要回答的是"你的配置生效后会怎样"，所以必须走
				// 真实调用路径（全局 fetch → 策略装上去的 dispatcher）。允许外部指定代理就又能
				// 绕开它，测出来的只是"这个代理能不能用"，而不是配置的效果。
				const testUrl = typeof body.testUrl === "string" ? body.testUrl.trim() : undefined;
				return await deps.probe({ testUrl });
			})
		}),
		// 界面里"内置"和"系统"两行的重新读取都走这里：两边的值都来自外部，强制重读一次。
		webServer.register({ kind: "exact", path: "/proxy-control/refresh", handler: route("POST", () => deps.refresh()) })
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}

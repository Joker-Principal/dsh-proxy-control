/**
 * `dsh-proxy-control` 的一体化测试：只覆盖代理内核。
 *
 * 分两段，按依赖排序：
 *
 * 1. **纯逻辑**（地址校验、直连名单、配置归一化、系统代理选择）——不需要运行时、不联网；
 * 2. **策略安装与路由**——在**真实的运行时**上跑。这是本插件的核心：插件自己不实现代理，
 *    而是驱动运行时那一份 `@deepseek-ai/dsh-http-proxy`（同一个模块实例），所以
 *    `proxyRouteFor()` 的答案必须与全局 dispatcher 一致 —— 否则 `web_fetch` 会悄悄直连。
 *
 * 测试用到的四个运行时包由本文件**自己**从 `app.asar` 里解到 `.test-runtime/`，
 * 不依赖任何开发脚本：
 *
 *   .test-runtime/node_modules/@deepseek-ai/dsh/package.json   ← 解析锚点
 *   .test-runtime/node_modules/@deepseek-ai/dsh-http-proxy/    ← 策略模块（被测对象）
 *   .test-runtime/node_modules/@deepseek-ai/schemastery/       ← 构造 Config
 *   .test-runtime/node_modules/@deepseek-ai/cosmokit/          ← schemastery 的依赖
 *   .test-runtime/node_modules/undici/                         ← 传输
 *
 * 运行：node test/proxy.test.mjs
 * 环境：DSH_APP_ASAR 指定 app.asar；DSH_TEST_RUNTIME 直接指向一份已有的运行时（跳过解包）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---- 0. 先清掉继承来的代理环境变量 ------------------------------------------
// 这台机器上插件很可能正在运行，而它会把解析结果发布给**所有**子进程 —— 测试进程也会继承到，
// 于是"基线应该是直连"这类断言就会假失败。清在最前面，后面所有断言都相对这个干净基线。
for (const variable of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY", "NODE_USE_ENV_PROXY"]) {
	delete process.env[variable];
}

// ---- 1. 准备运行时（原先由开发脚本承担，现已内联到这里）----

/** 桌面版默认安装位置。 */
const DEFAULT_ASAR = "C:\\workspace\\Programma\\dsh\\resources\\app.asar";

/** 要解出来的条目（文件或目录前缀）；asar 里的路径以 `dsh/` 开头。 */
const PACKAGES = [
	"dsh/node_modules/@deepseek-ai/dsh/package.json",
	"dsh/node_modules/@deepseek-ai/dsh-http-proxy",
	"dsh/node_modules/@deepseek-ai/schemastery",
	"dsh/node_modules/@deepseek-ai/cosmokit",
	"dsh/node_modules/undici"
];

/** 解出来之后用来判断"已经准备过"的锚点。 */
const ANCHOR = "node_modules/@deepseek-ai/dsh/package.json";

/**
 * 读取 asar 的索引。
 *
 * 头部是 Chromium Pickle 的嵌套写法：`[4][头部缓冲长度][头部负载长度][字符串长度][JSON...]`，
 * 文件数据从 `8 + 头部缓冲长度` 开始，每个条目的 `offset` 相对那里。
 *
 * @param asarPath - app.asar 路径。
 * @returns `{ header, dataStart, fd }`；调用方负责关闭 fd。
 */
function readIndex(asarPath) {
	const fd = fs.openSync(asarPath, "r");
	const head = Buffer.alloc(16);
	fs.readSync(fd, head, 0, 16, 0);
	const headerBufferSize = head.readUInt32LE(4);
	const stringLength = head.readUInt32LE(12);
	const json = Buffer.alloc(stringLength);
	fs.readSync(fd, json, 0, stringLength, 16);
	return { header: JSON.parse(json.toString("utf8")), dataStart: 8 + headerBufferSize, fd };
}

/**
 * 把索引铺平成条目列表。
 *
 * @param node - 索引里的一个目录节点。
 * @param prefix - 当前路径前缀。
 * @param out - 收集结果的数组。
 */
function walk(node, prefix, out) {
	for (const [name, entry] of Object.entries(node.files ?? {})) {
		const entryPath = prefix === "" ? name : `${prefix}/${name}`;
		if (entry.files) walk(entry, entryPath, out);
		else out.push({ path: entryPath, size: entry.size ?? 0, offset: entry.offset, unpacked: entry.unpacked === true, link: entry.link });
	}
}

/**
 * 把需要的包从 asar 解到目标目录，布局与运行时一致（去掉 asar 里的 `dsh/` 那层）。
 *
 * @param asarPath - app.asar 路径。
 * @param target - 解出到的目录。
 */
function extractRuntime(asarPath, target) {
	if (!fs.existsSync(asarPath)) {
		console.error(`找不到 app.asar：${asarPath}\n请用 DSH_APP_ASAR 指定它的路径，或用 DSH_TEST_RUNTIME 直接指向一份已有的运行时。`);
		process.exit(1);
	}
	const { header, dataStart, fd } = readIndex(asarPath);
	const entries = [];
	walk(header, "", entries);
	const unpackedRoot = `${asarPath}.unpacked`;
	let written = 0;
	try {
		for (const entry of entries) {
			if (!PACKAGES.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`))) continue;
			// link 条目是符号链接，内容由别处提供；照抄会把链接当文件写坏。
			if (entry.link !== undefined) continue;
			const relative = entry.path.startsWith("dsh/") ? entry.path.slice(4) : entry.path;
			const destination = join(target, relative);
			fs.mkdirSync(dirname(destination), { recursive: true });
			const contents = entry.unpacked
				? fs.readFileSync(join(unpackedRoot, entry.path))
				: (() => {
						const buffer = Buffer.alloc(entry.size);
						fs.readSync(fd, buffer, 0, entry.size, dataStart + Number(entry.offset));
						return buffer;
					})();
			fs.writeFileSync(destination, contents);
			written++;
		}
	} finally {
		fs.closeSync(fd);
	}
	console.log(`已从 app.asar 解出 ${written} 个文件到 ${target}`);
}

/** 运行时目录：显式指定优先，否则用插件目录下的 `.test-runtime`。 */
const specifiedRuntime = String(process.env.DSH_TEST_RUNTIME ?? "").trim();
const runtimeDir = specifiedRuntime !== "" ? resolve(specifiedRuntime) : resolve(here, "..", ".test-runtime");

if (fs.existsSync(join(runtimeDir, ANCHOR))) {
	console.log(`测试运行时已就绪：${runtimeDir}`);
} else if (specifiedRuntime === "") {
	extractRuntime(String(process.env.DSH_APP_ASAR ?? "").trim() || DEFAULT_ASAR, runtimeDir);
} else {
	// 显式指定了 DSH_TEST_RUNTIME 就不再解包（那是调用方自己的运行时），但指到一份不完整的
	// 目录上必须当场说清楚 —— 否则下面只会抛一个看不出所以然的 MODULE_NOT_FOUND。
	console.error(`DSH_TEST_RUNTIME 指向的目录里没有运行时锚点：${join(runtimeDir, ANCHOR)}\n请指向一份完整的运行时目录，或去掉 DSH_TEST_RUNTIME 让测试自己从 app.asar 解出来。`);
	process.exit(1);
}

// 插件在模块加载期就从进程参数里找运行时锚点（桌面宿主就是这么传的），必须在 import 之前设好。
process.argv[2] = runtimeDir;

/**
 * 取真实路径再转成文件 URL。
 *
 * Node 的 ESM 缓存以真实路径为键，少了 `realpathSync` 会悄悄加载出**第二份实例** ——
 * 对本插件来说那是致命的：策略模块的"单实例"正是 `web_fetch` 与全局 dispatcher 一致的保证。
 *
 * @param path - 绝对路径。
 * @returns 文件 URL。
 */
function moduleURL(path) {
	let real = path;
	try {
		real = fs.realpathSync(path);
	} catch {
		// 读不到真实路径就按原样加载，让后续的 import 报出真正的错误。
	}
	return pathToFileURL(real).href;
}

/**
 * 策略模块：必须与插件加载的是**同一份**。
 *
 * 插件按运行时锚点解析 `@deepseek-ai/dsh-http-proxy`，这里按同样的锚点算出同一个文件路径 ——
 * `realpathSync` 之后再 `import()`，进程里就只有一份实例、一个 `active` 策略。这正是
 * `web_fetch`（它每次都问 `proxyRouteFor`）与全局 dispatcher 不会分叉的原因。
 */
const policy = await import(moduleURL(join(runtimeDir, "node_modules/@deepseek-ai/dsh-http-proxy/lib/index.js")));
const { chooseSystemProxy, inspectProxyUrl, normalizeSettings, parseNoProxyList } = await import("../lib/logic.js");
const plugin = await import("../lib/index.js");

// ---- 2. 测试运行器 ----------------------------------------------------------

const results = [];
/** 跑一个用例；同步、异步都行，串行执行（后面多数用例共享全局 dispatcher）。 */
async function test(label, body) {
	try {
		await body();
		results.push([true, label]);
		console.log(`  通过  ${label}`);
	} catch (error) {
		results.push([false, label]);
		console.log(`  失败  ${label}\n        ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 轮询等待条件成立，不让测试依赖时序运气。 */
async function waitFor(describe, predicate, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() > deadline) throw new Error(`等待超时：${describe}`);
		await new Promise((ready) => setTimeout(ready, 10));
	}
}

/** 发一次真实请求，返回响应体或错误（策略判定用的是公网主机，DNS 解析失败也算一种结果）。 */
async function request(url) {
	try {
		return await (await fetch(url)).text();
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 一个最小 HTTP 代理：绝对 URI 请求直接应答，CONNECT 拒绝。
 *
 * 绑 `127.0.0.1` + 端口 0：不占固定端口，也不会对外暴露。
 *
 * @param label - 应答里带的标签，用来区分是哪一台上收到的流量。
 * @returns `{ label, server, seen, url }`。
 */
function startProxy(label) {
	const seen = [];
	const server = createServer((incoming, response) => {
		seen.push(`${incoming.method} ${incoming.url}`);
		response.writeHead(200, { "content-type": "text/plain" });
		response.end(`via ${label}`);
	});
	server.on("connect", (incoming, socket) => {
		seen.push(`CONNECT ${incoming.url}`);
		socket.destroy();
	});
	return new Promise((ready, fail) => {
		server.on("error", fail);
		server.listen(0, "127.0.0.1", () => ready({ label, server, seen, url: `http://127.0.0.1:${server.address().port}` }));
	});
}

/** 一个本机可达的普通 HTTP 服务：回环地址被策略强制直连，正好用来验证"直连也是有效结果"。 */
function startDirectServer() {
	const server = createServer((incoming, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("direct");
	});
	return new Promise((ready, fail) => {
		server.on("error", fail);
		server.listen(0, "127.0.0.1", () => ready({ server, url: `http://127.0.0.1:${server.address().port}/` }));
	});
}

/** 模拟 `webServer`：记下注册的路由，供测试直接调用。 */
function createWebServer() {
	const routes = new Map();
	return {
		routes,
		register({ path, handler }) {
			routes.set(path, handler);
			return () => routes.delete(path);
		}
	};
}

/**
 * 模拟一次 HTTP 调用。
 *
 * 默认请求头照**真实界面**的样子给：以回环地址访问，POST 带 `application/json`。
 * 想模拟"缺某个头"必须传 `null`，**不能传 `undefined`** —— 那会命中默认参数，
 * 头照样被加上，测试就会因为错的原因变绿。
 *
 * @param handler - 路由处理函数。
 * @param options - 方法、请求体、对端地址、`Host`、`content-type`。
 * @returns `{ status, body }`。
 */
async function call(handler, { method = "GET", body, remoteAddress = "127.0.0.1", host = "127.0.0.1:19387", contentType = "application/json" } = {}) {
	const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	const headers = {};
	if (host !== null) headers.host = host;
	if (method === "POST" && contentType !== null) headers["content-type"] = contentType;
	const request = {
		method,
		headers,
		socket: { remoteAddress },
		async *[Symbol.asyncIterator]() {
			for (const chunk of payload) yield chunk;
		}
	};
	let status = 0;
	let text = "";
	const response = {
		headersSent: false,
		writeHead(code) {
			status = code;
			this.headersSent = true;
		},
		end(chunk) {
			if (chunk !== undefined) text += String(chunk);
		}
	};
	await handler(request, response);
	return { status, body: text === "" ? undefined : JSON.parse(text) };
}

/**
 * 造一份启动环境快照，形状与 `dsh-launch-environment` 给出的完全一致：
 * `get(name)` 返回 `{ value, source, path }`。
 *
 * @param values - 变量名到值的映射。
 * @param source - 值来自哪一层（`process` / `user-env` / `project-env`）。
 * @param path - 提供该层的文件路径。
 * @returns 快照对象。
 */
function launchSnapshot(values, source = "user-env", path = "C:\\Users\\Joker\\.dsh\\.env") {
	return {
		get: (name) => {
			for (const candidate of [name, name.toUpperCase()]) {
				if (Object.hasOwn(values, candidate)) return { value: values[candidate], source, path };
			}
			return undefined;
		}
	};
}

/**
 * 模拟一个 cordis 上下文。
 *
 * 关键在 `configEditor` 替身要**照真实契约**来：`edit(entry, change)` 里 `change` 拿到的是
 * **当前**配置，返回值被**原地提交**，然后发一次 `loader/volatile-update` —— 那正是
 * volatile 配置变活的方式（插件监听该事件并重新安装策略）。
 *
 * @param options - `launchEnvironment` 提供启动环境快照。
 * @returns 测试用的上下文与观察窗口。
 */
function createContext({ launchEnvironment } = {}) {
	const state = { mode: "env", proxy: "", noProxy: "", testUrl: "" };
	const ref = (key) => ({ get: () => state[key] });
	const handlers = new Map();
	const disposers = [];
	const warnings = [];
	const edits = [];
	const webServer = createWebServer();
	const config = { mode: ref("mode"), proxy: ref("proxy"), noProxy: ref("noProxy"), testUrl: ref("testUrl") };
	const emit = (event, ...args) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	let launch = launchEnvironment;
	const ctx = {
		logger: {
			info: () => {},
			debug: () => {},
			error: () => {},
			warn: (...args) => warnings.push(args.map(String).join(" "))
		},
		fiber: { entry: { id: "proxy-control", options: { config: {} } } },
		get(name) {
			if (name === "launchEnvironment") return launch;
			if (name === "configEditor") {
				return {
					async edit(entry, change) {
						const next = change(state);
						edits.push(next);
						Object.assign(state, next);
						emit("loader/volatile-update", [["config"]]);
					}
				};
			}
			return undefined;
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		inject(deps, callback) {
			if (deps.includes("webServer")) callback({ webServer, effect: (body) => disposers.push(body()) });
		},
		effect(callback) {
			disposers.push(callback());
		},
		async dispose() {
			for (const dispose of disposers.reverse()) await dispose?.();
		}
	};
	return {
		ctx,
		config,
		state,
		webServer,
		warnings,
		edits,
		/** 换上启动器那份启动环境快照（`env` 模式的输入）。 */
		setLaunchEnvironment(snapshot) {
			launch = snapshot;
		}
	};
}

// ---- 3. 纯逻辑：地址校验 ----------------------------------------------------

console.log("地址校验\n");
await test("http:// 与 https:// 被接受，并给出协议类型", () => {
	assert.deepEqual(inspectProxyUrl("http://127.0.0.1:7890"), { ok: true, value: "http://127.0.0.1:7890", type: "http", hasCredentials: false });
	assert.equal(inspectProxyUrl("https://proxy.example:8443").type, "https");
	assert.equal(inspectProxyUrl("http://user:pass@127.0.0.1:7890").hasCredentials, true);
});
await test("SOCKS 被拒绝，并说明原因是联网抓取覆盖不到", () => {
	// 这不是"非法"，而是"这个 Harness 用不了"：web_fetch 未走代理时自己解析地址，
	// SOCKS 覆盖不到它 —— 报出笼统的"非法"会让用户改错方向。
	for (const value of ["socks5://127.0.0.1:1080", "socks://127.0.0.1:1080", "socks5h://127.0.0.1:1080"]) {
		const inspected = inspectProxyUrl(value);
		assert.equal(inspected.ok, false, `${value} 不该被接受`);
		assert.equal(inspected.socks, true);
		assert.match(inspected.reason, /web_fetch/, "理由必须点出联网抓取");
	}
});
await test("缺协议与空值分别给不同原因", () => {
	assert.equal(inspectProxyUrl("").ok, false);
	assert.equal(inspectProxyUrl("").empty, true);
	assert.equal(inspectProxyUrl("   ").empty, true, "只有空白也算未填写");
	assert.equal(inspectProxyUrl("").reason, "未填写代理地址");
	assert.match(inspectProxyUrl("127.0.0.1:7890").reason, /不是合法的 URL/);
	assert.match(inspectProxyUrl("ftp://127.0.0.1:21").reason, /不是受支持的代理协议/);
});

// ---- 4. 纯逻辑：直连名单 ----------------------------------------------------

console.log("\n直连名单\n");
await test("逗号、空格、换行都能分隔，并规范成逗号连接", () => {
	const parsed = parseNoProxyList("a.com, b.com\nc.com  d.com");
	assert.deepEqual(parsed.entries, ["a.com", "b.com", "c.com", "d.com"]);
	assert.equal(parsed.text, "a.com,b.com,c.com,d.com");
	assert.deepEqual(parsed.warnings, []);
	assert.equal(parseNoProxyList(" a.com ,  b.com ").text, "a.com,b.com", "多余空白要被收掉");
});
await test("星号与带端口的条目原样保留", () => {
	assert.equal(parseNoProxyList("*").text, "*");
	assert.equal(parseNoProxyList("*").entries.includes("*"), true);
	assert.equal(parseNoProxyList("api.example.com:8443").text, "api.example.com:8443");
	assert.equal(parseNoProxyList("*.internal.test").text, "*.internal.test");
});
await test("CIDR 被丢弃并回报警告（策略的匹配器只做主机名后缀比较）", () => {
	const parsed = parseNoProxyList("10.0.0.0/8, api.deepseek.com");
	assert.deepEqual(parsed.entries, ["api.deepseek.com"]);
	assert.equal(parsed.warnings.length, 1);
	assert.match(parsed.warnings[0], /不支持 CIDR/);
	assert.match(parsed.warnings[0], /10\.0\.0\.0\/8/);
});

// ---- 5. 纯逻辑：配置归一化 --------------------------------------------------

console.log("\n配置归一化\n");
await test("缺省值稳定，且测试地址有默认值", () => {
	assert.deepEqual(normalizeSettings({}), {
		mode: "env",
		proxy: "",
		noProxy: "",
		noProxyWarnings: [],
		testUrl: "https://www.gstatic.com/generate_204"
	});
	assert.deepEqual(normalizeSettings(undefined).mode, "env", "配置整个缺失也要能用");
});
await test("未知来源回落到环境（内置）：默认必须是惰性的", () => {
	assert.equal(normalizeSettings({ mode: "manual" }).mode, "manual");
	assert.equal(normalizeSettings({ mode: "system" }).mode, "system");
	assert.equal(normalizeSettings({ mode: "env" }).mode, "env");
	// 回落到 env 而不是 manual 是刻意的：否则一个没配过的插件会立刻接管出站请求。
	assert.equal(normalizeSettings({ mode: "nonsense" }).mode, "env");
});
await test("已删除的 enabled 字段不再影响任何行为", () => {
	// 它与"内置"在路由上完全等价（两者都是把控制权交回启动器那层），只留一个来源。
	assert.equal(normalizeSettings({ enabled: true }).mode, "env");
	assert.equal(normalizeSettings({ enabled: false, mode: "manual" }).mode, "manual", "旧字段不该覆盖新字段");
	assert.deepEqual(normalizeSettings({ enabled: true, noProxy: "a.com" }).noProxy, "a.com");
});
await test("直连名单被规范化后回落进设置，警告一起带上", () => {
	const settings = normalizeSettings({ noProxy: " 10.0.0.0/8 , a.com " });
	assert.equal(settings.noProxy, "a.com");
	assert.equal(settings.noProxyWarnings.length, 1);
});

// ---- 6. 纯逻辑：系统代理选择 ------------------------------------------------

console.log("\n系统代理选择\n");
await test("host:port 形态：自动补上协议头", () => {
	assert.equal(chooseSystemProxy({ enable: true, server: "127.0.0.1:7890" }).proxy, "http://127.0.0.1:7890");
	assert.equal(chooseSystemProxy({ enable: true, server: "http://127.0.0.1:7890" }).proxy, "http://127.0.0.1:7890", "已经有协议头就不重复加");
});
await test("http=…;https=… 形态：https 优先于 http 与通配写法", () => {
	assert.equal(chooseSystemProxy({ enable: true, server: "http=1.1.1.1:1;https=2.2.2.2:2" }).proxy, "http://2.2.2.2:2");
	assert.equal(chooseSystemProxy({ enable: true, server: "http=1.1.1.1:1" }).proxy, "http://1.1.1.1:1", "只分项配了 http 也能用");
});
await test("未启用系统代理 → 直连，且不算失败", () => {
	const chosen = chooseSystemProxy({ enable: false, server: "127.0.0.1:7890" });
	assert.equal(chosen.proxy, "");
	assert.match(chosen.reason, /未启用/);
	assert.equal(chosen.notes.length, 0);
});
await test("启用了但没填服务器地址 → 直连", () => {
	const chosen = chooseSystemProxy({ enable: true, server: "" });
	assert.equal(chosen.proxy, "");
	assert.match(chosen.reason, /未配置服务器地址/);
});
await test("PAC 被报告为提示，而不是失败", () => {
	const chosen = chooseSystemProxy({ enable: true, server: "127.0.0.1:7890", autoConfigUrl: "http://x/proxy.pac" });
	assert.equal(chosen.proxy, "http://127.0.0.1:7890", "PAC 不妨碍已经读到的代理");
	assert.equal(chosen.reason, "");
	assert.match(chosen.notes.join(" "), /不解析 PAC/);
});
await test("系统 bypass 的通配写法被丢弃并说明原因", () => {
	// Windows 的 bypass 里大量是 `127.*`、`<local>` 这类写法，而本 Harness 的匹配器只做
	// 主机名后缀比较，照搬过去就是一堆永不匹配的垃圾条目。
	const chosen = chooseSystemProxy({ enable: true, server: "127.0.0.1:7890", bypass: "localhost;127.*;<local>" });
	assert.match(chosen.notes.join(" "), /不支持，已忽略/);
	assert.match(chosen.notes.join(" "), /回环地址始终直连/);
});

// ---- 7. 策略安装与路由（真实运行时）----------------------------------------

const proxyA = await startProxy("A");
const proxyB = await startProxy("B");
const directServer = await startDirectServer();

/** 策略判定用的公网目标；`.invalid` 保证不是回环，也不需要真的能解析。 */
const TARGET = new URL("http://probe.invalid/");
const OTHER = new URL("http://other.invalid/");

console.log(`\n运行时：${runtimeDir}`);
console.log(`代理 A：${proxyA.url}\n代理 B：${proxyB.url}\n`);

console.log("基线与接口");
const main = createContext();
plugin.apply(main.ctx, main.config);
await waitFor("接口注册完成", () => main.webServer.routes.size === 4);
/** 取一条已注册的路由。 */
const route = (path) => {
	const handler = main.webServer.routes.get(path);
	assert.ok(handler, `路由 ${path} 未注册`);
	return handler;
};

await test("插件尚未安装策略时，策略模块回答直连", () => {
	assert.equal(policy.proxyRouteFor(TARGET).proxied, false);
	assert.equal(process.env.HTTPS_PROXY, undefined);
});
await test("四个接口都挂在固定路径上", () => {
	assert.deepEqual(
		[...main.webServer.routes.keys()].sort(),
		["/proxy-control/config", "/proxy-control/state", "/proxy-control/test", "/proxy-control/refresh"].sort()
	);
});
await test("GET /state 的形状：设置、警告、生效情况、环境、系统探测都在", async () => {
	const response = await call(route("/proxy-control/state"));
	assert.equal(response.status, 200);
	assert.equal(response.body.settings.mode, "env");
	assert.deepEqual(Object.keys(response.body.settings).sort(), ["mode", "noProxy", "proxy", "testUrl"]);
	assert.deepEqual(response.body.warnings, []);
	assert.equal(typeof response.body.effective.installed, "string");
	assert.equal(response.body.effective.layer, "none");
	assert.equal(typeof response.body.effective.source, "string");
	assert.ok(Array.isArray(response.body.effective.notes));
	assert.equal(typeof response.body.environment.available, "boolean");
	assert.match(response.body.environment.envFile, /\.env$/, "要给出查过的那个文件");
	assert.equal(response.body.platform, process.platform);
	assert.equal(typeof response.body.system, "object", "系统那行常驻，未选中也要带上此刻的值");
});

console.log("\n安装与路由");
await test("写入手动配置后，运行时那份策略模块自己回答「走代理」", async () => {
	const response = await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual", proxy: proxyA.url } });
	// 等**可观察到的结果**，不等环境变量：策略模块是先发布环境变量、后换 dispatcher，
	// 盯环境变量会在中间态上做断言。
	await waitFor("策略生效", () => policy.proxyRouteFor(TARGET).proxied === true);
	// 这一条就是"单实例"性质：问的是 dsh-web-fetch-http 每次都会问的那个函数。
	assert.equal(policy.proxyRouteFor(TARGET).proxied, true, "proxyRouteFor 必须看到已安装的策略，否则 web_fetch 会直连");
	assert.equal(policy.proxyRouteFor(TARGET).proxy, proxyA.url);
	assert.equal(typeof policy.proxyRouteFor(TARGET).dispatcher, "object", "判定要带上真正在路由的那个 dispatcher");
	assert.equal(response.status, 200);
	assert.equal(response.body.effective.installed, proxyA.url, "接口返回的必须是保存**之后**的状态");
	assert.equal(response.body.effective.layer, "plugin", "这一层是插件装的");
	assert.equal(process.env.HTTP_PROXY, proxyA.url, "同时发布给子进程");
});
await test("真实 HTTP 请求确实抵达假代理", async () => {
	const before = proxyA.seen.length;
	assert.equal(await request(TARGET), "via A");
	assert.equal(proxyA.seen.length, before + 1);
	assert.match(proxyA.seen.at(-1), /^GET http:\/\/probe\.invalid\/$/);
});
await test("noProxy 真的改变那一个主机的判定，名单外不受影响", async () => {
	const response = await call(route("/proxy-control/config"), { method: "POST", body: { noProxy: "probe.invalid" } });
	// 等待条件要同时覆盖两件事：新策略已装好（名单外仍走代理），而不只是"旧策略被释放"那一瞬。
	await waitFor("名单生效", () => policy.proxyRouteFor(TARGET).proxied === false && policy.proxyRouteFor(OTHER).proxied === true);
	assert.equal(policy.proxyRouteFor(TARGET).proxied, false, "名单里的主机必须直连");
	assert.equal(policy.proxyRouteFor(OTHER).proxied, true, "名单外的主机仍应走代理");
	assert.equal(response.body.settings.noProxy, "probe.invalid");
});
await test("热切换：改地址立即生效，且旧代理不再收到流量", async () => {
	await call(route("/proxy-control/config"), { method: "POST", body: { proxy: proxyB.url, noProxy: "" } });
	// 同样等"流量真的转过去了"，而不是等某个内部变量或环境变量。
	await waitFor("流量转到代理 B", async () => (await request(TARGET)) === "via B");
	const seenA = proxyA.seen.length;
	const seenB = proxyB.seen.length;
	assert.equal(await request(TARGET), "via B", "不重启、不重挂插件就换好");
	assert.equal(proxyA.seen.length, seenA, "稳定之后 A 不该再见到流量");
	assert.equal(proxyB.seen.length, seenB + 1);
	assert.equal(process.env.HTTP_PROXY, proxyB.url);
});
await test("配置校验：非字符串、白名单外、已删字段、空对象都被拒绝", async () => {
	// 白名单外的字段被忽略，但请求本身合法 —— 与已保存的值相同，免得给后面的用例留下副作用。
	const extra = await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual", 越权字段: "x" } });
	assert.equal(extra.status, 200);
	assert.equal(main.edits.at(-1).越权字段, undefined, "白名单外的字段不能落盘");
	assert.equal((await call(route("/proxy-control/config"), { method: "POST", body: { proxy: 42 } })).status, 400, "非字符串要拒绝");
	assert.equal((await call(route("/proxy-control/config"), { method: "POST", body: { proxy: ["x"] } })).status, 400);
	assert.equal((await call(route("/proxy-control/config"), { method: "POST", body: { enabled: true } })).status, 400, "已删除的总开关不再是可写字段");
	assert.equal((await call(route("/proxy-control/config"), { method: "POST", body: {} })).status, 400, "一个可写字段都没有");
});
await test("保存时清掉旧版本遗留的配置字段", async () => {
	// 真实 profile 里的样子：0.4 写过 autoDetect、0.6 之前还有 enabled，后来都删掉了，但它们
	// 一直留在 cordis.patch.yml 里 —— schemastery 保留未知键、界面又只渲染 schema 里的字段，
	// 而保存走的是「当前配置 + 改动」的合并，于是它们会永远跟着落盘。
	main.state.autoDetect = false;
	main.state.enabled = true;
	const before = main.state.noProxy;
	const response = await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual" } });
	assert.equal(response.status, 200);
	// 断言"会被落盘的那份"（edits），而不是替身自己的 state：替身用 Object.assign 模拟 volatile
	// 原地提交，删不掉属性，那是替身的性质，不是产品的行为。
	assert.equal(main.edits.at(-1).autoDetect, undefined, "旧字段不该再跟着配置落盘");
	assert.equal(main.edits.at(-1).enabled, undefined, "已删掉的总开关同样要被清掉");
	assert.equal(main.edits.at(-1).mode, "manual", "清理不能顺手丢掉正常字段");
	assert.equal(main.edits.at(-1).proxy, proxyB.url, "没被改动的字段必须原样保留");
	main.state.noProxy = before;
});

console.log("\n守卫与状态码");
await test("非回环来源被拒绝（403）", async () => {
	const response = await call(route("/proxy-control/state"), { remoteAddress: "192.168.1.9" });
	assert.equal(response.status, 403);
	assert.match(response.body.error, /只接受本机请求/);
});
await test("Host 不是回环地址时被拒绝（挡 DNS 重绑定）", async () => {
	// 浏览器允许网页访问任意域名；只要 DNS 解析到 127.0.0.1，请求就落在这里，对端地址甚至
	// "同源"判断都显示为本机 —— 唯一露馅的是 Host，它是攻击者的域名。
	for (const host of ["evil.example:19387", "attacker.test", "192.168.1.9:19387"]) {
		assert.equal((await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual" }, host })).status, 403, `Host=${host} 必须被拒绝`);
	}
	// 界面可能用 localhost、[::1] 或带端口的写法打开，这些都得放行。
	for (const host of ["127.0.0.1:19387", "127.0.0.1", "localhost:19387", "[::1]:19387"]) {
		assert.equal((await call(route("/proxy-control/state"), { host })).status, 200, `Host=${host} 应当放行`);
	}
	// 缺这个头时放行：浏览器一定会发 Host，所以这不可能来自网页；更可能是本机客户端
	// （Electron 经 IPC 桥接）没带上它 —— 那种情况已被对端回环检查覆盖。
	assert.equal((await call(route("/proxy-control/state"), { host: null })).status, 200);
});
await test("能免预检跨站发送的请求体形态被拒绝（415）", async () => {
	// 跨站的 application/json 一定会触发 CORS 预检，而本路由不返回任何 CORS 头，于是只有这三种
	// "可安全列出"的 content-type 能真正打进来。注意传 null 才是"没有这个头"。
	for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain;charset=UTF-8"]) {
		assert.equal((await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual" }, contentType: type })).status, 415, `content-type=${type} 必须被拒绝`);
	}
	assert.equal((await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual" }, contentType: "application/json;charset=utf-8" })).status, 200);
	assert.equal((await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual" }, contentType: null })).status, 200);
});
await test("方法不匹配被拒绝（405）", async () => {
	assert.equal((await call(route("/proxy-control/state"), { method: "POST", body: {} })).status, 405);
	assert.equal((await call(route("/proxy-control/config"), { method: "GET" })).status, 405);
	assert.equal((await call(route("/proxy-control/test"), { method: "GET" })).status, 405);
	assert.equal((await call(route("/proxy-control/refresh"), { method: "GET" })).status, 405);
});

console.log("\n自测与重读");
await test("POST /test 走真实调用路径，报告 via 与实际结果", async () => {
	// 先调成一个活着的代理：接口刻意**不接受**代理覆盖，所以这次请求只能由策略装上去的
	// 全局 dispatcher 送出去。
	const configured = await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual", proxy: proxyA.url, noProxy: "" } });
	await waitFor("代理 A 生效", () => policy.proxyRouteFor(TARGET).proxied === true);
	const seen = proxyA.seen.length;
	const response = await call(route("/proxy-control/test"), { method: "POST", body: { testUrl: TARGET.href } });
	assert.equal(response.status, 200);
	assert.equal(response.body.ok, true);
	assert.equal(response.body.status, 200);
	assert.equal(response.body.via, proxyA.url, "要报出配置说会走哪个代理");
	assert.equal(response.body.direct, false);
	assert.equal(typeof response.body.latencyMs, "number");
	assert.equal(proxyA.seen.length, seen + 1, "自测必须真的经过代理 —— 这证明它走的是全局 dispatcher，不是临时副本");
	assert.equal(configured.body.effective.installed, proxyA.url);
});
await test("POST /test 不接受代理覆盖，只认 testUrl", async () => {
	// 允许外部指定代理就又能绕开全局 dispatcher，测出来的只是"这个代理能不能用"，
	// 而不是"你的配置生效后会怎样"。
	const seenA = proxyA.seen.length;
	const seenB = proxyB.seen.length;
	const response = await call(route("/proxy-control/test"), { method: "POST", body: { testUrl: TARGET.href, proxy: proxyB.url } });
	assert.equal(response.status, 200);
	assert.equal(response.body.via, proxyA.url, "覆盖字段必须被忽略，仍然走当前生效的 A");
	assert.equal(proxyB.seen.length, seenB, "B 不该因为请求体里写了它而收到流量");
	assert.equal(proxyA.seen.length, seenA + 1);
});
await test("代理不通时如实报错，并说明它本该走哪里", async () => {
	await call(route("/proxy-control/config"), { method: "POST", body: { proxy: "http://127.0.0.1:1" } });
	await waitFor("死代理生效", () => policy.proxyRouteFor(TARGET).proxied === true);
	const response = await call(route("/proxy-control/test"), { method: "POST", body: { testUrl: TARGET.href } });
	assert.equal(response.body.ok, false);
	assert.equal(typeof response.body.error, "string");
	assert.equal(response.body.via, "http://127.0.0.1:1", "即使不通，也要说清配置打算走哪里");
	assert.equal(response.body.direct, false);
});
await test("配置就是直连时，自测如实报直连 —— 直连也是一种有效结果", async () => {
	// 回环地址被策略强制直连，而且它真的可达。
	await call(route("/proxy-control/config"), { method: "POST", body: { proxy: proxyA.url, noProxy: "127.0.0.1" } });
	await waitFor("回环走上直连", () => policy.proxyRouteFor(new URL(directServer.url)).proxied === false);
	const response = await call(route("/proxy-control/test"), { method: "POST", body: { testUrl: directServer.url } });
	assert.equal(response.status, 200);
	assert.equal(response.body.ok, true, "直连本身是通的");
	assert.equal(response.body.direct, true);
	assert.equal(response.body.via, "");
	assert.equal(response.body.status, 200);
});
await test("配置被策略拒绝（SOCKS）时，状态与自测都反映实际生效的直连", async () => {
	const configured = await call(route("/proxy-control/config"), { method: "POST", body: { mode: "manual", proxy: "socks5://127.0.0.1:1080", noProxy: "" } });
	// 拒绝的原因在配置那一侧如实给出，被拒的代理不该生效。
	assert.match(configured.body.effective.source, /web_fetch/);
	assert.equal(configured.body.effective.installed, "", "被拒的代理不该生效");
	await waitFor("策略回到直连", () => policy.proxyRouteFor(TARGET).proxied === false);
	const response = await call(route("/proxy-control/test"), { method: "POST", body: { testUrl: TARGET.href } });
	assert.equal(response.body.direct, true, "自测报的是实际路由：直连");
	assert.equal(response.body.via, "");
	assert.equal(response.body.ok, false, "probe.invalid 直连解析不到，所以不通");
});
await test("POST /refresh 总是回一个结果（探测不到也是一种结果）", async () => {
	const response = await call(route("/proxy-control/refresh"), { method: "POST", body: {} });
	assert.equal(response.status, 200);
	assert.equal(typeof response.body.detection, "object");
	assert.equal(typeof response.body.chosen, "object");
	assert.equal(typeof response.body.state, "object");
	assert.equal(typeof response.body.detection.supported, "boolean");
});

console.log("\n内置来源：把控制权交回启动器那层");
{
	// 真实顺序是：启动器在挂载任何插件之前先装一层，插件那层后来才压在它上面。
	// 所以这里先造出启动器那层，再挂一个"内置模式（插件不插手）"的插件实例。
	const launcherEnvironment = launchSnapshot({ HTTP_PROXY: proxyA.url, HTTPS_PROXY: proxyA.url });
	const launcherRelease = await policy.installProxyFromEnvironment(launcherEnvironment, () => {});
	const probe = createContext({ launchEnvironment: launcherEnvironment });
	plugin.apply(probe.ctx, probe.config);
	await waitFor("探针实例的接口注册完成", () => probe.webServer.routes.size === 4);
	const probeRoute = (path) => {
		const handler = probe.webServer.routes.get(path);
		assert.ok(handler, `路由 ${path} 未注册`);
		return handler;
	};

	await test("插件还没挂载时，启动器那层已经在代理", () => {
		assert.equal(policy.proxyRouteFor(TARGET).proxied, true);
		assert.equal(policy.proxyRouteFor(OTHER).proxy, proxyA.url);
	});
	await test("切到内置后：状态报 layer=launch 与真实地址，而不是「直连」", async () => {
		// 内置 = 插件不插手，让启动器那层自然生效。只报"我自己装了什么"就会显示「直连」，
		// 而流量其实正在走代理 —— 那是说谎。
		const response = await call(probeRoute("/proxy-control/state"));
		assert.equal(response.status, 200);
		assert.equal(response.body.settings.mode, "env");
		assert.equal(response.body.effective.installed, proxyA.url, "生效中的代理必须由策略模块自己回答");
		assert.equal(response.body.effective.layer, "launch", "并且要指出是启动环境那层在起作用");
		assert.equal(response.body.effective.error, "");
		assert.equal(response.body.environment.proxy, proxyA.url, "界面要能看到环境里是什么");
		assert.equal(response.body.environment.available, true);
		assert.match(response.body.environment.path, /\.dsh\\\.env|\.dsh\/\.env/);
		assert.match(response.body.effective.source, /插件不插手/);
		assert.ok(response.body.effective.source.includes(proxyA.url), "提示里要点出那个仍在生效的地址");
		assert.equal(await request(TARGET), "via A", "流量真的经启动器那层出去");
	});
	await test("内置模式不理手动字段：内置来源就是本进程直连（不装任何策略）", async () => {
		// 内置模式下插件一个字节都不装，所以 effective.reason 只能是"不插手"那一支；
		// 手填的地址和直连名单都不得参与决策。
		const response = await call(probeRoute("/proxy-control/config"), { method: "POST", body: { proxy: proxyB.url, noProxy: "probe.invalid" } });
		assert.equal(response.body.settings.mode, "env");
		assert.equal(response.body.settings.noProxy, "probe.invalid", "字段照样保存，只是不生效");
		assert.match(response.body.effective.source, /插件不插手/);
		assert.equal(response.body.effective.layer, "launch", "手填地址不该覆盖环境变量");
		assert.equal(policy.proxyRouteFor(new URL("http://keep.direct/")).proxied, true, "内置模式下直连名单不参与");
	});
	await test("启动器那层上的 NO_PROXY 在内置模式下照旧生效", async () => {
		// 内置模式把路由完全交回启动器那层，所以 `NO_PROXY` 也由它解析 —— 这正是"内置"的含义。
		await launcherRelease();
		await policy.installProxyFromEnvironment(launchSnapshot({ HTTP_PROXY: proxyB.url, HTTPS_PROXY: proxyB.url, NO_PROXY: "keep.direct" }), () => {});
		const response = await call(probeRoute("/proxy-control/config"), { method: "POST", body: { mode: "env" } });
		assert.equal(response.body.effective.installed, proxyB.url);
		assert.equal(policy.proxyRouteFor(TARGET).proxied, true, "不在名单里的主机仍走代理");
		assert.equal(policy.proxyRouteFor(new URL("http://keep.direct/")).proxied, false, "环境里的 NO_PROXY 必须生效");
		// 收尾：撤掉这一层，回到直连。
		await policy.installProxyFromEnvironment(launchSnapshot({}), () => {});
		await waitFor("环境那层被撤掉", () => policy.proxyRouteFor(TARGET).proxied === false);
	});
	await probe.ctx.dispose();
}

console.log("\n释放");
await test("释放后清掉发布出去的代理环境变量，并回到直连", async () => {
	// 释放函数是把"进程里这些名字的旧值"还回去，所以先把它们清干净，
	// 断言的才是"插件卸下后自己不再留下任何东西"，而不是继承来的环境。
	for (const variable of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
		delete process.env[variable];
	}
	await main.ctx.dispose();
	assert.equal(process.env.HTTPS_PROXY, undefined, "发布给子进程的变量必须被撤回");
	assert.equal(process.env.HTTP_PROXY, undefined);
	assert.equal(process.env.https_proxy, undefined);
	assert.equal(process.env.no_proxy, undefined);
	assert.equal(policy.proxyRouteFor(OTHER).proxied, false, "策略必须被摘掉");
	assert.equal(main.webServer.routes.size, 0, "路由应当被注销");
	assert.equal(await request(directServer.url), "direct", "直连本身仍然可用");
});

// ---- 8. 收尾 ----------------------------------------------------------------

proxyA.server.close();
proxyB.server.close();
directServer.server.close();

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);

/**
 * 退出码只用 `process.exitCode` 设置，**成功与失败两条路径都不调 `process.exit()`**。
 *
 * 这不是风格选择，是实测出来的：本机 `node -v` 是 v25，undici 的 `agent.close()` 在承诺
 * 解析之后才由连接池真正释放 uv_async 句柄，而 Windows 上 `process.exit()` 在句柄仍处于
 * 关闭中时拆卸事件循环会直接断言崩溃（`UV_HANDLE_CLOSING`，退出码 0xC0000409）。上面每一次
 * 热切换都要释放一个策略 agent，收尾时正好撞上这个窗口。
 *
 * 这不是本插件的缺陷 —— 二十行脚本、绕开插件直接安装两次策略就能复现。让事件循环自己走完，
 * 就没有"拆卸正在关闭的东西"这一步，两条路径的退出码都是干净可预期的 0 / 1。
 *
 * 失败路径也必须这样：实测把 SOCKS 拒绝故意改坏之后，`process.exit(1)` 同样被那个崩溃顶掉，
 * 退出码变成了 `-1073740791` —— 结论虽然是"失败"，但没人看得懂那个码。
 *
 * 代价是：万一将来某个句柄真的泄漏，这里会挂着不退出。所以留一个**不阻止退出**的看门狗
 * （`unref()`）：真挂住时它打印一行并强行以非零码退出，而不是让测试无声地卡住。
 */
process.exitCode = failed.length > 0 ? 1 : 0;

const watchdog = setTimeout(() => {
	console.error("代理测试：收尾时事件循环没有自己空下来 —— 可能有句柄泄漏，强制退出。");
	process.exit(1);
}, 30000);
watchdog.unref();

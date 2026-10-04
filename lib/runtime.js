/**
 * 运行时定位层。
 *
 * profile 里的第三方插件**无法**直接 `import "@deepseek-ai/*"`：profile 的
 * `node_modules` 只有 pnpm 为这个 profile 装的东西，而运行时包躺在应用程序旁边
 * （桌面版就是 `app.asar` 里面）。实测 `createRequire(...).resolve()` 对
 * `@deepseek-ai/dsh-http-proxy`、`@deepseek-ai/schemastery` 甚至 `undici` 全部
 * `MODULE_NOT_FOUND`。
 *
 * 所以这里按启动器自己的做法解析：以运行时的安装锚点
 * （`<runtime>/node_modules/@deepseek-ai/dsh/package.json`）为基准去 resolve。
 *
 * @module dsh-proxy-control/runtime
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 锚点所属的运行时包。 */
const RUNTIME_PACKAGE = "@deepseek-ai/dsh";

/** 从已知文件往上找锚点的最大层数；真实答案最深 4 层，其余是容错余量。 */
const ANCHOR_SEARCH_DEPTH = 12;

/**
 * 找到 `<runtime>/node_modules/@deepseek-ai/dsh/package.json`。
 *
 * 这一步发生在模块加载期（`Config` 必须在 import 时就构造出来），那时还没有 ctx，
 * 所以只有两条线索可用：桌面宿主把运行时目录作为第二个参数传进来，以及本进程的
 * 入口脚本本身就在运行时里面。两条互相独立，任一条命中即可。
 *
 * @returns 锚点绝对路径；都没找到时返回 undefined。
 */
export function findInstallAnchor() {
	const candidates = [];
	const runtimeDir = process.argv[2];
	if (typeof runtimeDir === "string" && runtimeDir !== "") {
		candidates.push(join(runtimeDir, "node_modules", RUNTIME_PACKAGE, "package.json"));
	}
	for (const entry of [process.argv[1], fileURLToPath(import.meta.url)]) {
		if (typeof entry !== "string" || entry === "") continue;
		let directory = dirname(entry);
		for (let depth = 0; depth < ANCHOR_SEARCH_DEPTH; depth++) {
			candidates.push(join(directory, "node_modules", RUNTIME_PACKAGE, "package.json"));
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// 读不到的候选只是"不是锚点"，继续找。
		}
	}
	return undefined;
}

/**
 * 取本次解析使用的锚点：优先 ctx 提供的权威值（启动器自己解析出来的那个），
 * 否则回落到模块加载期找到的。
 *
 * @param ctx - 插件上下文。
 * @returns 锚点路径。
 */
export function anchorFor(ctx) {
	const fromContext = typeof ctx?.get === "function" ? ctx.get("profileContext")?.installAnchor : undefined;
	return fromContext ?? findInstallAnchor();
}

/**
 * 取真实路径，让 `import()` 命中进程里已有的那份模块实例。
 *
 * Node 的 ESM 缓存以真实路径为键；少了这一步就会悄悄多出第二份实例 —— 对本插件
 * 来说那是致命的（见 `lib/index.js` 里关于策略模块实例的说明）。
 *
 * @param path - 绝对路径。
 * @returns 可读时为真实路径，否则原样返回。
 */
export function canonical(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * 以运行时锚点为基准解析一个裸包名。
 *
 * @param specifier - 裸包名。
 * @param anchor - 锚点路径。
 * @returns 解析出的入口文件绝对路径。
 * @throws 锚点缺失或包不可解析时。
 */
export function resolveFromRuntime(specifier, anchor) {
	if (anchor === undefined) throw new Error(`proxy-control：定位不到 dsh 运行时，无法解析 "${specifier}"`);
	return createRequire(anchor).resolve(specifier);
}

/**
 * 把一个运行时包解析成可供 `import()` 的文件 URL。
 *
 * `require.resolve` 走的是 `require` 条件；而运行时里的消费者都按 ESM 加载这些包。
 * 一个包同时提供两份产物时（schemastery 就同时有 `index.cjs` 和 `index.mjs`），
 * 这里显式取 `exports["."].import`，让本插件与运行时共用**同一个模块实例**，
 * 而不是条件不一致的第二份。
 *
 * @param specifier - 裸包名。
 * @param anchor - 锚点路径。
 * @returns 文件 URL。
 */
export function runtimeModuleURL(specifier, anchor) {
	let manifestPath;
	try {
		manifestPath = resolveFromRuntime(`${specifier}/package.json`, anchor);
	} catch {
		// 包没有导出自己的 manifest，走下面的回落。
	}
	if (manifestPath !== undefined) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			// exports 里的路径是相对**包根**的，不是相对 require 条件解析到的那个文件。
			const entry = manifest.exports?.["."]?.import ?? manifest.module ?? manifest.main;
			if (typeof entry === "string" && entry !== "") return pathToFileURL(canonical(join(dirname(manifestPath), entry))).href;
		} catch {
			// manifest 读不了，走下面的回落。
		}
	}
	return pathToFileURL(canonical(resolveFromRuntime(specifier, anchor))).href;
}

/**
 * 加载一个运行时模块，并把 CJS/ESM 的默认导出差异抹平。
 *
 * @param specifier - 裸包名。
 * @param anchor - 锚点路径。
 * @returns 模块命名空间（必要时退回到 `default`）。
 */
export async function importFromRuntime(specifier, anchor) {
	const loaded = await import(runtimeModuleURL(specifier, anchor));
	if (loaded.default !== undefined && Object.keys(loaded).length === 1) return loaded.default;
	return loaded;
}

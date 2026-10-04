/**
 * 读取 Windows 系统代理（WinINET 设置）。
 *
 * 用 `reg.exe` 读注册表而不是原生模块：没有编译产物、没有额外依赖，失败时也只是
 * 一条错误信息 —— 插件永远不该因为探测不到系统代理就起不来。
 *
 * @module dsh-proxy-control/system-proxy
 */

import { execFile } from "node:child_process";
import { parseRegQueryOutput, readRegDword } from "./logic.js";

/** WinINET 的代理设置键。 */
const SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** 默认超时：注册表读取是本地操作，5 秒已经非常宽裕。 */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 本进程是不是跑在桌面版（Electron）里。
 *
 * `process.versions.electron` 只在 Electron 运行时里存在：桌面版的宿主就是 Electron
 * 主进程，而 `dsh web` 是纯 Node。官方自己也用这个判断（打包应用与 `.asar` 解包路径
 * 都按它分支），所以在宿主侧判断"桌面还是网页"这是最可靠的一条。
 *
 * 读取而不是缓存：测试要能在同一个进程里模拟两种形态。
 *
 * @returns 桌面版为 true，`dsh web` 为 false。
 */
export function isDesktopHost() {
	return process.versions.electron !== undefined;
}

/**
 * 默认的执行器：跑一次 `reg query` 并把标准输出交回。
 *
 * @param args - `reg.exe` 的参数。
 * @param timeoutMs - 超时毫秒数。
 * @returns 标准输出。
 */
function defaultRun(args, timeoutMs) {
	return new Promise((resolve, reject) => {
		execFile("reg.exe", args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

/**
 * 探测本机的 Windows 系统代理。
 *
 * 「系统代理」这一项**只在桌面版提供**：它读的是**宿主机**（跑 dsh 那台机器）的
 * WinINET 设置，而 Web 端（`dsh web`）既可能是从别的机器访问、又容易让人以为读的是
 * 浏览器那侧的设置 —— 两个误会都不值得留，所以 Web 端直接按"不提供"处理。
 *
 * @param options - 可注入的执行器、超时与桌面标记，便于测试。
 * @returns 探测结果；`supported: false` 表示这里没有"系统代理"这个概念。
 */
export async function readWindowsSystemProxy(options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const run = options.run ?? defaultRun;
	if (!(options.desktop ?? isDesktopHost())) return { supported: false, reason: "Web 端（dsh web）不提供系统代理，它读的是宿主机的 Windows 设置" };
	if (process.platform !== "win32") return { supported: false, reason: "只有 Windows 有可读的系统代理设置" };
	let output;
	try {
		output = await run(["query", SETTINGS_KEY], timeoutMs);
	} catch (error) {
		return { supported: true, error: error instanceof Error ? error.message : String(error) };
	}
	const values = parseRegQueryOutput(output);
	return {
		supported: true,
		enable: readRegDword(values.ProxyEnable) === 1,
		server: values.ProxyServer?.value ?? "",
		bypass: values.ProxyOverride?.value ?? "",
		autoConfigUrl: values.AutoConfigURL?.value ?? ""
	};
}

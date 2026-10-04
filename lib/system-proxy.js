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
 * @param options - 可注入的执行器与超时，便于测试。
 * @returns 探测结果；`supported: false` 表示当前平台没有这个概念。
 */
export async function readWindowsSystemProxy(options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const run = options.run ?? defaultRun;
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

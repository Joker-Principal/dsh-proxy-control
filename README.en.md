# dsh-proxy-control

Control DeepSeek Harness's outbound proxy at runtime: one of three sources, changes apply immediately, no restart.

English ｜ [中文](README.md)

> **DSH Desktop only.** The web build (`dsh web`) is out of scope.

## Features

- **Three sources**: Built-in (the launch environment) / System (the Windows proxy settings) / Manual — pick one.
- **Applies immediately**: edit the address, edit the direct list, switch source — the next request follows the new configuration.
- **Truthful reporting**: shows how traffic would actually route right now, not "what the plugin installed".
- **Coverage**: everything on `fetch` (LLM chat, web search, HTTP MCP), `web_fetch`, subprocesses; loopback addresses are always direct.
- **The self-test** sends one request along the real call path; direct is a valid result too.
- **Splitting** uses the direct list.

## Install

Requires **DSH Desktop** 0.2 series and Node.js 22+.

```sh
dsh plugin --profile desktop add "/absolute/path/dsh-proxy-control"
```

You can also pick the directory in **Settings → Plugins → Add plugin**. After installing, **restart once** (the bundle list is read only at startup); after that every proxy change is live.

This package ships `cordis.patch.yml`, and the entry is inserted into the profile automatically. To change the configuration directly, edit the profile's `cordis.patch.yml`:

```yaml
- id: proxy-control
  name: dsh-proxy-control
  config:
    mode: env          # env Built-in / system System / manual Manual
    proxy: ''          # used by Manual mode only
    noProxy: ''        # direct list
    testUrl: ''        # blank uses the default self-test address
```

> The `enabled` and `autoDetect` fields of earlier versions are removed; if they are still in the configuration they are ignored and cleared on the next save.

## Usage

The settings page is in **Settings → Proxy**.

- The three source rows are always present; the unselected ones are only dimmed and marked "not selected"; switching source forces a re-read of that source.
- The `?` next to the title holds the explanation; the row holds only the result.
- The three actions are icon buttons; the hover tip gives the function: Read again (Built-in row), Detect again (System row), Test (self-test address row).
- The three hand-typed fields **save on blur**, Enter works too — there is no save button.
- The three results (the Built-in source, the proxy in effect, the self-test result) are shown below their own row.

"Test" sends one request along the Harness's own call path (the global `fetch`), so it answers "what will happen once this configuration takes effect". It tests the configuration in front of you: unsaved edits are saved first.

## Configuration

| Setting | Description |
|---|---|
| Proxy source | One of `Built-in` / `System` / `Manual`. Defaults to `Built-in`, which is inert — installing changes no behavior. |
| Proxy address | Manual mode only. For example `http://127.0.0.1:7890`; only `http://` and `https://` are accepted. |
| Direct list | Hosts here do not go through the proxy. Manual/System mode only; Built-in mode follows the environment's `NO_PROXY`. |
| Self-test address | The address "Test" visits; blank uses `https://www.gstatic.com/generate_204`. |

## The three sources

| Name in the UI | Read from | When to use |
|---|---|---|
| **Manual** | the address you enter | most common |
| **System** | the Windows registry `Internet Settings` (PAC is not parsed) | your proxy app has system proxy turned on |
| **Built-in** | `$DSH_HOME/.env`, or variables exported before launch | already configured in `.env` and you want the plugin to read without interfering |

**Built-in = staying out of it**: the plugin installs nothing; routing goes to the layer DSH builds at launch. So "Proxy in effect" names which layer it is:

```
Proxy in effect: http://127.0.0.1:7890 (the launch environment (.env or exported variables))
```

When the parentheses read "this plugin's configuration", the plugin's policy is routing; when they read "the launch environment…", it is the launcher layer (the normal state in Built-in). With no proxy it reads "Proxy in effect: direct".

Two points: `.env` is read once at launch only, so changing it requires a restart; with only `HTTPS_PROXY` set the official parser still sends `http://` targets direct — set both to route both.

## Known limitations

- **SOCKS is not supported**: the policy only accepts `http:` / `https:`; entering one is explicitly rejected with the reason.
- **The system proxy** is read only while it is selected, and it takes a manual "Detect again" to catch up with changes in the system; PAC is not parsed.
- **The system bypass list is ignored wholesale**: wildcard forms like `127.*`, `<local>` are not supported by this Harness's matcher; loopback addresses are forced direct anyway.
- **The direct list does not support CIDR** (`10.0.0.0/8` and the like are dropped, with a notice).
- **No per-category switches**: LLM chat and web search hit the same URL and cannot be told apart at the transport layer; finer rules are left to the proxy app.
- **Custom CA**: a proxy doing TLS interception requires `NODE_EXTRA_CA_CERTS` set before launch.
- **Electron's own traffic** (auto-update, sign-in page) is in another process's network stack; the plugin cannot reach it.
- Subprocesses follow the policy; but when `.env` also configures a proxy, subprocesses follow the `.env` value. The UI and the logs point out this fork.

## Security

The settings page endpoints can change where traffic goes, so they accept only requests from this machine (403), require `Host` to be a loopback address (blocks DNS rebinding, 403), and reject request body forms that can be sent cross-site without a preflight (415). DSH's Web server itself carries no authentication or origin policy, so a third-party route must set up its own guard.

## Troubleshooting

The "Proxy in effect" row is the authoritative reading. To see what a subprocess got:

```powershell
$env:HTTPS_PROXY; $env:NODE_USE_ENV_PROXY
```

These two are published to subprocesses only after the policy is installed. In the logs:

```
proxy-control：出站请求经由 http://127.0.0.1:7890（手动指定），直连名单 api.deepseek.com
proxy-control：不干预路由（启动环境里没有代理设置（查过 C:\Users\Joker\.dsh\.env），按直连处理）
proxy-control：不干预路由（启动环境里有 http://127.0.0.1:7890，插件不插手（那就是启动器那层在生效））
proxy-control：无法使用 <地址>（<原因>），出站请求保持直连
```

An unusable proxy never kills the agent: it logs a warning line and stays direct. Uninstalling the plugin restores the launcher's own policy.

## License

[MIT](LICENSE)

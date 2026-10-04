# dsh-proxy-control

Control **DeepSeek Harness**'s outbound proxy at runtime: one settings page, three address sources, Windows system proxy detection, a connectivity self-test — **changes apply immediately, no restart**.

English ｜ [中文](README.md)

```
Settings → Proxy
```

## Features

- **Three address sources, mutually exclusive**: Built-in (the DSH launch environment) / System (the Windows proxy settings) / Manual (you fill it in yourself).
- **Changes apply immediately**: switching source, editing the address, editing the direct list — the next request follows the new configuration, no need to restart the app.
- **Truthful status**: the UI shows **how it would actually route right now**, not "what the plugin installed".
- **The connectivity self-test** goes through the real call path and reports both "what the configuration says will happen" and "what actually happened"; direct is a valid result too.
- **Simple splitting** is expressed with the direct list (for example, let the model and search go direct and everything else through the proxy).

## Install

Requires the **DSH 0.2 series** (Desktop or CLI) and Node.js **22+**.

The plugin is installed as a directory into a profile:

```sh
# CLI
dsh plugin --profile desktop add "/absolute/path/dsh-proxy-control"
```

Or from the UI: **Settings → Plugins → Add plugin**, and pick this plugin's directory.

After installing, **restart once** (a profile's bundle list is read only at startup). After that one restart, every later proxy change is live.

This package declares `dsh.bundle.patch` (`cordis.patch.yml`), so the plugin entry is inserted into the profile automatically, with an initial configuration. You can also skip the UI and edit the profile's `cordis.patch.yml` directly:

```yaml
- id: proxy-control
  name: dsh-proxy-control
  config:
    mode: env          # env Built-in / system System / manual Manual
    proxy: ''          # used by Manual mode only
    noProxy: ''        # direct list (simple splitting)
    testUrl: ''        # blank uses the default self-test address
```

> Earlier versions used two fields, `enabled` (a master switch) and `autoDetect`; both are now removed — they duplicated the "Built-in" source. If they are still in your configuration the plugin ignores them, and clears them on the next save.

## Configuration

| Setting | Description |
|---|---|
| Proxy source | **One of three**: `Built-in` / `System` / `Manual`. Defaults to `Built-in` — which is **inert**: installing the plugin changes no behavior. |
| Proxy address | Only takes effect in Manual mode. For example `http://127.0.0.1:7890`. Only `http://` and `https://` are accepted. |
| Direct list | Simple splitting: the hosts listed here do not go through the proxy. Only takes effect in Manual/System mode; Built-in mode follows the `NO_PROXY` from the environment. |
| Self-test address | The address the "Test" button visits; leave it empty to use `https://www.gstatic.com/generate_204`. |

## The three sources

| Name in the UI | Read from | When to use |
|---|---|---|
| **Manual** | the address you type in the UI | most common |
| **System** | the Windows registry `Internet Settings` (PAC is not parsed) | your proxy app has "system proxy" turned on and you do not want to sync the port by hand every time |
| **Built-in** | the **launch environment**: `$DSH_HOME/.env`, or variables exported before launch | you already configured a proxy in `.env` and want the plugin to stay out of it and only report it truthfully (the default) |

### Why the "Built-in" option exists

The Harness resolves the proxy policy only once, at launch:

```
dsh-desktop-host → runProfile()
    → installProxyFromEnvironment(loadLayeredEnv("dsh"))   ← the policy is fixed here
    → boot(...) → your plugins start mounting              ← plugins only come alive after this
```

In other words, with Built-in the only way to change the proxy is to edit `$DSH_HOME/.env` and then restart. This plugin re-runs the same installation at runtime, with the configuration coming from its own entry, so changing the address in the settings page takes effect on the **next request**.

### Two layers: why traffic can still go through a proxy when the plugin stays out of it

**The launcher layer and the plugin layer are two layers, independent of each other.**

- The launcher layer is installed before any plugin mounts. If you wrote the proxy into `.env` or exported the variables before launch, that layer is **live**.
- The plugin can only manage its own layer. With "Built-in" the plugin **installs nothing**, and what it releases is only the plugin layer — **the launcher layer stays in effect as before**.

So "the plugin staying out of it means direct" is wrong. That fact has to be shown truthfully rather than guessed by the UI: the "Proxy in effect" line in the settings page names **which layer** is in effect:

```
Proxy in effect: http://127.0.0.1:7890 (the launch environment (.env or exported variables))
```

When the parentheses say "this plugin's configuration", the plugin is doing the routing; when they say "the launch environment (.env or exported variables)", the launcher layer is what is in effect. With no proxy, the line reads "Proxy in effect: direct".

Two details:

- **`.env` is read once at launch only**, so editing `.env` still requires a restart; Built-in mode does not turn it into a hot update.
- There is a real behavior of the official parser that you will see as-is: **with only `HTTPS_PROXY` set, `http://` targets still go direct**. If you want both to go through the proxy, set `HTTP_PROXY` as well.

## What "Test" tests is the effect of the configuration

The button goes through the **Harness's own call path**: the global `fetch()` — the one used by LLM requests, web search and HTTP MCP. So it answers "what will happen once your configuration takes effect", not "is this proxy usable".

The result is shown **below the self-test address row** and gives two things at once:

```
reachable · via http://127.0.0.1:7890 · 204 · 120 ms
reachable · direct · 204 · 80 ms
unreachable · via http://127.0.0.1:7890 · <error>
```

- The **route** is the configuration's verdict for this test address — a different protocol can give a different answer (with only `HTTPS_PROXY` set, `http://` targets go direct).
- The **result** is the status code and latency obtained after actually sending the request.

**Direct is a valid result too** and is reported as such: when the configuration is direct, "can it get out directly" is just as much what you want to know.

Two notes:

- It tests **the configuration in front of you**: if there are edits not yet persisted when you click the button (say you just changed the address and clicked Test right away), they are written down first and then the test runs — otherwise the result would straight-facedly report an address you have already changed.
- The API does **not** accept "test a proxy specified on the fly". Earlier versions could, but what it measured was the proxy's availability, not the effect of the configuration.

## UI notes

- The three source rows (Built-in / System / Manual) are **always visible**, and the unselected ones are just dimmed and marked "not selected" — that way you can see at the same time what the other sources hold right now, and see clearly "which fields a switch will take away". Switching source also **forces a re-read** of that side (their values are edited elsewhere), so what you get is the value as of now rather than a cache.
- The Built-in and System rows **show the result only**: the proxy server if one was read, otherwise "direct". Why it is direct, and where to turn it on, are both in the `?` next to the title (expanded on hover or keyboard focus); the long help can use line breaks to split it into paragraphs.
- The three actions are **icon buttons**, with their function written in the hover tip (the button still carries an `aria-label`, so both keyboard and screen readers work): a circular arrow on each of the Built-in and System rows (Read again / Detect again), and a signal icon after the self-test address input (Test).
- **There is no "Save" button**: the three hand-typed fields are **persisted automatically on blur**, and Enter works too. Switching source, Read again and Test all take effect on click, so having only those three fields need an extra button press is an inconsistency more error-prone than "forgot to save". Conversely, **blur only saves; it never triggers a test**.
- **All three "read-out results" appear below their own row** (the Built-in row's source, the proxy in effect, the self-test result) — a separate paragraph would be cut off by the divider, and squeezing them into the main row would make the controls on the right jump up and down.

## Coverage

The plugin drives the runtime's own policy module, so its coverage is **exactly the same** as the one the DSH launcher installs itself:

| Traffic | Through the proxy |
|---|---|
| LLM chat, web search, HTTP MCP (all through the global `fetch`) | ✅ |
| Web fetch `web_fetch` | ✅ it asks the same policy, and only switches to an explicit dispatcher when the answer is "through the proxy" |
| Subprocesses: bash / pwsh / curl / git / pnpm | ✅ installing the policy publishes `HTTP_PROXY`/`HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` |
| Loopback addresses (the local Web UI, Connection) | ❌ the policy forces `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0` direct |
| OTEL telemetry, `ws` remote connections, PTC/workflow worker | ❌ by upstream design they do not go through a proxy |
| Electron/Chromium's own traffic (auto-update, welcome page, sign-in page) | ❌ another process's network stack; the plugin cannot reach it |

**One asymmetry the plugin layer cannot fix**: the policy module records "the environment variables from the outermost installation" in its own private state, and there is no API to change it. So when `.env` also configures a proxy, **subprocesses follow the `.env` value, while inside this process the plugin's configuration is followed**. The plugin points out this fork in the UI and in the logs; to remove the ambiguity, keep only one source — or simply set the source to "Built-in" so both come from the same place.

## On splitting: why there are no per-category switches

You may want a switch like "LLM through the proxy, web_fetch not". **In this runtime that is not possible, and it should not be done**, for two hard constraints:

1. **LLM chat and web search are the same URL.** Both end up at `https://api.deepseek.com/anthropic/v1/messages`, and at the transport layer they cannot be told apart (the only difference is in the request body, which the dispatcher cannot see).
2. **The web fetch proxy is tied to subprocesses.** As soon as the official policy is installed it publishes the proxy variables to all subprocesses. **Turn web fetch on → subprocesses necessarily inherit the proxy, and it cannot be turned off.**

So "simple splitting" is expressed with the **direct list**, which is accurate and predictable:

```
Direct list: api.deepseek.com        # models and search direct, web fetch and MCP through the proxy
```

Really fine-grained splitting (domain rules, GeoIP, process names) is left to the proxy app itself — it can see far more information than this layer, and two rule engines side by side only leave you not knowing who decided what when something goes wrong.

## Known limitations

- **SOCKS is not supported.** The official policy only accepts `http:`/`https:`, and SOCKS cannot cover web fetch. Entering SOCKS is explicitly rejected with the reason, not silently ignored.
- **No per-category switches**, for the reasons above.
- **The system proxy is a source only when "System" is selected**, and it is read at launch, on every configuration change, and when you click that row's **Detect again** icon. If you changed the proxy port in Windows, you need to click it once. **PAC is not parsed** (and that is reported).
- **The system bypass list is ignored wholesale**: on Windows it is largely wildcard forms like `127.*`, `192.168.*`, `<local>`, while this Harness's matcher only compares hostname suffixes, so copying it over would become a pile of entries that never match. Loopback addresses are forced direct anyway.
- **The direct list does not support CIDR** (`10.0.0.0/8` and the like are dropped, with a notice).
- **Custom certificate authorities are not supported.** A corporate proxy doing TLS interception requires `NODE_EXTRA_CA_CERTS` to be set before launch.
- **Electron's Chromium traffic cannot be reached** — see the coverage table.

## Security

The few endpoints the settings page uses can rewrite "where traffic goes", so they carry three restrictions: **only requests from this machine are accepted**, **the `Host` must be a loopback address** (blocks DNS rebinding), and **a request body form that can be sent cross-site without a preflight is not accepted** (blocks cross-site requests from ordinary web pages; such requests get 403 / 415).

The reason for this is that DSH's Web server itself carries no authentication or origin policy, so a third-party route must set up its own guard; otherwise any web page you visit could reroute outbound traffic to a proxy of its own.

## Troubleshooting

**In the UI**: the "Proxy in effect" line below the "Proxy source" row is the authoritative reading; the parentheses name which layer is in effect.

**In a shell** (let the agent run it itself):

```powershell
$env:HTTPS_PROXY; $env:NODE_USE_ENV_PROXY
```

These two are published to subprocesses **only when the policy is already installed**, so it is a live reading, not an echo of a configuration file.

**In the logs**:

```
proxy-control：出站请求经由 http://127.0.0.1:7890（手动指定），直连名单 api.deepseek.com
proxy-control：不干预路由（启动环境里没有代理设置（查过 C:\Users\Joker\.dsh\.env），按直连处理）
proxy-control：不干预路由（启动环境里有 http://127.0.0.1:7890，插件不插手（那就是启动器那层在生效））
proxy-control：无法使用 <地址>（<原因>），出站请求保持直连
```

**Two behavioral guarantees**:

- **An unusable proxy never kills the agent.** SOCKS, invalid URLs and unsupported protocols all log a warning line and stay direct; the process keeps running as usual.
- **Uninstalling the plugin restores the launcher's own policy**, because it added a layer on top of it rather than replacing it.

## License

[MIT](LICENSE)

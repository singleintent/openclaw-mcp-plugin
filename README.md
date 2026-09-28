# SingleIntent OpenClaw MCP plugin

An OpenClaw plugin that ships the SingleIntent MCP server as a plugin-owned
stdio process.

**Status: early.** One verb, `list_projects`. Everything below is verified
against OpenClaw 2026.9.5 and a running product.

## Configuration

The server resolves its own configuration. Precedence, highest first:

1. **Environment variables** — the manifest supplies `HOST` and `PORT` defaults
2. **A config file** — `$SINGLEINTENT_CONFIG`, else `$HOME/.singleintent/config.json`
3. **Built-in defaults**

| Variable | Default | Purpose |
| --- | --- | --- |
| `SINGLEINTENT_HOST` | `127.0.0.1` | Product host |
| `SINGLEINTENT_PORT` | `5173` | Product port |
| `SINGLEINTENT_CONFIG` | — | Config file path override |
| `SINGLEINTENT_TOKEN` | unset | Auth token; no header is sent while unset |
| `SINGLEINTENT_TOKEN_FILE` | unset | Path to a token, keeping the secret out of config |

The config file takes `host`, `port` and `token`. An absent file is normal.
Malformed JSON, a non-object file, an out-of-range port, or an unreadable or
empty token file all **fail loudly** rather than falling back to defaults and
appearing to work against the wrong host.

Loopback is the *default*, not a fixed value. Both host and port are
overridable: `5173` is Vite's default dev port, so it collides on developer
machines, and a stale process squatting it will serve a stale build.

> **Do not configure this plugin by editing `mcp.servers.singleintent`.** That
> override **replaces** the manifest definition rather than merging with it, so
> setting only `env` there drops `command` and OpenClaw skips the server
> entirely — `[bundle-mcp] skipped server "singleintent" because its command is
> missing and its url is missing`. It is silent from your side. If you do need
> it, restate `transport`, `command` and `args` in full.

### Why not `plugins.entries.singleintent.config`?

Because a stdio subprocess cannot read it. Manifest `env` takes no templating,
the only runtime MCP hook resolves `url`/`headers` for HTTP transports, and the
child does not inherit the Gateway environment — it receives `HOME`, `LOGNAME`,
`PATH`, `SHELL`, `USER` and `__CF_USER_TEXT_ENCODING`, plus whatever the server
definition declares. The cost of that is real: SecretRef support covers only
`plugins.entries.<id>.config`, so it is unavailable here. `SINGLEINTENT_TOKEN_FILE`
is the mitigation, and it is weaker.

An alternative was tested and rejected: having the plugin entry, which *can* read
plugin config, resolve it at activation and write it to a file the subprocess
reads. It fails because the subprocess has no profile identity, so `$HOME` is the
only path both sides can derive — and two OpenClaw profiles would then write and
read the *same* file, clobbering each other with the child unable to tell which
config it holds.

The distinction that makes the config file above safe where that bridge is not:
**a human-written config file has one writer and one intent.** The bridge has one
writer per profile, racing. Identical file location, completely different safety
properties.

### Known-unverified behaviour

Two things this plugin's design leans on are characterised but **not proven**,
and are recorded here rather than asserted:

- **Manifest MCP servers appear to spawn lazily**, so the plugin entry runs
  first. This rests on the subprocess being *absent* while an idle Gateway was
  fully started — not on an observed spawn.
- **Whether a running subprocess is restarted when config changes is unverified.**
  No spawn could be forced without model credentials. `openclaw mcp reload`
  exists to dispose cached MCP runtimes, which suggests a running child does not
  pick up changes by itself. If configuration appears not to take effect, restart
  the Gateway rather than assuming the file was wrong.

Related, for anyone extending the plugin entry: **`register()` is called
repeatedly — seven times in one observed Gateway start — and the first call
arrives with plugin config absent.** Anything reading plugin config there must
tolerate being called with none, or it will act on empty config intermittently.

## Verbs

### `list_projects`

Returns `id`, `name`, `workingDirectory` and `agentCount` per project, with
`total` and `truncated`. Takes `limit` (1–200, default 50) and `offset`.

```json
{ "projects": [{ "id": "0bef…", "name": "mob2", "workingDirectory": "/Users/…/mob2", "agentCount": 3 }],
  "total": 11, "truncated": true }
```

**`agentCount` replaces the product's `agentIds` array deliberately.** Bounded
scalars pass through; unbounded collections become counts. That array is what
grows as the product grows, and an agent choosing what to do next needs to know
which projects exist and how big they are, not every member id. On live data the
projection is 45% smaller than the raw response. Ask the agents verb for
identities.

## Names

Three strings matter, and two of them are easy to conflate:

| String                                | Value                                 | What it controls                                        |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Manifest `id`                         | `singleintent`                      | The `plugins.entries.<id>` config key                   |
| `mcpServers` key                      | `singleintent`                      | The tool prefix, and the `mcp.servers.<name>` override key |
| npm package                           | `@singleintent/openclaw-mcp-plugin` | What consumers install                                  |

The manifest `id` and the `mcpServers` key are **independent strings**. They are
set equal here as a deliberate choice, not because OpenClaw requires it;
`src/mcp-server.test.ts` fails if they drift apart. Tools discovered from this
server are named `singleintent__<verb>` — note the prefix is the `mcpServers`
key, and there is no `mcp__` prefix. (`mcp__<server>__<tool>` is Claude Code's
harness convention, not OpenClaw's.)

The prefix is sanitized before use: characters outside `[A-Za-z0-9_-]` become
`-`, a name not starting with a letter gets an `mcp-` prefix, and long or
duplicate prefixes may be truncated or suffixed. `singleintent` is unchanged by
all three rules, which is the reason for the single lowercase token.

## Install

Installing is two steps on purpose. Run it **without** the flag first to read the
capabilities the plugin declares:

```bash
openclaw plugins install @singleintent/openclaw-mcp-plugin
```

That stops at a consent gate and installs nothing. Once you have read the
capability list, accept it:

```bash
openclaw plugins install @singleintent/openclaw-mcp-plugin --accept-capabilities
```

Installing from a local path or any non-ClawHub source hits a **second, separate**
gate and refuses with "Install cancelled; rerun with --force after reviewing the
source." Developing against a checkout therefore needs both flags:

```bash
openclaw plugins install . --link --accept-capabilities --force
```

The plugin declares its MCP server in `openclaw.plugin.json` rather than
registering tools in code. That matters to you as a consumer: manifest-declared
servers merge into the `bundle-mcp` namespace, which the default `coding` and
`messaging` tool profiles already admit, so there is nothing to add to
`tools.alsoAllow`. Tools registered through the plugin API instead would be
scoped under the plugin id and would require a hand-edited allowlist that an
install cannot write for itself.

### Sandboxed gateways

Sandboxing applies a second allow gate that the above does not satisfy. Add
`bundle-mcp` to `tools.sandbox.tools.alsoAllow`, then reload the gateway:

```json
{ "tools": { "sandbox": { "tools": { "alsoAllow": ["bundle-mcp"] } } } }
```

`openclaw doctor` does not diagnose this case, so a sandboxed turn showing only
built-in tools is the symptom to watch for.

## Verifying the install

> **If `openclaw mcp list` shows nothing, the install has not failed.** That
> command cannot see this plugin and never will. Run
> `openclaw plugins inspect singleintent` instead.

**Three commands that look right and cannot verify this plugin.** All three
report success or silence whether or not the plugin works:

| Command                    | Why it cannot help                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `openclaw mcp list`        | Reads `mcp.servers` config only; never sees a manifest-declared server                  |
| `openclaw mcp probe`       | Same config source, so it connects to everything *except* this server                   |
| `openclaw plugins validate`| Checks tool/feature authoring metadata, which this plugin deliberately does not expose  |

A consumer who reaches for those will get a false negative and conclude the
install failed. Use these instead.

**1. Is the server declared and enabled?**

```bash
openclaw plugins inspect singleintent
```

Look for `Status: enabled` and an `MCP servers:` section listing
`singleintent`. This reads the manifest, so it proves declaration and
enablement — not that the server process runs.

**2. Does the server actually run?**

Drive the handshake directly. This needs no gateway and no config, and it fails
loudly if the package shipped no executable code:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node ./dist/mcp-server.js
```

Expected, from the plugin's install path:

```json
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"singleintent","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
{"result":{"tools":[{"name":"list_projects", ...}]},"jsonrpc":"2.0","id":2}
```

The `serverInfo.name` in the first response is the string OpenClaw prefixes
verbs with, so the tool reaching an agent is `singleintent__list_projects`.

This handshake proves the packaged code runs; it does not reach the product. To
check the transport too, call the verb — replace the `tools/list` line with:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_projects","arguments":{"limit":3}}}
```

A result with `"isError": true` naming an unreachable URL means the plugin works
and the **product** is not answering on the configured host and port. The message
reports which source supplied each value, so `port=SINGLEINTENT_PORT` tells you
the override was read and `port=default` tells you it was not.

`npm test` runs this same handshake against `dist/` as an automated test.

**3. Server started but misbehaving?**

Diagnostics go to stderr, which OpenClaw logs with a `bundle-mcp:singleintent:`
prefix:

```bash
openclaw logs
```

## Development

```bash
npm install
npm test          # builds first, then runs unit tests and the stdio handshake
npm pack          # prepack cleans and rebuilds, so dist cannot go stale
```

`prepack` runs `clean` then `build`, so the build cannot be forgotten before an
artifact is produced. Verify a candidate artifact from a fresh clone rather than
from a working directory, which holds state a consumer never receives:

```bash
git clone <this-repo> /tmp/verify && cd /tmp/verify
npm install && npm pack
tar -tzf *.tgz | sort
```

`files` in `package.json` is a claim about the artifact, not a fact about it.
Read the `tar -tzf` output rather than the field.

## Licence

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

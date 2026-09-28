# SingleInstinct OpenClaw MCP plugin

An OpenClaw plugin that ships the SingleInstinct MCP server as a plugin-owned
stdio process.

**Status: scaffold.** The verb surface is not yet specified, so the server
registers no tools. It completes a full MCP handshake and answers `tools/list`
with an empty array. Everything below is verified against OpenClaw 2026.9.5.

## Names

Three strings matter, and two of them are easy to conflate:

| String                                | Value                                 | What it controls                                        |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Manifest `id`                         | `singleinstinct`                      | The `plugins.entries.<id>` config key                   |
| `mcpServers` key                      | `singleinstinct`                      | The tool prefix, and the `mcp.servers.<name>` override key |
| npm package                           | `@singleinstinct/openclaw-mcp-plugin` | What consumers install                                  |

The manifest `id` and the `mcpServers` key are **independent strings**. They are
set equal here as a deliberate choice, not because OpenClaw requires it;
`src/mcp-server.test.ts` fails if they drift apart. Tools discovered from this
server are named `singleinstinct__<verb>` — note the prefix is the `mcpServers`
key, and there is no `mcp__` prefix. (`mcp__<server>__<tool>` is Claude Code's
harness convention, not OpenClaw's.)

The prefix is sanitized before use: characters outside `[A-Za-z0-9_-]` become
`-`, a name not starting with a letter gets an `mcp-` prefix, and long or
duplicate prefixes may be truncated or suffixed. `singleinstinct` is unchanged by
all three rules, which is the reason for the single lowercase token.

## Install

Installing is two steps on purpose. Run it **without** the flag first to read the
capabilities the plugin declares:

```bash
openclaw plugins install @singleinstinct/openclaw-mcp-plugin
```

That stops at a consent gate and installs nothing. Once you have read the
capability list, accept it:

```bash
openclaw plugins install @singleinstinct/openclaw-mcp-plugin --accept-capabilities
```

Installing from a local path or any non-ClawHub source additionally requires
`--force`, which confirms you reviewed the source.

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
openclaw plugins inspect singleinstinct
```

Look for `Status: enabled` and an `MCP servers:` section listing
`singleinstinct`. This reads the manifest, so it proves declaration and
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
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"singleinstinct","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
{"result":{"tools":[]},"jsonrpc":"2.0","id":2}
```

`"tools":[]` is correct at this stage, not a failure. Until the verb surface
lands, **no `singleinstinct__*` tools will appear in any tool list** — so absence
of tools is not evidence of a broken install. The `serverInfo.name` in the first
response is the string OpenClaw will prefix verbs with.

`npm test` runs this same handshake against `dist/` as an automated test.

**3. Server started but misbehaving?**

Diagnostics go to stderr, which OpenClaw logs with a `bundle-mcp:singleinstinct:`
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

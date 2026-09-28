# SingleIntent OpenClaw MCP plugin

An OpenClaw plugin that ships the SingleIntent MCP server as a plugin-owned
stdio process.

**Status: the v1 read surface is complete.** Seven verbs — `list_projects`,
`get_project`, `list_agents`, `list_templates`, `list_connections`,
`get_backlog`, `get_activity`. All reads; no write verb exists yet. Everything
below is verified against OpenClaw 2026.9.5 and a running product.

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

Loopback is the *default*, not a fixed value. `5173` is the product's own port,
chosen rather than inherited — Vite was deliberately moved to `5174` so the
product server could keep it — and the product honours `PORT`, so this override
exists to follow it. A stale process squatting `5173` will serve a stale build,
which is what the override is for.

The host override is currently **forward-looking rather than immediately useful**:
the product binds loopback only and rejects any `Host` header outside
`127.0.0.1`, `localhost` and `[::1]`, so pointing this at a remote host needs a
product-side change first. It exists because adding it later would be a breaking
change to a published config contract, and having it costs nothing.

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
`total` and `truncated`. Takes `limit` (1–200, default 200), `offset`, and an
optional `agent_id` filter.

```json
{ "projects": [{ "id": "0bef…", "name": "mob2", "workingDirectory": "/Users/…/mob2", "agentCount": 3 }],
  "total": 11, "truncated": true }
```

> **The shaping rule, which governs every list verb: bounded scalars pass
> through; unbounded collections do not, and are replaced by a count.**
>
> **And the boundary it implies: a list verb carries identity plus size; a detail
> verb carries the whole record.**

These are rules rather than judgement calls, so that every later verb can be
argued against them instead of re-litigating field by field.

**`agentCount` replaces the product's `agentIds` array** under that rule. The
array is what grows as the product grows, and an agent choosing what to do next
needs to know which projects exist and how big they are, not every member id. On
live data the projection is 45% smaller than the raw response.

`workingDirectory` is kept for the opposite reason: it is identity, not payload.
`name` alone is ambiguous across similarly-named projects; the path is what maps a
project to a checkout, and it is how a person actually recognises one.

**What this projection cannot answer, and the obligation that follows.** "Which
project is this agent in?" is a real question, and a response carrying only
`agentCount` cannot answer it. Dropping `agentIds` therefore makes a detail verb
**required, not optional** — hence `get_project` below.

#### `agent_id` — the reverse lookup

`get_project` alone does **not** answer the question above, which is worth stating
because it is easy to assume it does. `get_project` answers "who is in project X",
and needs X up front. The reverse lookup is a different question whose answer is a
**list**: on live data `travel-agent` belongs to both `mob2` and `Personal`, so no
verb keyed on a single project can answer it.

`agent_id` is that lookup. When set, only projects whose `agentIds` contains it
are returned:

```json
{ "projects": [{ "id": "1634…", "name": "mob2", … }, { "id": "1b0c…", "name": "Personal", … }],
  "total": 2, "truncated": false }
```

> **`total` counts the matching projects, not every project that exists.** The
> unfiltered call above reports `total: 12` against the same data. Reading a
> filtered `total` as an inventory is the wrong assumption to make here.

**Why a filter and not a field selector, and not a third verb.** A selector
changes *which fields* come back, so the response shape becomes conditional on
arguments — harder to document, harder to cache, harder to reason about at the
call site. A filter changes *which rows*, and the shape is byte-identical whether
it is set or not. A third verb was rejected for the opposite reason: "which
projects contain agent X" is answered by a list of project summaries, which is
exactly what this verb already returns, so a third one would be the redundancy.

Filtering happens **before** paging. The other order would page an unfiltered list
and then thin the page, giving short pages and a `total` no amount of paging could
reach.

A malformed `agent_id` is rejected rather than passed through, because a
structurally impossible id would match nothing and return an empty list that reads
as a real answer. A *well-formed* id matching no project returns empty, because
that is the truthful answer.

### `get_project`

The detail verb the projection above made necessary. Takes a required
`project_id` and returns the whole record — `agentIds` in full, plus `createdAt`,
which the summary drops for signal-per-byte and which a detail verb has no reason
to withhold.

```json
{ "project": { "id": "1634…", "name": "mob2", "workingDirectory": "/Users/…/mob2",
               "agentIds": ["mob2-eng-manager", "mob2-uiux-expert", "travel-agent"],
               "createdAt": "2026-09-17T20:38:08.052Z" } }
```

The response is wrapped in `project` rather than returned flat, so a sibling field
can be added later without changing a shape consumers depend on — the same
reasoning that put `total` and `truncated` alongside `projects`.

`agentIds` is passed through uncapped. It is the reason the verb exists, so
counting it here would leave the question unanswered again. If it ever needs
paging, that is a separate verb rather than a shape conditional on arguments.

**This selects from the list route; it does not fetch a detail route.** There is
no detail route to fetch: the product matches `/api/projects` for GET and POST
only, and `GET /api/projects/<uuid>` answers **404**. (`lib/joylabs-projects.js`
does export `getProject(id)`, but it is internal and never routed.) So the one
round trip goes to `/api/projects` and the selection happens in the plugin. If a
detail route lands later the swap is confined to `getProject()` in
`src/verbs/get-project.ts`, which says so in a comment.

> **Why a retired name appears in current code, and the break it sets up.**
> `lib/joylabs-projects.js` and `lib/joylabs-ids.js` are the product repo's real,
> current filenames; that repo has not been renamed even though this plugin's
> brand was. They are accurate citations, not stale references, and the
> retired-name guard scopes to this plugin's own identity rather than failing on
> them — widening it would only teach whoever hit it to weaken the test.
>
> **Known future break:** when the product repo is renamed, these citations go
> stale in the worse direction — pointing at files that no longer exist rather
> than merely carrying an old name. Whoever does that rename should re-point them
> here, in `src/verbs/get-project.ts` and in `src/verbs/list-projects.ts`.

**Two distinct failures, deliberately not collapsed into one:**

| Input | Result |
| --- | --- |
| Malformed `project_id` | Rejected before any request — no round trip is spent |
| Well-formed id, no such project | `ProjectNotFoundError` naming the id and the number of projects the product reported |
| Product unreachable | `ProductError` naming the URL and where host and port came from |

"No such project" and "the product is down" call for different responses from a
caller, so they are different error types. Collapsing them would make a stale id
look like an outage.

### `list_agents`

The roster, each row carrying the onboarding status the product merges into it.
Live: 53 rows, 53,688 bytes raw, 44.7% smaller after the projection.

**Dropped, and why each:**

| Field | Why |
| --- | --- |
| `thinkingLevels`, `thinkingOptions` | Byte-identical on all 53 rows — 30.7% of the response for no per-row information. A fixed capability menu belonging to the host, not the agent. A count would be the constant 8, so they are dropped rather than counted. |
| `agentRuntime` | Same reason: identical on every row. |
| `defaultId`, `ownership`, `selectionRequired`, `mainKey`, `scope` | The Gateway's agent-*selection* policy — which agent answers an unaddressed message. A different question from "which agents exist", and it should not ride along under a name that does not say so. |

`thinkingDefault` is kept while the levels list is dropped, and the pairing is
the point: the levels available are the host's, the level chosen is the agent's.
`onboarding` is kept whole — it is the reason this route exists rather than a
direct Gateway call.

> **`createdAt` here is epoch milliseconds.** On `/api/projects` the field of the
> same name is an ISO-8601 string. Passed through unnormalised, because this
> connector reports what the product stores; inventing a consistency the product
> does not have would misrepresent it.

#### `project_id`, and the membership guarantee

The filter runs in the connector, not on the server. Every product route is an
exact-string match on `req.url` with no query parsing, so a query parameter would
be accepted, ignored, and return an unfiltered list that looks like a successful
filter.

Membership is read from `/api/projects` — the same source `get_project` reads —
so the two verbs cannot disagree about membership by construction. They can
disagree about **existence**, and on live data they do: one project still lists
an agent that was renamed out of the roster. Those ids come back in
`missingFromRoster` rather than vanishing, so the relationship holds:

```
get_project(id).agentIds  ==  agents[].id  ∪  missingFromRoster
```

`missingFromRoster` is always present, `[]` when no filter is set, so the shape
is byte-identical whether `project_id` is passed or not.

### `list_templates`

`id`, `name`, and `contentLength`. **`content` is not returned**: live it is
35,903 of the response's 37,913 bytes — 94.7% — and an agent listing templates is
choosing one, not reading one.

This extends the shaping rule from unbounded *collections* to unbounded *text*.
A template's content is an agent's whole system prompt, so the property the rule
is about is unboundedness rather than array-ness, and `contentLength` is the
count analogue for a string. It counts characters, not bytes; zero is a real
value, not a stand-in for absent.

> **A known gap, stated rather than papered over.** Dropping `content` makes a
> `get_template` an obligation in the same way dropping `agentIds` made
> `get_project` one — nothing in the connector can currently read a template's
> text. It is not added here because W-030 scopes five verbs and that is not one
> of them. Until it lands: this verb tells you *which* template to use, not what
> it says.

### `list_connections`

The whole record — `id`, `from`, `to`, `establishedAt`. All four are bounded
scalars, so **the projection drops nothing**. That is the rule's output here, not
a place the rule was skipped; cutting a field for symmetry with the other verbs
would be cutting without a reason. `total` and `truncated` are still present,
because the list contract does not depend on whether anything was dropped.

A connection is **directed**: `from` was pointed at `to` and asked to introduce
itself, under the product's interjection-only model. The pair is not symmetric
and is not presented as one.

The ids are not expanded into agent records. That would mean a second request to
the Gateway-backed `/api/agents` on every call, making a store-backed verb fail
whenever the Gateway is down — a 500-class surface turned into a 502-class one
for nothing. Call `list_agents` if you want the agents behind the ids.

### `get_backlog`

Every stored field, including `description`.

**Read-only by design, not by omission.** `~/.joylabs/backlog.json` is written
only by agents through their own file tools — no API, no locking. A write verb
would add a second uncoordinated writer, and last-write-wins on a whole-file
rewrite loses items silently. For the same reason **a stale read is not an
error**: nothing here validates freshness or retries to chase it.

`description` survives where `list_templates` cut `content`, by this
discriminator: *does the row still answer the verb's question without the field?*
A template row without content still identifies a template well enough to choose
one. A backlog item without its description is a title and a status — the
description **is** the item.

Named `get_` per SCRUM-6, and still returning `{items, total, truncated}`: the
thing inside the document is an unbounded list, and nobody should have to learn a
second pagination story for the one verb whose name starts differently.

### `get_activity`

Running sessions plus those that ended inside the product's recently-ended
window, and `now`.

> **`now` is the product server's clock, passed through verbatim. Compute elapsed
> time against it, not against your own clock.**

Every timestamp in the response is epoch milliseconds on that same clock, and
`now` is the reference point that makes them mean anything. Resampling it here —
even with `Date.now()` on the same machine — would substitute a *different* clock
as the reference for timestamps taken from the first, and the resulting
"3 seconds ago" would be wrong by exactly the skew between them: invisible at the
call site, and not something a caller would think to check. On one host that skew
is small; across a host boundary, which `host` already allows for, it is
unbounded.

There is no fallback. If the product sends no usable `now`, the verb **fails**
and says it is refusing to substitute a local clock, because a substituted
reference is worse than a stated failure — it is wrong in a way that looks right.
`nowSource` is returned alongside, constant `"product"`, so the answer is visible
at the call site rather than only in this file.

The session projection drops nothing — twelve bounded scalars. `displayName` is
already truncated server-side and is not re-truncated here.

## Errors, and the distinction worth keeping

| Situation | Type | Site link | What it means |
| --- | --- | --- | --- |
| Nothing answered | `ProductError` — "cannot reach the product at `<url>`" plus host and port provenance | **yes** | The product is not running, is not installed, or host/port are wrong |
| `502`/`503`/`504` | `ProductUpstreamError` | no | The product **is** running and answered; the OpenClaw Gateway it proxies is what failed |
| `500` | `ProductError` | no | The product's own flat-file store failed |
| Non-2xx otherwise | `ProductError` | no | The product is running and refused the request |
| `200` that is not JSON | `ProductError` | no | Something answered on that port, but it is not this product |

The product splits its own failures this way: Gateway-backed routes
(`/api/agents`, `/api/activity`) fail `502`, store-backed routes
(`/api/projects`, `/api/templates`, `/api/connections`, `/api/backlog`) fail
`500`. "The product is up but the Gateway is down" is a different state with a
different owner than "the product is down", and flattening both into
"unreachable" throws away the only signal that tells them apart.
`ProductUpstreamError` is a subclass of `ProductError`, so existing handling
still catches it.

### Why only the first row carries a link to the product

The install story is two artifacts: this plugin from the store, the product
downloaded separately. So **"plugin installed, product not running" is the normal
first state**, not an edge case, and an error that only names an unreachable
loopback port is a precise diagnostic for someone who already has the product and
a dead end for someone who does not. That row's message ends with
`https://singleintent.com` and the note that the plugin and the product are
separate downloads.

Every other row had the product *answer*, which settles the question of whether
the caller has it. Sending those callers to a download page would be confidently
wrong advice about the wrong component — a Gateway outage is not fixed by
reinstalling the product. The absence of the link on those rows is asserted in
`src/client.test.ts`, because it is the kind of thing that regresses without
anyone noticing: the message would still read as helpful.

The URL is held once, as `PRODUCT_SITE_URL` in `src/client.ts`, and a test scans
the shipped sources to keep it to one copy. It is the apex with no path: verified
2026-09-28, the root returns `200` while `/install`, `/download`, `/get-started`
and `/docs` all `404`, and `www` resolves to the same addresses but its TLS
certificate does not cover the name. A guessed path would put a dead link inside
an error message.

> **Known gap.** There is no install or download page at that domain yet — the
> root serves a placeholder. The link is honest but does not yet complete the
> journey. `PRODUCT_SITE_URL` is the single place to re-point when a real page
> exists.

## Paging

Every list verb returns `total` and an explicit `truncated`, and takes `limit`
(1–200, default 200) and `offset`. `total` always means **rows that matched before
the limit** — on a verb with a filter set, that is the post-filter count, not an
inventory of everything that exists.

The arithmetic lives once, in `src/verbs/paging.ts`, rather than being
reimplemented per verb. Five hand-written copies agree on the day they are
written and drift afterwards, and the drift surfaces as one verb reporting
`truncated` differently from another.

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
{"result":{"tools":[{"name":"list_projects", ...},{"name":"get_project", ...},{"name":"list_agents", ...},{"name":"list_templates", ...},{"name":"list_connections", ...},{"name":"get_backlog", ...},{"name":"get_activity", ...}]},"jsonrpc":"2.0","id":2}
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

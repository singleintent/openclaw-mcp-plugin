# SingleIntent OpenClaw MCP plugin

An OpenClaw plugin that ships the SingleIntent MCP server as a plugin-owned
stdio process.

**Status: the v1 read surface is complete.** Seven verbs — `list_projects`,
`get_project`, `list_agents`, `list_templates`, `list_connections`,
`get_backlog`, `get_activity`. All reads; no write verb exists yet. Everything
below is verified against OpenClaw 2026.9.5 and a running product.

**Requires OpenClaw 2026.9.8 or later** (`minHostVersion`, `compat.pluginApi`
and the peer range are all `>=2026.9.8`): the work-item write hook imports
`resolveConfigPath` from `openclaw/plugin-sdk/state-paths`, which 2026.9.5 does
not export.

## Configuration

The server resolves its own configuration. Precedence, highest first:

1. **Environment variables**
2. **A config file** — `$SINGLEINTENT_CONFIG`, which the manifest points at
   `instance.json` inside this package's own install root, else
   `$HOME/.singleintent/config.json` when nothing sets it
3. **Built-in defaults**

| Variable | Default | Purpose |
| --- | --- | --- |
| `SINGLEINTENT_HOST` | `127.0.0.1` | Product host |
| `SINGLEINTENT_PORT` | `5173` | Product port |
| `SINGLEINTENT_CONFIG` | — | Config file path override |
| `SINGLEINTENT_TOKEN` | unset | Auth token; no header is sent while unset. Never used for work-item writes |
| `SINGLEINTENT_TOKEN_FILE` | unset | Path to a token, keeping the secret out of config. Never used for work-item writes |
| `SINGLEINTENT_WORKITEM_PRINCIPALS_FILE` | unset | Test override that moves the per-agent token directory; see below |

The config file takes `host` and `port`. An absent file is normal.
Malformed JSON, a non-object file, an out-of-range port, or an unreadable or
empty token file all **fail loudly** rather than falling back to defaults and
appearing to work against the wrong host.

The config file never carries a credential. The product writes `instance.json` as
`{port}` only. A `token` key found there is the retired shared token: it is
**ignored, not sent**, and the resolved config reports `sources.token` as
`ignored: <path> "token"`. It is ignored rather than rejected so a stale file does
not break reads, which need no token. Only `SINGLEINTENT_TOKEN` or
`SINGLEINTENT_TOKEN_FILE` set the instance token, and work-item writes use neither.

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
> missing and its url is missing`. It is silent from your side, and `openclaw
> config set` accepts the entry regardless — the write landing is not the server
> resolving. If you do need it, restate `transport`, `command`, `args` and `env`
> in full.

### One instance per engine

`$SINGLEINTENT_CONFIG` is set by the manifest to
`${CLAUDE_PLUGIN_ROOT}/instance.json`. Each OpenClaw engine installs its own copy
of this package inside its own state directory, so that path differs per engine
and several products on one machine do not share a config file. A product writes
that file when it installs this connector; this package only ever reads the path
it was handed, and computes no part of it.

`${CLAUDE_PLUGIN_ROOT}` is the one placeholder that expands here.
`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are gated on a plugin-data directory that
only Agent-Plugins-format bundles receive, and that format cannot be installed
from npm — so they would be written into the environment literally.

The file lives inside the install root, so a reinstall removes it: managed npm
project directories are content-addressed and a new version gets a new directory.
That is accepted rather than overlooked — install is when the binding is made, so
the product rewrites the file as the last step of installing, and its health check
reports the gap in between. An absent file is not an error here; the config falls
through to defaults and the unreachable-product message says the binding was
missing, because a defaulted port and a correct port are the same integer.

Configuration is read **per tool call**, not at startup, so a file written after
this process started is still seen.

### Why not `plugins.entries.singleintent.config`?

Because a stdio subprocess cannot read it. The only runtime MCP hook resolves
`url`/`headers` for HTTP transports, and the child does not inherit the Gateway
environment — it receives `HOME`, `LOGNAME`, `PATH`, `SHELL`, `USER` and
`__CF_USER_TEXT_ENCODING`, plus whatever the server definition declares. Writing
the key is accepted by `openclaw config set` regardless, because the value is an
open record and no JSON Schema validator enforces a plugin's declared
`configSchema`; a write landing says nothing about delivery. The cost is real:
SecretRef support covers only `plugins.entries.<id>.config`, so it is unavailable
here. `SINGLEINTENT_TOKEN_FILE` is the mitigation, and it is weaker.

An alternative was tested and rejected: having the plugin entry, which *can* read
plugin config, resolve it at activation and write it to a file the subprocess
reads. The reason first recorded for rejecting it — that `$HOME` is the only path
both sides can derive — was wrong, and the manifest route above is the correction.
It stays rejected on a different ground: it puts a second writer on a file the
product already writes, and gives the engine a reason to care which product
instance it points at.

The distinction that makes the config file above safe where that bridge is not:
**a human-written config file has one writer and one intent.** The bridge has one
writer per profile, racing. Identical file location, completely different safety
properties.

### Work-item write credentials

`create_workitem`, `workitem_set_state` and `workitem_estimate` authenticate as
**the calling agent**,
not as the instance. The product records the agent its bearer token maps to as the
event's actor, so each agent needs its own token, and the plugin sends only that
agent's:

```
<engine state dir>/singleintent/workitem-tokens/<agentId>
```

`<engine state dir>` is the directory holding the OpenClaw profile's
`openclaw.json`, which is also where the product keeps its hashed
`workitem-principals.json`. The file holds only the token (43-character
base64url) and should be mode `0600` in a `0700` directory. It is outside this
package's install root on purpose: `openclaw plugins update` and a reinstall from
the product replace the install root, and the tokens survive both. The file is
re-read on every write, so rotating or revoking a token is replacing or deleting
the file; no restart is needed.

How the agent is known: the plugin entry registers a `before_tool_call` hook that
stamps two arguments onto those three tools, always overwriting anything the model
supplied: `actingAgentId` (the Gateway's `ctx.agentId`) and `actingEngineStateDir`
(`dirname(resolveConfigPath())`, from the public `openclaw/plugin-sdk/state-paths`
subpath). If OpenClaw names no agent for the call, the hook blocks it. The MCP
server removes both arguments before building the request; they never reach the
product and are not in any tool's input schema.

The token directory is resolved, first match wins:

1. `$SINGLEINTENT_WORKITEM_PRINCIPALS_FILE` set:
   `<dirname(path.resolve(file))>/singleintent/workitem-tokens`, the way the
   product resolves it.
2. `actingEngineStateDir` from the hook (absolute only).
3. `dirname($OPENCLAW_CONFIG_PATH)` when that is set and absolute.
4. Otherwise the write is refused locally.

No other source is consulted: not the OpenClaw state-dir environment variable,
the install path, or the working directory.

**Writes fail closed.** Wherever the hook does not stamp the agent — a runtime
that does not fire `before_tool_call` for bundle MCP tools, or a call with no
agent identity — or the directory cannot be resolved, or the agent's file is
missing, empty or unreadable, the write is refused locally and no HTTP request is
made. The tool error's `structuredContent.error` carries a plugin-owned `code`,
`agentId`, `path` and `message`, and no HTTP `status`, since nothing reached the
product:

| `code` | Cause |
| --- | --- |
| `no-acting-agent` | no `actingAgentId` was supplied (the hook did not run) |
| `unsafe-agent-id` | the agent id is not a single path segment; names the id |
| `no-engine-state-dir` | none of the three directory sources resolved; names the agent |
| `no-agent-token` | the agent's token file is missing, empty or unreadable; names the agent and the expected path |

A 401 or 403 from the product itself is passed through unchanged. There is no
fallback to `SINGLEINTENT_TOKEN`, `SINGLEINTENT_TOKEN_FILE`, or another
agent's file. Reads, and every other verb, keep the instance
token described above.

**Limitation.** The MCP server cannot tell a hook-stamped `actingAgentId` or
`actingEngineStateDir` from one the model wrote itself. Where the hook runs, it
overwrites both, so the model cannot choose them. Where the hook does not run, a
model that supplies `actingAgentId` (and optionally `actingEngineStateDir`) is
indistinguishable from the hook, and its write is sent with the token of
whichever agent it named, provided that agent's token file exists in the
resolved directory. The hook is verified on the claude-cli
runtime; elsewhere, treat work-item writes as unattributed until it is.

**Surviving update and bind.** Nothing a write needs lives in the install root.
`openclaw plugins update` replaces the root, `instance.json` included, and the
product's bind rewrites `instance.json` with the port. The agent's token is under
the engine state dir and is untouched by both, so the next write after the bind
goes out with the same token to the new port. Tests in
`src/mcp-server.workitems.test.ts` cover both.

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

Fourteen: seven that read and seven that write, plus the five
[work-item verbs](#work-item-verbs). Every one is a single call to the
product's API. This connector validates arguments, makes that call, and shapes the
response — it holds no state, keeps no cache, and performs no step the product does
not expose as an endpoint. Where something is missing from the surface, the reason
is that there is no route for it.

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

**This reads the whole collection, not one project.** The product's API exposes
no per-project route — `GET /api/projects/<uuid>` answers **404** — so this verb
requests `/api/projects` and selects the id from the result. The consequence for
a caller is a cost one, and it is the reason to say it here: `get_project` is no
cheaper than `list_projects`, and calling it once per id walks the entire
collection once per id. To detail several projects, read the list once and work
from that.

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

**Read-only, and not because a write verb was left out.** `/api/backlog` is a
GET route with no write counterpart on the product's API, so there is nothing for
this connector to call. Every verb here is an API call and nothing more; a
backlog write would have to be something else.

**A stale read is not an error.** The backlog changes without any API call being
made, so what comes back can already be out of date. Nothing here checks
freshness or retries to chase it. Treat the response as a snapshot taken when you
asked, not as a value that stays true.

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

## Write verbs

Seven, and three things are true of all of them before the individual entries.

**Nothing here can be deleted.** The product exposes no delete route, so this
connector has none. A project, an agent, a template, a role and a connection are
each created once and stay. Only `update_template` can be taken back, by calling it
again with the previous values — which means reading them first if you want to be
able to.

**Three of them spend a real agent turn.** `apply_role`, `create_connection` and
`send_message` each wake an agent and wait for it to finish before the product
records anything. They are billed, they take minutes, and they block for the whole
turn. There is no fire-and-forget variant of any of them to call instead.

**A write that times out is not a write that did not happen.** Every one of these
sets a client timeout deliberately *longer* than the product's own budget for the
call, so the product gives up first and returns a real error. A shorter client
timeout is the tempting choice and the wrong one: hanging up early does not stop
the product, so the call would be reported as failed while the write completed. If
one does time out here anyway, the error says the write may still land and to read
before retrying — retrying is how one uncertain write becomes two certain ones.

| Verb | Route | Agent turn | Undoable |
| --- | --- | --- | --- |
| `create_project` | `POST /api/projects` | no | no |
| `create_agent` | `POST /api/agents` | no | no |
| `create_template` | `POST /api/templates` | no | no |
| `update_template` | `PUT /api/templates/:id` | no | **yes** — call it again |
| `apply_role` | `POST /api/agent-roles` | **yes** | no, and never repeatable |
| `create_connection` | `POST /api/connections` | **yes**, up to 600s | no |
| `send_message` | `POST /api/chat` | **yes** | no — already delivered |

### `create_project`

Name and working directory in; the created record out, including the `id` every
`project_id` argument takes. Both fields are required here because the product
requires both, so a missing one is refused before a round trip is spent.

> **The working directory is recorded, not resolved.** The product does not create
> it, does not check that it exists, and does not make a relative path absolute. A
> typo is stored as a typo and surfaces later as agents pointed somewhere wrong.

### `create_agent`

Registers an agent and adds it to a project. Returns `agentId`, lifted out of the
response because it is what every later `agent_id` takes, alongside the product's
own create result whole.

`name`, `project_id` and `workspace_subpath` are each **permanent**. The workspace
is derived from the project's working directory at creation and never changed
afterwards, and an agent's identity is not editable. A wrong one means creating
another agent.

`workspace_subpath` is relative and must stay inside the project's directory. An
absolute path is refused here; an escaping relative path is refused by the product,
which is the only side that knows what it would escape from.

> **`template_id` and `content` are deliberately not arguments.** The product's
> `POST /api/agents` serves a second flow when those two are sent together: it
> writes a *pending* onboarding record, and finishing it needs a separate call to
> `POST /api/agents/:id/onboarding` that no verb here makes.
>
> They are left out rather than wrapped, and the reason is the rule this package is
> built on — a verb is one API call. A verb that made both calls would be this
> connector orchestrating a product flow, and it would have no honest failure
> report: when the first call succeeds and the second does not, the caller cannot
> tell that from a failure that created nothing.
>
> Leaving them out also keeps a bad state unreachable. Offering them without the
> follow-up would let a caller strand an agent at "Onboarding not started" with
> nothing in this surface able to move it on. Every agent this verb creates has no
> onboarding record at all — which is exactly the state `apply_role` needs, so
> **`apply_role` is the way to give a new agent its role**, and it works on every
> agent this verb produces.
>
> If the two-step flow is wanted through MCP, the thing to add is a verb that wraps
> the onboarding call by itself. One verb, one call.

### `create_template`

Name and content in; the created record out with the `id` `apply_role` takes.

`content` is the role text an agent is later told to adopt as its own identity. It
is used **verbatim** — nothing here or in the product rewrites or validates it — so
it should read as instructions to that agent rather than as a description of one.

`content` is returned, where `list_templates` drops it. Same discriminator, read
the other way: on a list the row still identifies a template without it, but on a
create it is the confirmation of what was stored, and it is text the caller just
sent. A length would answer a question nobody asked.

> **Whitespace-only content is refused here, and the product would accept it.** The
> product's check is a falsy one, so `"   "` creates a template that then becomes an
> agent's whole role. This is the only place this connector is deliberately stricter
> than the product, and it is stricter about a write that would otherwise succeed
> and be useless.

### `update_template`

A genuine partial update. `name` and `content` are independent and each optional:
omit one to leave it unchanged. The response carries `changed`, listing which were
sent, because nothing else in the response can tell a field left alone from a field
set to the same value.

What makes "omitted" work is that an omitted argument reaches the product
**absent** rather than as `null` — the product applies each field only when it is
not undefined, so a `null` would overwrite. That is asserted on the raw request
body in the tests, because a parsed body cannot tell the two apart and the
difference is whether the template's text survives the call.

A call with neither field is refused rather than sent: the product would accept it
and rewrite the record with no change.

> **This does not reach agents already carrying the role.** Applying a template
> copies its text onto the agent at that moment. Editing the template afterwards
> changes what the *next* application says and nothing else — and there is no
> re-apply, so an edit made to correct a live agent's behaviour will appear to
> succeed and do nothing.

### `apply_role`

Gives an agent its role from a template. The agent is asked to store the template's
text as its own identity, which is a real turn.

**Once, permanently.** The product refuses any agent that already has a role record
in *any* state — `applied`, `pending`, `running` and `failed` all block it — and
nothing here or in the product's API clears one. A second call always fails, and
the failure arrives as `ProductConflictError` saying that retrying cannot succeed.
Check the template is the right one before calling; getting it wrong means creating
another agent.

The response keeps `roleRecord` whole and reduces the turn to `runId` and `status`.
What the agent said on being handed its role is its reply, not this call's result.
`roleRecord.content` is kept, and it is the only record of the text as applied: a
later edit to the template will not change it and there is no second application.

### `create_connection`

Connects `from` to `to` so the two are aware of each other.

**Directed.** One call connects one way; the reverse is a separate call, and a
separate agent turn. An existing pair is refused as a conflict — the reverse
direction is a different connection and never conflicts.

This is the slowest verb here. The product wakes `from` and waits for it to
introduce itself, and gives that turn a **600s** budget after a real observation: an
introduction between two identity-rich agents ran to 44 messages. The client budget
here is derived from 600s rather than from the default the other two turn verbs use.

> **A connection is awareness, not a task.** The product explicitly tells the two
> agents not to start, propose or discuss any work in that exchange — wording it
> arrived at after an earlier phrasing was read as a kickoff and produced real work
> instead of an introduction. Calling this to make something happen will not.

The response keeps the `connection` row whole and reduces the turn to `runId` and
`status`; the introduction is the agents' conversation.

### `send_message`

Sends a message to an agent and returns its reply. **Blocks for that agent's whole
turn**, which can take minutes.

The projection here is the opposite of the other two turn verbs, by the same rule:
there the run's content is a third party's conversation, here it *is* the result. So
the reply text is kept and what gets dropped is the assembly detail around it —
sequence numbers, timestamps, and the identity bookkeeping that describes how the
reply was put together rather than what it says. Text blocks are joined rather than
reduced to the last one, because a reply interrupted by tool use arrives as several
and taking one would return a fragment that looks like the whole answer.

A `reply` of `null` alongside a terminal `status` is a real outcome: the turn
finished and produced no text. `status` is what tells that apart from a failure,
which is why it is returned rather than left out as redundant.

> **If this times out, the message was still delivered.** The agent has read it and
> is probably still working. Check `get_activity` using the `runId` rather than
> resending — for a message that asks an agent to *do* something, resending is not a
> duplicate record, it is the work happening twice.

### What has no write verb, and why

`get_backlog` has no counterpart. `/api/backlog` is a GET route with no write route
beside it, so there is nothing to call — and writing the backlog by any other means
would be this connector doing work the product has not exposed. If a backlog write
is wanted, it starts as a product endpoint.

There is no delete verb of any kind, and no way to edit an agent after creating it,
for the same reason: no route.

## Work-item verbs

Five, all scoped to exactly one project by a required `projectId` UUID, and all
camelCase on the wire. Reads use the instance token; the three writes go out as
the calling agent (see [Work-item write credentials](#work-item-write-credentials)).
Every write takes an optional UUIDv7 `eventId`: reuse it to retry safely, since
the server deduplicates on it (200 with `deduplicated: true`). The server assigns
actor and time; no verb takes either.

| Verb | Route | Writes |
| --- | --- | --- |
| `list_workitems` | `GET /api/workitems?project=<id>` | no |
| `get_workitem` | `GET /api/workitems/:itemId?project=<id>` | no |
| `create_workitem` | `POST /api/workitems?project=<id>` | yes |
| `workitem_set_state` | `POST /api/workitems/:itemId/state?project=<id>` | yes |
| `workitem_estimate` | `POST /api/workitems/:itemId/estimate?project=<id>` | yes |

- `create_workitem` takes `title`, `intent` and an optional `estimate` (`XS`, `S`,
  `M`, `L` or `XL`), recorded as the item's original estimate. It also takes the
  optional tracking fields `kind` (`task` or `focus`), `assignee` (agent id of a
  project member), `focus` (UUIDv7 of a focus item) and `test` (boolean). Each is
  sent only when given; the server checks assignee membership and the focus item.
- `workitem_set_state` is the only verb that changes state. Targets: `started`,
  `blocked`, `completed`, `failed`, `canceled`, plus `dispatched` and
  `acknowledged`. `reason` is required for blocked, failed and canceled, and
  `outcome` for completed. `dispatched` and `acknowledged` each append a ledger
  event and leave the item `open`; they take only an optional `reason`. The
  server refuses outcome or evidence on them (400 `invalid-body`), `acknowledged`
  without an earlier `dispatched` (409), and either on a started or terminal item
  (409). There is no separate acknowledge route.
- `workitem_estimate` re-estimates with a required `size` (`XS` to `XL`). The body
  is exactly `{eventId, size}`. Each call adds an estimate and keeps the earlier
  ones; a completed, failed or canceled item returns 409.

Sizes and transitions are the server's to check. Its status, `code` and message
come back unchanged in the tool error (for example 400 `invalid-estimate`, 409
`invalid-transition`), never remapped to a plugin message.

## Errors, and the distinction worth keeping

| Situation | Type | Site link | What it means |
| --- | --- | --- | --- |
| Nothing answered | `ProductError` — "cannot reach the product at `<url>`" plus host and port provenance | **yes** | The product is not running, is not installed, or host/port are wrong |
| `502`/`503`/`504` | `ProductUpstreamError` | no | The product **is** running and answered; the OpenClaw Gateway it proxies is what failed |
| `500` | `ProductError` | no | The product's own store failed |
| `409` | `ProductConflictError` | no | Already exists or already done. Reachable only from a write, and **retrying cannot succeed** |
| Non-2xx otherwise | `ProductError` | no | The product is running and refused the request |
| `200` that is not JSON | `ProductError` | no | Something answered on that port, but it is not this product |

The product splits its own failures this way: Gateway-backed routes
(`/api/agents`, `/api/activity`) fail `502`, store-backed routes
(`/api/projects`, `/api/templates`, `/api/connections`, `/api/backlog`) fail
`500`. "The product is up but the Gateway is down" is a different state with a
different owner than "the product is down", and flattening both into
"unreachable" throws away the only signal that tells them apart.
`ProductUpstreamError` is a subclass of `ProductError`, so existing handling
still catches it. So is `ProductConflictError`, which exists for the same kind of
reason one step further on: "this was already done" and "the product is broken" call
for opposite responses — stop, versus try again — and `apply_role` is the call a
caller is most likely to answer by retrying. `get_project` splits the same way on
the read side, with `ProjectNotFoundError` for an id that matches nothing.

**A write that times out gets an extra sentence, and only a write.** On the first
row above, a `POST` or `PUT` that hit its deadline adds that the write may still be
in progress and to check with the matching read verb before retrying. A read gets no
such warning because it cannot have changed anything, and a refused connection gets
none either: nothing was received, so there is nothing to have half-done.

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
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"singleintent","version":"0.1.3"}},"jsonrpc":"2.0","id":1}
{"result":{"tools":[{"name":"list_projects", ...},{"name":"get_project", ...},{"name":"list_agents", ...},{"name":"list_templates", ...},{"name":"list_connections", ...},{"name":"get_backlog", ...},{"name":"get_activity", ...},{"name":"create_project", ...},{"name":"create_agent", ...},{"name":"create_template", ...},{"name":"update_template", ...},{"name":"apply_role", ...},{"name":"create_connection", ...},{"name":"send_message", ...}]},"jsonrpc":"2.0","id":2}
```

Fourteen tools, reads first. The count is the quickest check that the build is
current: a `dist/` from before the write verbs lists seven.

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

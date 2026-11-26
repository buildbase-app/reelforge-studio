# Workspaces and tenancy

One RenderWeld install can host several teams, clients or customers. Each one gets a **workspace**. Its
projects, versions, renders, assets, themes, jobs, API keys, webhooks, deliveries, audit log and idempotency keys
are invisible to every other workspace (#304, decisions D-124 and D-125 in [DECISIONS.md](DECISIONS.md)).

An install that never creates a workspace has one, `default`, and works exactly as before.

## Who can do what

| Scope | Where it applies | What it allows |
| --- | --- | --- |
| `read`, `write`, `render` | the key's workspace | as before: read, edit and render that workspace's projects |
| `admin` | the key's workspace | also that workspace's keys, webhooks and audit log, its own provider accounts (`configure_workspace_provider`), and everything a write or render key can do |
| `owner` | the install | also workspaces (create, list, rename, change limits, suspend, delete, restore), runtime configuration (`get_config`, `update_config`), the licence, provider credentials, storage status and cleanup, `/readyz` details, every workspace's audit log, and owner keys |

- An owner key lives in a workspace, normally `default`. It reads and writes that workspace's data like an admin
  key; it manages the other workspaces through the workspace tools, not by reading their projects.
- Upgrading from an earlier version: admin keys that existed before gain `owner`, through migration 0015, and so
  do admin keys imported from a v0.1 data directory. The bootstrap key (`RENDERWELD_BOOTSTRAP_KEY`) is
  `admin` + `owner`.
- Admin keys made from now on are workspace admins.
- Only an owner key, or the CLI, can create, change, rotate, revoke or delete a key with the `owner` scope.

## Setting up a second team

With an owner key:

```bash
curl -X POST $URL/v1/workspaces -H "Authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"id":"acme","name":"Acme Ltd","adminKey":{"name":"acme-admin"}}'
# -> { workspace: {...}, key: "rf_...", keyRecord: {...} }   the admin key is shown once
```

Over MCP: `create_workspace { id, name, adminKey: true }`. On the server without a running API:
`renderweld keys create --workspace acme --name acme-admin --scopes admin`. The workspace must already exist.

Give the team the admin key. They create their own keys (`create_key`), webhooks and projects; any key can see
which workspace it is in with `GET /v1/workspace` (`get_workspace`).

| Action | REST | MCP |
| --- | --- | --- |
| This key's workspace, limits in force, usage | `GET /v1/workspace` (read) | `get_workspace` |
| List workspaces | `GET /v1/workspaces` (owner) | `list_workspaces` |
| Create (optional `limits`, optional first `adminKey`) | `POST /v1/workspaces` | `create_workspace` |
| Rename, change limits, suspend (`suspended: true`) or resume | `PATCH /v1/workspaces/:id` | `update_workspace` |
| Delete (soft, with a grace period) | `DELETE /v1/workspaces/:id` | `delete_workspace` |
| Restore during the grace period | `POST /v1/workspaces/:id/restore` | `restore_workspace` |
| Another workspace's audit log, or all of them | `GET /v1/audit?workspaceId=<id>\|*` (owner) | `list_audit_events { workspaceId }` |

- **Suspend:** the workspace's keys get `403 workspace_suspended` and its queued jobs wait. Nothing is deleted, and
  resuming lets the queued jobs run.
- **Delete:** the workspace's keys stop working (401) and its jobs are no longer claimed at once.
  `workspaces.deleteGraceDays` later (default 30, `purgeAfter` says when) the hourly sweep purges it: every row, by
  the database's cascading foreign keys, then its files (`workspaces/<id>/` in the bucket and under the data
  directory). The purge is audited in `default`.
- `default` cannot be suspended or deleted.
- Every workspace action is audited in the owner's workspace and in the workspace changed.

## Limits per workspace (optional)

Users are limited only by the licence: every workspace limit is unlimited unless the owner sets it. To set one,
change the instance-wide default with `update_config` or the environment, or set the workspace's own value with
`update_workspace { limits }`. The workspace's own value wins over the default.

| Limit | Default setting | Refusal |
| --- | --- | --- |
| Renders and previews per UTC day / month, across all the workspace's keys | `workspaces.rendersPerDay`, `workspaces.rendersPerMonth` | `429 workspace_quota_exceeded` with `Retry-After` |
| Requests per minute, across all the workspace's keys | `workspaces.rateLimitPerMinute` | `429 rate_limited`, `details.scope: "workspace"` |
| Bytes of assets and renders stored | `workspaces.storageBytes` | `507 storage_limit_exceeded` on upload and render start |

Per-key limits (`rateLimitPerMinute`, `rendersPerDay`, ...) still apply on top.

How exactly each limit is counted:

- Render limits are checked under a lock per workspace on each api instance. Several api instances started at the
  same moment can pass a limit by a few jobs.
- Storage usage is measured from the storage driver at most a minute earlier.

## Provider accounts per workspace (#480)

Each workspace brings its own provider accounts: its costs land on its account, its cloned voices stay on
its account, and its text goes only to the provider its contract allows. Only the default workspace uses the
accounts the owner configured (`configure_provider`), unless the owner shares them with every workspace
(`providers.shareWithWorkspaces`: one ElevenLabs key, one bill, one set of voices).

```bash
# An admin of the workspace sets its own key (stored encrypted; never returned):
curl -X PUT "$URL/v1/providers/elevenlabs/workspace-config" -H "Authorization: Bearer $WORKSPACE_ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"values": {"ELEVENLABS_API_KEY": "..."}}'
# Or the owner sets it for a workspace:
curl -X PUT "$URL/v1/providers/elevenlabs/config" -H "Authorization: Bearer $OWNER_KEY" \
  -H 'content-type: application/json' -d '{"values": {"ELEVENLABS_API_KEY": "..."}, "workspaceId": "acme"}'
```

MCP: `configure_workspace_provider { providerId, values }` (admin), or `configure_provider { providerId,
values, workspaceId }` (owner). `null` clears a value.

- **Which settings a call uses.** The workspace's own, when it set any (never mixed with the instance's).
  Otherwise the instance's, when `providers.shareWithWorkspaces` allows it: `[]` (the default) shares none,
  so a workspace without its own settings gets `409 provider_not_configured` naming
  `configure_workspace_provider`; a list of ids shares those; `["*"]` shares every provider. The default
  workspace always uses the instance's.
- **Upgrading.** Before #480 every workspace used the instance's provider accounts. If your workspaces rely on
  that, keep it with `update_config { "providers.shareWithWorkspaces": ["*"] }` (owner) or
  `REELFORGE_PROVIDERS_SHARE_WITH_WORKSPACES=*`, before or right after the upgrade; otherwise their provider
  calls get `409` until each sets its own key.
- **What a workspace sees.** `list_providers` and `get_capabilities` answer for the caller's workspace:
  `configured`, `settingsFrom` (`workspace`, `instance` or `none`) and `perWorkspace` (whether the provider
  takes a workspace's own settings). Values are never returned, and audit entries say only `set` or
  `cleared`.
- **Storage.** The values are rows of that workspace in the provider settings table, encrypted with
  `REELFORGE_SECRET_KEY`, deleted with the workspace. Every call reads them, so a change applies at once on
  every instance.
- **Which providers.** ElevenLabs, and any provider plugin with `scopedSettings: true` (it reads its key
  from `ctx.env`). An older plugin reads only the instance's settings: it takes no workspace key
  (`400 provider_not_per_workspace`), and a workspace that may not share the instance's cannot use it.
  Speech-to-text (`faster-whisper`, local, no key) and render backends stay instance-level.
- **Limits.** `limits.providerRunsPerKeyPerDay` and `limits.providerRunsPerDay` count every call, whoever's
  account it uses.

## Isolation: what it guarantees and what it does not

**Guaranteed, and tested by the denial suite (`apps/server/test/workspaces.test.ts`):**

- **REST and MCP.** Every route of the REST route table and every MCP tool, plus MCP resources and prompts, is
  called with workspace B's key against workspace A's resources. Each such probe gets 404 or 403. 404 is used for
  another workspace's resources, so a probe cannot even tell that they exist. Lists show nothing of A's, and A's
  rows and files are byte-for-byte unchanged afterwards. New routes and tools are probed automatically.
- **Workspace from the key.** The workspace comes from the authenticated key, never from a request argument. The
  service resolves it on every repository call, so a route cannot forget the filter.
- **The same ids, separately.** Two workspaces may use the same project, theme or asset ids; they are different
  rows and different files.
- **Files under a prefix.** Files of every workspace but `default` live under `workspaces/<id>/` in the storage
  driver and in the data directory.
- **Signed links.** Signed download links include their workspace in the signature: a link cannot be moved to
  another workspace or render.
- **Events and audit.** Webhook events and audit entries are written in the workspace where they happen. Workspace
  B's endpoints never receive workspace A's events.

**Shared, by design (one install):**

- **Database and bucket.** One database and one storage bucket hold every workspace. Isolation is enforced by
  RenderWeld, not by the database (no row-level security) or the bucket (no per-workspace credentials). Anyone with
  database or bucket credentials, a backup, or shell access to the server sees every workspace.
- **Instance-level settings.** Runtime configuration, the licence and storage settings are the owner's and
  apply to every workspace. Provider credentials are each workspace's own; the owner may share the instance's
  (section above).
- **Compute.** Workspaces share the render workers. Claims take turns between workspaces that have queued jobs, so
  one workspace cannot keep the others waiting by queueing many jobs. Priority and per-key fairness apply inside a
  workspace. Optional render limits cap a workspace's volume.
- **Server disk.** Engine caches (bundles, fonts) and temporary render directories under the cache directory are
  shared by every render on the machine. No API serves them; they are not a way into another workspace's data, but
  they are not separated per workspace either.

**For hard isolation, run separate installs.** For example, a customer that requires its own database, bucket,
encryption key or network boundary needs one install per customer; each install needs its own licence activation
(DEPLOY.md). Workspaces are for teams and clients who trust the operator of the install.

## For developers

- The routing repositories, the workspace context (`runInWorkspace`, `currentWorkspaceId`) and the cross-workspace
  operations are in `packages/core/src/workspace.ts`. Workspace management and limits are in
  `packages/core/src/workspace-admin.ts`. Prisma's workspace table is in `packages/db/src/workspace-repository.ts`.
- Background work (jobs, webhook deliveries, sweeps) runs inside `runInWorkspace(<its workspace>)`. A new loop
  that runs for every workspace must not depend on the workspace of the request that started it: wrap its entry in
  `runAsSystem`, as the job runner does.
- A new REST route or MCP tool is probed by the denial suite automatically. If it takes a new path parameter or a
  new required argument, give the suite a probe value (`A_IDS`, `resourceArgs`, `filler`).
- **MCP OAuth (#343, D-112):** access tokens act in `default` unless `security.oauth.workspaceClaim`
  (`RENDERWELD_MCP_OAUTH_WORKSPACE_CLAIM`) names the token claim that carries their workspace (#479). Then a
  token acts only in the workspace it names, exactly like a key made there. A token without the claim, or naming a
  workspace that does not exist or was deleted, gets `401 invalid_token`; a suspended workspace gives `403
  workspace_suspended` (test OAUTH-11). `renderweld:admin` is a workspace admin (OAUTH-09); `renderweld:owner` makes
  the token an instance owner, like an owner key, and only your authorization server decides who gets it (OAUTH-10).

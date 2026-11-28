# Automation tools: n8n, Make, Zapier

> **Status: documented, not proven.** No workflow in these tools has been run
> against the studio for this matrix. The REST calls they make are the ones
> proven by the [curl tutorial](html.md); only the tools' own node settings
> below are unverified. VERIFY with your tool version.

## Before you start

- **Reachability.** Cloud-hosted n8n, Make and Zapier call your studio from the
  internet: put it behind TLS (see [DEPLOY.md](../../DEPLOY.md)), set
  `RENDERWELD_PUBLIC_URL`, and use a dedicated key with only the scopes the
  workflow needs, a rate limit and, if the tool publishes its egress IPs, an IP
  allowlist (`renderweld keys create --name n8n --scopes read,write,render --rate-limit 30`
  and the key options in [CONNECT_AGENTS.md](../../CONNECT_AGENTS.md)).
  Self-hosted n8n on the same network can use the internal URL.
- **Auth.** Every request sends the header `Authorization: Bearer rf_...`.
  Store it as the tool's credential, not inside a node's URL or body.
- **Timeouts.** `GET /v1/jobs/:id?wait=N` holds the request up to N seconds
  (max 50). Use a value below the tool's request timeout (Zapier steps time out
  sooner than n8n and Make; use `wait=20` there).

## The workflow (any tool)

| Step | Method and URL | Body | Keep |
| --- | --- | --- | --- |
| 1. Create the project | `POST {RF}/v1/projects` | the manifest JSON (e.g. [html.json](../../../examples/tutorials/html.json) with a fresh `projectId`) | `meta.id` |
| 2. Render | `POST {RF}/v1/projects/{id}/renders` | `{}` | `job.id` |
| 3. Wait | `GET {RF}/v1/jobs/{jobId}?wait=50` | | `status`; repeat while `queued` or `running` |
| 4. Download | `GET {RF}/v1/renders/{result.renderId}/output` | | the MP4 (binary) |

Add an `Idempotency-Key` header (a UUID per run) to steps 1 and 2 so a retried
step does not create a second project or render.

## n8n

1. **Credentials → New → Header Auth**: name `Authorization`, value `Bearer rf_...`.
2. **HTTP Request** node "Create project": method POST, URL
   `https://studio.example.com/v1/projects`, Authentication *Generic Credential
   Type → Header Auth*, Send Body *JSON*, body = the manifest.
3. **HTTP Request** "Render": POST `.../v1/projects/{{ $json.meta.id }}/renders`, JSON body `{}`.
4. **HTTP Request** "Wait": GET `.../v1/jobs/{{ $json.job.id }}?wait=50`, then an
   **If** node on `{{ $json.status }}`: `succeeded` → step 5; `queued`/`running`
   → back to "Wait"; anything else → stop with an error.
5. **HTTP Request** "Download": GET `.../v1/renders/{{ $json.result.renderId }}/output`,
   Response Format *File*. Pass the binary to Drive, S3, Slack, ...

## Make

Use the **HTTP → Make a request** module four times with the same steps, a
**Repeater** + **Router** (or a **Sleep** and a filter) for the wait loop, and
*Parse response* on for the JSON steps. Put the header in the module's
*Headers* (`Authorization: Bearer rf_...`), ideally from a Make *keychain*.

## Zapier

Use **Webhooks by Zapier → Custom Request** for steps 1, 2 and 4, with the
header under *Headers*. For step 3 use `?wait=20` and **Looping by Zapier** or a
**Delay** + a second Custom Request; Zapier is the least suited to long
renders, so prefer the signed `downloadUrl` from `GET /v1/renders/{id}` (works
without a key for about an hour) to hand the file to the next step.

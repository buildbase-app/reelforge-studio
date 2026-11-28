# Publishing the public docs to BuildBase Docs

The repository is the source of truth for the technical docs. A sync job
publishes an allowlisted, public-safe subset to **BuildBase Docs**, and the
public site's `/docs` reads only from there (decision on #47; D-080..D-082).

```
docs/public/**/*.md, docs/PRIVACY.md, docs/CONFIG.md, docs/providers/*.md
        │  allowlist: docs/public/manifest.json
        ▼
scripts/docs/sync-buildbase.mjs  ──org API──►  BuildBase Docs (dev env, then production)
                                                       │  content.docs.tree() / byPath(), doc.* webhooks
                                                       ▼
                                          renderweld.com/docs (store repo)
```

## What gets published

Only the files listed in [`docs/public/manifest.json`](public/manifest.json).
Internal docs (research, decisions, status, plans) are never listed, so they are
never pushed. To publish a new page:

1. Write it under `docs/public/<folder>/<slug>.md` with front matter, or list an
   existing repo doc with its metadata in the manifest entry.
2. Add it to `docs` in the manifest.
3. Run the dry run (below) and open a PR.

| Front matter / manifest field | BuildBase doc field | Notes |
| --- | --- | --- |
| `title` | `title`, `seo.title` | Defaults to the file's leading `# ` heading, which is then removed from the body (the site shows the title) |
| `description` | `description`, `seo.description` | Required |
| `folder` | `folder` (created if missing, nested with `a/b`) | Display names come from `folders` in the manifest |
| `slug` | `slug` | Defaults to the file name. **Unique across all folders** (BuildBase answers 409 otherwise) |
| `path` | `folder` + `slug` | Alternative to both: `install/docker` |
| `tags` | `tags` (created if missing) | Lowercase slugs |
| `keywords` | `seo.keywords` | Optional |
| `order` | reading order in the folder | Stored as `suggestedDocs` = the next page (BuildBase docs have no order field); the site follows it for the sidebar and prev/next |
| `excludeSections` | (body) | `## Heading` titles to leave out of the published page |

Fields in a manifest entry override the file's front matter. The body is
published as Markdown: whole-line HTML comments are dropped, repo-relative
links to other published files become site links (`/docs/<folder>/<slug>`),
links to anything else point at the file on GitHub, and a footer names the
source file.

**Generated pages.** `docs/public/mcp/tools.md`, `docs/public/api/endpoints.md`
and `docs/public/manifest/templates.md` are written by `pnpm docs:reference`
from the tool registry, the route table and the template catalog.
`apps/server/test/docs-reference.test.ts` fails when they are out of date or a
new MCP tool has no group, so CI catches drift. `docs/CONFIG.md` is generated
by `pnpm docs:config` as before.

## Run it

```bash
export BUILDBASE_API_TOKEN_FILE=/path/to/token     # or BUILDBASE_API_TOKEN; never on the command line
export NODE_USE_ENV_PROXY=1                         # only behind an HTTPS proxy
pnpm docs:sync --env fsyqdskf --dry-run             # what would change
pnpm docs:sync --env fsyqdskf                       # publish to the development environment
pnpm docs:sync --env production                     # production (from main or a tag only)
```

| Option / variable | Meaning |
| --- | --- |
| `--env <key>` | Required. The environment the token belongs to: the 8-letter environment key, or `production`. The run stops if the token is for another environment, so a production token cannot be used by mistake (and the reverse) |
| `--dry-run` | Read only: prints what would be created, updated or archived |
| `--json` | Print the result as JSON (for CI annotations) |
| `--manifest <path>`, `--root <dir>` | Another allowlist or repository root (used by the end-to-end check) |
| `BUILDBASE_API_TOKEN` / `BUILDBASE_API_TOKEN_FILE` | Org API token, `<orgId>:<secret>` for production or `<orgId>-<env>:<secret>` for an environment. Needs create/read/update on docs, docs folders and docs tags |
| `BUILDBASE_ORG_ID` | Optional: the run stops if the token belongs to another organization |
| `BUILDBASE_SERVER_URL` | Default `https://api.console.buildbase.app` |

Exit codes: `0` done (or nothing to do), `1` error, `2` finished with
conflicts. The last line says `No changes: BuildBase Docs already match the
repository.` when a run wrote nothing.

## Rules the sync follows (D-081)

- **Matched by path** (folder path + slug). A page is created when no page has
  its path, updated (only the fields that differ) when it exists, and left
  alone when it already matches. A second run writes nothing.
- **Ownership.** Every page the sync creates carries the tag `source-repo`. It
  only ever changes pages with that tag. A page created in the console at a
  wanted path (or holding a wanted slug) is a **conflict**: reported, left
  untouched, exit code 2. Rename one side.
- **Archive, never delete.** When a file leaves the allowlist, its page is
  unpublished and tagged `source-archived`; it stays in BuildBase (drafts in the
  console) and is republished if the file comes back. BuildBase docs pages have
  no archive flag, so this pair is the archive. The sync never calls `DELETE`.
- **Moves.** A page whose `folder` changed keeps its slug and is moved
  (unpublished, moved, republished), because slugs are unique across folders.
- **Folders and tags** are created when missing and restored when archived,
  never removed. The bookkeeping tags are public, because a page read with an
  API token only shows and keeps its public tags; the site hides `source-*`
  tags.
- **Failures** stop the run with the API's message. A draft that was created
  but could not be placed is tagged `source-repo` and `source-archived`, so
  nothing is left anonymous; the next run continues.

## CI

`.github/workflows/docs-publish.yml` publishes to the production environment on
every version tag (`v*`), so the docs match the released image (#613). It can
also be run by hand ("Run workflow"), with "dry run" on by default, which lists
the planned changes and writes nothing; use that for the first publish. It runs
the docs tests first and fails before changing anything when the repository
secret `BUILDBASE_DOCS_TOKEN_PROD` is not set.

The job needs no `pnpm install`: the sync is plain Node 22 with no
dependencies. Pull requests can run `--dry-run` against the development
environment to show the planned changes. Give each token a role limited to
docs, docs folders and docs tags.

## Tests

- `pnpm test:docs` (part of `pnpm test`): unit tests of the mapping, link
  rewriting, ownership, archive/restore, moves, conflicts and idempotency against
  an in-memory fake of the API that enforces BuildBase's rules (random draft
  slug, published pages keep slug and folder, slugs unique, private tags
  dropped), plus the HTTP client with a fake `fetch`.
- `apps/server/test/docs-reference.test.ts`: generated pages are up to date.
- End to end against the development environment (2026-11-21). The first run
  created 9 folders and 20 tags and stopped at `409 Slug already exists`: doc
  slugs are unique across folders, and two pages were called `overview`. It also
  showed that a private tag is dropped from pages written with an API token.
  Hence the slug check, the public bookkeeping tags and the orphan handling
  above. The 8 drafts of that run were tagged `source-repo` by hand (the stray
  one also `source-archived`), the pages renamed (`api/rest-api`,
  `mcp/mcp-server`, `providers/all-providers`), and the next run created 12
  pages, updated 7 and archived the old `api/overview`. The read API
  (`/api/docs/path`, `/api/docs/folders/tree`, `filter[published]=true`)
  returned all 19 published. A re-run reported `19 unchanged` and `No changes`.
  A temporary copy without `docs/public/cookbook/prompts.md` (`--root`)
  archived that page (published read 404; the draft carries `source-archived`;
  nothing deleted); the next run on the real tree republished it, and the run
  after that was a no-op again.

## Known limits

- Hand-written site links (`/docs/cookbook/prompts`) are not checked: removing
  a page leaves them pointing at a 404 until the linking page is edited.
- Images in published files point at GitHub (`?raw=true`); BuildBase assets are
  not uploaded.
- One page per path: a page edited in the console is overwritten by the next
  run if it carries `source-repo`. Edit the file in the repository instead.

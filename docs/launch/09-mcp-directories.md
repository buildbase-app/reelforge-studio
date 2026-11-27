# MCP directories: Sat Dec 12 to Sun Dec 13, 2026

Free listings only (#51): a paid or "featured" placement counts as ad spend
and is deducted from profit (#20, `SITE_PLAN.md` §0). Track every submission
(date, URL, status) in the BuildBase Collection `directories`.

RenderWeld is a server people run themselves (local service), with a public
GitHub repository, a source-available licence (PolyForm Noncommercial 1.0.0
plus a paid Commercial licence), and a release image that needs a licence key
to render. Say all of that in each listing; do not tag it "open source".

## Listing text (reuse everywhere)

```text
RenderWeld: a self-hosted, source-available short-form video studio your AI agent drives over MCP (Streamable HTTP, Bearer key) or REST. The agent writes the scenes and timing; four engines (Remotion, Motion Canvas, HTML/CSS, HyperFrames) render one 1080×1920 MP4, checked with ffprobe. 61 tools. Free for personal use (PolyForm Noncommercial 1.0.0 + free Personal key); one-time Commercial licence for commercial use. Linux, Docker.
```

## Directories, with their rules as read

| Directory | How to submit | Rules as read (source, date) | Fit and plan |
| --- | --- | --- | --- |
| Official MCP Registry (registry.modelcontextprotocol.io) | `mcp-publisher` CLI with a `server.json`; GitHub login gives the `io.github.<owner>/` namespace | "The MCP Registry only hosts metadata, not artifacts"; packages may be npm, PyPI, NuGet, OCI or MCPB, or a public remote URL. OCI images on ghcr.io are allowed and need the label `io.modelcontextprotocol.server.name` matching `server.json`. No licensing or commercial rules on the page. (github.com/modelcontextprotocol/registry, `docs/modelcontextprotocol-io/quickstart.mdx` and `package-types.mdx`, read 2026-11-23) | **Blocked on a code change.** Our image (`ghcr.io/buildbase-app/reelforge-studio`) has no such label today (`Dockerfile` LABEL block). Adding it is a Dockerfile change: needs its own issue and PR, then the founder publishes with the org's GitHub login. Not a launch-week item unless done by Dec 10 |
| awesome-mcp-servers (github.com/punkpeye/awesome-mcp-servers) | Pull request adding one line to `README.md` in the right category, alphabetical | "This list is for servers with a public GitHub repository — something you install and run yourself." PRs with a backlink to the server's Glama listing are prioritised. No licence or commercial rule stated. (`CONTRIBUTING.md`, read 2026-11-23) | **Fits.** Category "Multimedia Process"; legend 📇 (TypeScript) 🏠 (local service) 🐧 (Linux only, so no 🍎 🪟). Line: `- [buildbase-app/reelforge-studio](https://github.com/buildbase-app/reelforge-studio) 📇 🏠 🐧 - Self-hosted video studio: agents write scenes, four engines render a vertical MP4. Source-available, paid licence for commercial use.` |
| Glama (glama.ai/mcp/servers) | "Add Server" button on the directory | The directory and add pages showed no submission rules or licence rules to an automated reader; there is an "Advertise" link (paid, do not use). (read 2026-11-23) | **TODO: verify.** Founder opens "Add Server" signed in, reads the terms, records them here, then submits the GitHub repo. Its listing also helps the awesome-mcp-servers PR |
| mcp.so | Submit form: repository URL (required) and name; types include "MCP Server" and "Remote Server" | Free submissions are reviewed. A paid listing is "a one-time $39 fee: it is published immediately without review", with "Featured and priority placement". No licence or commercial rule shown. (mcp.so/submit, read 2026-11-23) | **Fits, free only.** Submit the repository as "MCP Server". Do **not** take the $39 option (ad spend) |
| PulseMCP (pulsemcp.com) | Submit page | "We are not accepting new MCP server or client submissions right now"; it recommends the Official MCP Registry. (pulsemcp.com/submit, read 2026-11-23) | **Not now.** Re-check on Dec 12; otherwise reached through the official registry once listed there |
| Docker MCP Catalog (github.com/docker/mcp-registry) | Pull request; Docker builds and hosts the image, or you supply one | "Make sure that the license of your MCP Server allows people to consume it. (MIT or Apache 2 are great, GPL is not)." Every PR is reviewed by the Docker team. (`CONTRIBUTING.md`, read 2026-11-23) | **Do not submit** without asking Docker first: our licence is noncommercial-only and rendering needs a licence key, which does not match the catalogue's expectation |
| Smithery (smithery.ai) | Not established | Its publishing docs returned 404 to the agent on 2026-11-23; rules unknown | **TODO: verify** whether servers that users run themselves can be listed. Skip if it needs a hosted endpoint we run |

Not MCP-specific, already planned in `SITE_PLAN.md` §D.5 (Nov 25, free tiers
only): AlternativeTo, SaaSHub, There's An AI For That, Futurepedia, Toolify,
DevHunt, Uneed, MicroLaunch, Peerlist Launchpad, BetaList. Their rules were not
re-read for this kit.

## Links in listings

Directory pages link the GitHub repository (no UTMs). Where a directory has a
separate website field, use
`https://renderweld.com/agents?utm_source=<directory>&utm_medium=directory&utm_campaign=launch-2026-12&utm_content=1212-listing`
with `<directory>` as in [UTM.md](UTM.md) (`mcp-so`, `glama`, …).

## Facts checked

- Local service with a public repo; licence; licence key needed to render:
  [`LICENSING.md`](../../LICENSING.md), [`README.md`](../../README.md) "Licence".
- 61 tools; Streamable HTTP; four engines; 1080×1920; ffprobe: [`README.md`](../../README.md),
  [`docs/public/mcp/tools.md`](../public/mcp/tools.md).
- TypeScript codebase: [`AGENTS.md`](../../AGENTS.md) §4 and §8. Linux only tested:
  [`README.md`](../../README.md) status note.
- Image name and labels: [`Dockerfile`](../../Dockerfile) LABEL block; [`docs/DEPLOY.md`](../DEPLOY.md) (ghcr.io).
- Directory rules: the sources and dates in the table above.
- No paid placements: #51; ad spend definition: [`SITE_PLAN.md` §0](../research/SITE_PLAN.md).

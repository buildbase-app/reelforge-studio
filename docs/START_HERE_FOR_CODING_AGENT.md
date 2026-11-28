# Start Here: First Task for a Coding Agent

Use this task prompt with Codex, Claude Code, or another coding agent
after placing this docs pack in the repository.

Local setup: `pnpm dev:setup`, then `pnpm dev:all`. Every case (platforms,
proxies, offline, databases, tests, both repos) is in
[DEVELOPMENT.md](DEVELOPMENT.md).

------------------------------------------------------------------------

You are the lead engineer for RenderWeld. Read `AGENTS.md` and every file
under `docs/` and `research/` before coding.

## Task 1: Repository audit and feasibility spike

1.  Inspect the repository, package manifests, lockfiles, git status,
    and existing tests. Do not overwrite existing work.
2.  Summarize current architecture and compare it with
    `docs/ARCHITECTURE.md`.
3.  List blocking decisions, especially Remotion licensing for a paid
    source-code distribution model.
4.  Build the smallest technical spike that proves:
    -   one short vertical scene renders with Remotion;
    -   one short vertical scene renders with Motion Canvas;
    -   both outputs can be normalized and assembled into one MP4;
    -   output metadata and decodability are validated;
    -   the demo runs without an AI API key.
5.  Do not implement autonomous multi-agent generation yet.
6.  Add reproducible test commands and record real results. Never state
    tests passed unless you ran them.
7.  Write any new decision, dated, in the pull request description.
8.  Report files changed, commands run, results, unresolved risks, and
    exact next steps.

## Constraints

-   Both Remotion and Motion Canvas are required.
-   Do not assume their render outputs are interoperable without
    testing.
-   Do not bypass or obscure third-party license restrictions.
-   Do not include unlicensed music or assets.
-   Do not add secret keys or auth caches to source control.
-   Do not push commits, publish releases, or purchase licenses without
    explicit authorization.

Start with an audit and feasibility plan. If the repo is empty, propose
a minimal scaffold before making broad changes.

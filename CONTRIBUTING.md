# Contributing to ReelForge Studio

Thanks for helping. These rules apply to **everyone: maintainers, outside
contributors and AI coding agents** (ours and yours). Pull requests that do
not follow them fail the required `pr-policy` check and cannot be merged;
if they stay non-compliant for 14 days they are closed automatically.

AI agents: read [AGENTS.md](AGENTS.md) first. It repeats the rules below as
a checklist you must follow on every task.

## 1. Before you start

- **Security problem? Do not open an issue.** Report it privately (see
  [SECURITY.md](SECURITY.md)).
- **Question?** See [SUPPORT.md](SUPPORT.md).
- **Every change starts with an issue.** Search first, then open one with the
  issue forms (bug report, feature request, or task). For features, wait until
  a maintainer agrees on the approach (label `status: accepted` or a comment)
  before writing code. This saves your time.
- Be kind. We follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## 2. Branches

Never commit to `main`. `main` is protected: changes reach it only through a
reviewed, green pull request.

| Who | Branch name | Example |
| --- | --- | --- |
| People | `<type>/<issue-number>-<short-description>` | `fix/123-render-timeout` |
| AI agents | `<agent>/<short-description>` (`claude/`, `codex/`, `copilot/`, `cursor/`, `devin/`, `agent/`) | `claude/caption-presets` |
| Dependabot | `dependabot/…` (automatic) | |

`<type>` is one of `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`,
`test`, `ci`, `build`, `revert`, `security`, `hotfix` or `release`.
Lowercase letters, digits, `.`, `_` and `-` only. Branches from forks may use
any name. Merged branches are deleted automatically.

## 3. Commits

- Small, focused commits with clear messages. We **squash-merge**, so the pull
  request title becomes the commit on `main`; commit messages inside a PR are
  not checked, but write them well.
- Never commit secrets, keys, tokens, `.env` files, licence keys or personal
  data. Secret scanning with push protection blocks most of them; if one gets
  through, tell a maintainer at once so it can be rotated.
- AI agents of the maintainers add their attribution trailers
  (`Co-Authored-By: …`). Outside contributors may, but don't have to.

## 4. Pull requests

1. **Target `main`.** Open it as a **draft** until your own checks pass.
2. **Title:** a [Conventional Commit](https://www.conventionalcommits.org/):
   `<type>(optional-scope): <summary>`, for example
   `fix(render): keep the first frame non-empty`. Add `!` for a breaking
   change (`feat(api)!: …`).
3. **Description:** use the template, every section:
   - **Summary**: what and why.
   - **Linked issue**: `Closes #123` (or `Refs #123` for partial work). Required.
   - **How was this tested**: the commands you ran and what you saw.
   - **Checklist**: tick every item marked *(required)*.
   - **AI assistance**: tick exactly one option; if AI was used, name the tool
     and model and say what a person checked.
4. **One thing per pull request.** Keep it under about 500 changed lines
   (lockfiles and generated files excluded). Large PRs get a warning and take
   longer to review; split them.
5. **Tests:** a bug fix includes a test that fails without the fix. Never
   delete, skip or weaken tests to make checks pass.
6. **Checks must be green** and the branch up to date with `main`:
   `pr-policy`, `dependency-review` and the CI summary check `required` (it reports even when jobs are skipped)
7. **Review:** at least one approval from a code owner (see
   `.github/CODEOWNERS`). New pushes dismiss earlier approvals. All review
   conversations must be resolved.
8. **Merge:** squash merge only, by a maintainer (usually with auto-merge,
   which waits for every check). Nobody pushes to `main` directly.

**Maintainer-only files.** Licence, notice, trademark, governance and CI files
(`LICENSE*`, `NOTICE`, `*LICENSE*.md`, `TRADEMARK.md`, `CONTRIBUTING.md`,
`AGENTS.md`, `CLAUDE.md`, `.github/`) and licence-enforcement code are changed
by maintainers only. If you think one needs to change, open an issue.

## 5. AI-assisted contributions

You may use AI tools. **You are the author and fully accountable** for what you
submit.

1. **Understand it.** If you can't explain what your change does and how it
   fits the system without AI help, don't open the PR.
2. **Disclose it** in the PR template's *AI assistance* section: the tool and
   model, the extent, and what you checked yourself. Using AI is fine; not
   saying so is not.
3. **Write the description and review replies yourself.** Don't paste raw model
   output into issues, PRs or reviews.
4. **Same gates as everyone:** an agreed issue first, tests that fail without
   your fix, no weakened tests, the contributor agreement.
5. **No unattended agents.** Bots and agents may not open issues, PRs or
   comments here unless a maintainer approved that automation in advance.
6. **Security reports found with AI** must say so, and you must verify them
   before sending. Fabricated reports get the reporter blocked.

Maintainers' own agents follow the stricter checklist in [AGENTS.md](AGENTS.md):
draft PRs, all checks green, disclosure filled, and a human merge.

## 6. Licence of contributions

ReelForge Studio is **source-available** under two licences (see
[LICENSING.md](LICENSING.md)): the PolyForm Noncommercial License 1.0.0 for
everyone, and a paid ReelForge Commercial License. To accept your contribution we
need the right to offer it under both. **Contributor licence agreement (draft,
pending legal review):** by opening a pull request you confirm that:

1. you wrote the contribution, or have the right to submit it;
2. you grant BuildBase a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable licence to use, modify, sublicense and distribute your
   contribution under any licence, including the PolyForm Noncommercial License
   and the ReelForge Commercial License;
3. you grant a patent licence for any of your patent claims that your
   contribution necessarily infringes;
4. you keep the copyright in your contribution.

A CLA bot will ask outside contributors to sign before their first merge. The
name "ReelForge" and its logo are not licensed (see [TRADEMARK.md](TRADEMARK.md)).

## 7. Development

Read [AGENTS.md](AGENTS.md) ("Working in this repo") for the layout and
conventions, and [docs/AGENT_PLATFORM.md](docs/AGENT_PLATFORM.md) (its STATUS
table) for where things stand.

```bash
pnpm install
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test   # must pass before a PR is ready
e2e/docker/run.sh                                           # Docker end-to-end (needs Docker)
```

`pnpm dev` runs the server locally with the licence check off; that is for
noncommercial development only (see LICENSING.md).

## 8. What happens to a non-compliant PR

The `pr-policy` bot comments with a numbered list of what to fix and adds the
label `policy: needs-changes`; the check stays red, so the PR cannot be merged.
Fix the title, description or branch and it runs again. After 7 days without a
fix the PR is marked stale; after 14 days it is closed. Closed PRs can be
reopened at any time. Maintainers may also close PRs that don't meet the AI
policy, with an explanation; you can always reply.

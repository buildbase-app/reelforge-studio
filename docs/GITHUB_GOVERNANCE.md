# GitHub governance

How `buildbase-app/reelforge-studio` is protected, and how to apply the settings. The same rules apply
to `buildbase-app/reelforge-studio` and `buildbase-app/reelforge-selling-public-site`.
Contributor-facing rules: [CONTRIBUTING.md](../CONTRIBUTING.md). Agent rules:
[AGENTS.md](../AGENTS.md).

## What is enforced, and where

| Rule | Enforced by |
| --- | --- |
| No direct pushes, force-pushes or deletion of `main`; linear history | Ruleset "main protection" |
| Changes reach `main` only by pull request, squash merge only | Ruleset + repository merge settings |
| 1 approving review from a code owner; new pushes dismiss approvals; approval needed after the last push; all conversations resolved | Ruleset `pull_request` rule + `.github/CODEOWNERS` |
| Required checks green and branch up to date: `pr-policy`, `dependency-review` and the CI summary check `required` (it reports even when jobs are skipped) | Ruleset `required_status_checks` (strict) |
| Branch names, Conventional Commit title, target `main`, linked issue, template checklist, AI disclosure, maintainer-only files | `pr-policy` workflow (`.github/scripts/pr-policy.cjs`, unit-tested) |
| Non-compliant PRs closed after 14 days | `close-noncompliant-prs` workflow |
| New dependencies: no high-severity vulnerabilities, no GPL/AGPL/SSPL | `dependency-review` workflow |
| Secrets blocked at push; Dependabot alerts and fixes; CodeQL; private vulnerability reports | Repository security settings |
| Outside contributors' workflows need approval before they run; workflow token read-only by default | Actions settings |
| Release tags `v*` cannot be deleted or moved; only admins create them | Ruleset "release tags" |
| Dependency updates grouped weekly | `.github/dependabot.yml` |

## Applying the settings (repository admin, once per repository)

My (the agents') GitHub access cannot change repository settings. A repository
admin runs, with the GitHub CLI signed in (`gh auth login`):

```bash
scripts/github/apply-repo-settings.sh buildbase-app/reelforge-studio "pr-policy" "dependency-review" "required"
```

It is idempotent: run it again after changing it. Then check
`https://github.com/buildbase-app/reelforge-studio/settings/rules`. Also enable **Discussions** if you
want questions out of issues.

## Solo maintainer and AI agents

GitHub never counts an approval from a pull request's author, and our AI agents
open pull requests under the maintainer's account. So the ruleset lets the
**Admin role bypass in "pull request" mode**: an admin can merge a PR without the
approval, but can never push to `main` directly, and every bypass is logged
(Settings → Rules → Insights). Use **auto-merge** for agent PRs: it waits for
every required check, so the bypass only skips the approval, not CI.

Target state (do when practical):
1. Agents open PRs as a **GitHub App** identity, not the maintainer. The
   maintainer's approval then counts as a real review, and commits made through
   the App are signed, so **signed commits** can be required.
2. When a second maintainer joins: remove the bypass and require **2 approvals**
   for outside PRs.
3. Add a **merge queue** when PR volume grows (add `merge_group` to CI triggers).
4. A CLA bot (CLA Assistant Lite) once outside contributions start.

Never create a second personal account to approve your own PRs: it is
self-approval in disguise and against GitHub's terms.

## Changing the rules

Rules live in this repository: `CONTRIBUTING.md`, `AGENTS.md`, `.github/` and
`scripts/github/apply-repo-settings.sh`. Change them by pull request like any
other change, then re-run the script.

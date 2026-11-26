# Contribution governance research: humans and AI coding agents

> ReelForge is now RenderWeld (#408). This record keeps the names it was written with; [RENAMED.md](../RENAMED.md) maps each old name to the new one.

Researched 2026-11-21 for `buildbase-app/reelforge-studio` (PolyForm Noncommercial 1.0.0 plus a paid
commercial licence) and `buildbase-app/reelforge-selling-public-site` (Next.js store, currently MIT).

**Method.** I made shallow, tree-only `git clone`s of 17 public repositories and read their governance
files at `HEAD` (November 2026) with `git show`. I also read recent PR pages and filtered PR lists on
github.com to see which bots, labels and merge paths are live. Anything that a file or PR page showed is
stated as fact. Anything inferred is marked *(inferred)*. Settings that only admins can see (branch
protection, CodeQL default setup, Actions approval) cannot be read from outside, so a blank cell in those
columns means "not visible", not "off".

**Repositories studied (17):**
- **Big projects:** vercel/next.js, facebook/react, microsoft/vscode, kubernetes/kubernetes, nodejs/node,
  python/cpython, llvm/llvm-project.
- **Open-core / source-available:** calcom/cal.com, formbricks/formbricks, dubinc/dub, supabase/supabase,
  n8n-io/n8n, remotion-dev/remotion, PostHog/posthog.
- **Explicit AI policies:** ghostty-org/ghostty, curl/curl, servo/servo (with servo/book).

> **Note on cal.com.** `calcom/cal.com` now contains **Cal.diy**, "a community-driven, open-source fork
> of Cal.com ... Cal.com is now closed-source" (CONTRIBUTING.md), under MIT. Its PR tooling is still a
> useful reference, but it is no longer an open-core example.

---

## 1. Comparison table

Key: **Y** yes · **N** no · **–** not visible from outside · *(inf)* inferred.

| Repo | CLA / DCO | PR title rule | Linked issue | Approvals | CODEOWNERS | Merge method | Merge queue | Signed commits | AI policy | Issue forms | Blank issues |
|---|---|---|---|---|---|---|---|---|---|---|---|
| vercel/next.js | – (none visible) | none enforced | bugs: `fixes #`; features need an accepted Discussion | ≥1 maintainer ("Every pull request has to be reviewed by a maintainer"); the Vercel Agent bot also posts approvals | Y | squash *(inf)* | N | **Required** (verified signatures on protected branches) | AI allowed; external PR descriptions **must be written by a human** | Y (YAML) | **off** |
| facebook/react | **CLA** (meta-cla bot, `CLA Signed` label) | none | no | 1 seen | N | squash ("title (#NNN)") | N | – | none public (CLAUDE.md is for agents) | mixed (YAML + MD) | **off** |
| microsoft/vscode | CLA (Microsoft CLA bot) *(inf)* | none | "Associate an issue" (template) | – | Y (+ CODENOTIFY) | **SQUASH via merge queue** (`.github/rulesets/main-merge-queue.json`) | **Y** | – | none for contributors; copilot-instructions + AGENTS.md | MD | **off** |
| kubernetes/kubernetes | **CLA** (CNCF EasyCLA, `cncf-cla: yes`) | none (kind labels) | "Fixes #" or "N/A" | Prow `/lgtm` (reviewer) + `/approve` (OWNERS approver) | OWNERS files (Prow) | Tide bot; squash on request (`tide/merge-method-squash`) | Tide pool | – | **disclose YES/NO in PR template**; AI co-author / `Assisted-by` trailers **banned** | Y (YAML) | on (default) |
| nodejs/node | **DCO** (sign-off) | commit subject `subsystem: msg` (commit-lint) | no | **2 approvals, or 1 after 7 days**; 48 h wait; never the author | Y | `commit-queue` label (squash or rebase by bot) | own commit-queue bot | – | disclose; **no automated PRs without prior approval**; no AI on "good first issue" | Y (YAML) | on |
| python/cpython | **CLA** (python-cla-bot) | `gh-NNNNN: Summary` | **Y** (except trivial) | core-dev approval | Y | squash | N | – | disclosure appreciated; `AI-needs-explanation` / `AI-guidelines-not-met` labels, closed by bot | Y (YAML) | on |
| llvm/llvm-project | N (Apache-2.0 with LLVM exception) | none | no | 1 reviewer approval (DeveloperPolicy) | Y | squash (linear history) | N | – | human in the loop; `Assisted-by:` trailer; **autonomous agents banned**; `extractive` label | N (auto-labeler) | – |
| curl/curl | N (implicit inbound licence) | commit `area: summary` | no | 1 (`Approved-by:` trailer) | Y | maintainer lands it, linear *(inf)* | N | – | allowed; "if someone can spot that the contribution was made with the help of AI, you have more work to do"; fake reports → ban | Y (YAML) | **off** |
| ghostty-org/ghostty | N (MIT) | none | **PR must implement an accepted issue** | subsystem maintainers (CODEOWNERS) | Y (synced from vouch list) | – | N | – | **mandatory disclosure**; vouch system; public denouncement | Discussions (YAML templates); issues maintainers-only | issues closed by bot |
| servo/servo | **DCO** (sign-off required) | style guide | – | 1 core reviewer | Y | merge queue | **Y** (dummy DCO job for `merge_group`) | – | **LLM content banned** (except minimised test cases) | MD | – |
| calcom/cal.com (Cal.diy) | N | **Conventional Commits** (amannn/action-semantic-pull-request) | `Fixes #XXXX` in template | – | file present, empty | – | 1 workflow uses `merge_group` | – | none (agent rules in AGENTS.md: draft PRs, <500 lines) | MD | **off** |
| formbricks/formbricks | N | **Conventional Commits** | `Fixes ENG-` | – | N | – | Y (8 workflows use `merge_group`) | – | AI code rules in AGENTS.md; PR body written with a `pr` skill | Y (YAML) | on |
| dubinc/dub | N | none | no | – | N | – | N | – | none | none | – |
| supabase/supabase | N | none | "Link any relevant issues" | – | Y | – | 1 workflow | – | none (agents use repo skills for docs) | org-level | **off** (org) |
| n8n-io/n8n | **CLA** (in-house; required status `CLA Check`, also on `merge_group`) | **Angular / Conventional** `type(scope): Summary` (`ci-check-pr-title.yml`) | **bug fixes require an issue**; features require a forum topic | 1 + OWNERS-based required reviews | owners workflows | merge queue (auto-merge) | **Y** | – | allowed; must understand every line; own words; disclosure encouraged | Y (YAML) | **off** |
| remotion-dev/remotion | N (implicit commercial grant in contributing doc) | none | "link issues" (template) | – | N | – | N | – | none; runs claude-code-action | MD | – |
| PostHog/posthog | – | – | `Closes #` | – | Y (`ee/` paths → teams) | – | Y (5 workflows) | – | **"🤖 Agent context" PR section** (autonomy, tool+model, what the human driver checked) | Y (YAML) + MD | – |

Automation I saw on PR pages:

| Repo | Bots and checks seen live |
|---|---|
| next.js | `vercel[bot]` "Vercel Agent" review that approves ("Everything checks out under the repository's review policy"); github-actions "Tests Passed"; auto-labels from issue templates; 60 checks. |
| react | `meta-cla` (label), sizebot comment; 250 checks; 1 approval. |
| kubernetes | `k8s-ci-robot` labels: `cncf-cla: yes`, `lgtm`, `approved`, `size/S`, `release-note-none`, `triage/accepted`. |
| node | `commit-queue`, `author ready`, `needs-ci` labels; AgentScan heuristic on first-time PRs (caution comment, never auto-close). |
| cpython | `python-cla-bot` ("CLA not signed" for `cursoragent@cursor.com`); `bedevere-app` closes PRs when a human adds `AI-guidelines-not-met` (17 closed so far). |
| n8n | `n8n-assistant` (CLA label, welcome, triage labels); `cubic-dev-ai` AI review ("auto-approval was skipped because the PR is from an external contributor"); codecov; merge queue with auto-merge; 209 checks. |
| ghostty | `ghostty-vouch` app: "This project requires that pull request authors are vouched, and you are not in the list of vouched users. This PR will be closed automatically." |

---

## 2. Baseline: what most repos share

1. **CONTRIBUTING + CODE_OF_CONDUCT + SECURITY.md** at the root or in `.github/`. SECURITY.md points to a
   private channel (email or GitHub private vulnerability reporting), never to public issues. Even
   founder-led dub has SECURITY.md.
2. **Issue intake goes through forms, and blank issues are off.** 8 of 13 repos with templates use YAML
   issue forms. 8 set `blank_issues_enabled: false`. `config.yml` `contact_links` send questions to
   Discussions or a forum, feature ideas to Discussions or a forum (next.js, n8n, cpython, curl), and
   security to a private channel (n8n, kubernetes). Required fields are nearly always a reproduction, an
   expected-versus-actual description and an environment/version.
3. **A PR template with Summary/why + How tested + linked issue.** Common rules: "If you leave this empty,
   your PR will very likely be closed" (react); "PRs without clear problem statements will be closed"
   (supabase).
4. **Discuss before coding for features.** next.js, n8n, ghostty, cal.com and cpython require an accepted
   issue or discussion before a feature PR. Bugs need an issue with reproduction steps (n8n: "Bug-fix PRs
   with no linked issue will be returned").
5. **Small PRs.** cal.com caps PRs at 500 lines or 10 files. n8n enforces a **1000-line limit as a CI
   check**, which a maintainer can override with `/size-limit-override`.
6. **CODEOWNERS (or Prow OWNERS)** in 11 of 17 repos, used both to route reviews and to protect sensitive
   paths.
7. **A legal gate.** A CLA where the company needs relicensing rights (react, vscode, kubernetes,
   cpython, n8n). A DCO where inbound equals outbound (node, servo). An implicit grant written into
   CONTRIBUTING (curl, remotion).
8. **Squash merge as the norm**, with the PR title becoming the commit subject, plus a title convention
   enforced by CI. Conventional Commits via `amannn/action-semantic-pull-request` (cal.com, formbricks,
   n8n) or a project format (`gh-NNNNN:`, `subsystem:`, `area:`).
9. **Merge queues are spreading** (vscode, n8n, servo, formbricks, PostHog). Every workflow and gate,
   including the CLA, must then also trigger on `merge_group` (n8n's CLA check and servo's dummy DCO job
   both exist for this reason).
10. **Supply-chain hygiene.** Dependabot or Renovate (14 of 17). CodeQL (some as visible workflows, others
    most likely through invisible default setup). OpenSSF Scorecard (curl, node, llvm). zizmor workflow
    linting (cpython, llvm, supabase). Actions pinned to full SHAs (next.js `.github/AGENTS.md`,
    formbricks, ghostty `pinact`). `permissions: {}` at workflow level. No PR-head checkout in
    `pull_request_target`.
11. **Welcome and stale bots.** First-time PR welcome comments (cal.com, supabase, node, llvm). Stale
    closers limited to PRs **waiting on the author** (n8n: 30 days stale, then 14 days to close, only on
    `triage:needs-info`; react: 90 + 7 days).
12. **AGENTS.md / CLAUDE.md / copilot-instructions** in 12 of 17 repos. They are now standard, and they
    carry the contribution rules for agents too (kubernetes: "disclose whether AI was used ... Do not add
    `Co-authored-by:`"; cal.com: "Create PRs in draft mode by default ... Never create large PRs (>500
    lines or >10 files)").

---

## 3. What open-core and source-available repos add

| Pattern | Who | Detail |
|---|---|---|
| **Path-scoped commercial code** | PostHog `ee/`, formbricks `apps/web/modules/ee`, dub `apps/web/app/(ee)`, n8n `*.ee.*` files and `.ee` directories | The root LICENSE says "Portions of this software are licensed as follows: All content that resides under the `ee/` directory ... is licensed under `ee/LICENSE`". n8n adds: "Content of branches other than the main branch (i.e. "master") are not licensed." |
| **CLA to keep relicensing rights** | n8n (one-paragraph Indie Open Source CLA: "I give n8n permission to license my contributions on any terms they like"), react/Meta, kubernetes/CNCF, cpython/PSF | n8n replaced the hosted CLA bot with an **in-house action that sets a required commit status `CLA Check`**, re-checks on `/cla-check` comments and on `merge_group`, and adds a `cla-signed` label that triage tooling reads. |
| **Implicit commercial grant (no bot)** | remotion: "since we charge for Remotion when companies are using it, this is a **commercial project**. By sending pull requests, you agree that we can use your code changes in a commercial context." curl: "By submitting a change to us, you agree that the changes can and should be adopted by curl" | The lightest option, but weaker evidence than a recorded CLA signature. |
| **Maintainer-only zones** | n8n: "The n8n team handles changes to identity and access management and to the credentials system ... we keep these in-house"; "Contact n8n before starting any change under /packages/core"; new-node PRs "will be **auto-closed**" | Directly applicable to licence-key validation code. |
| **CODEOWNERS on commercial and security paths** | PostHog `ee/api/authentication.py @PostHog/team-security`; kubernetes `required_reviewers` for `go.mod` | |
| **Agent review rules for licence gating** | n8n `.agents/review-rules/backend/license-enforcement.md`: "Nothing fails the build when a paid feature ships ungated, so this is review-only", followed by a checklist (`@Licensed` decorator, quota checks, "Enterprise code reachable outside `*.ee.ts` files") | An AI reviewer prompt dedicated to licence leaks. |
| **Licence headers checked by CI** | curl (REUSE compliance job, `SPDX-License-Identifier` in every file), kubernetes ("Every `.go` file needs the license header from `hack/boilerplate`") | |
| **Pausing or limiting community PRs** | formbricks: "we've decided to only facilitate community code contributions in rare exceptions"; remotion: "We can't review or merge every pull request" | An honest option for a solo founder. |
| **Gated preview deploys for external PRs** | supabase `authorize-vercel-deploys.yml`; their bot also tells contributors not to click "Update branch" after review | Relevant to the store, which deploys. |
| **Founder-driven flow with no ceremony** | dub: no CONTRIBUTING, no templates, no CLA; the founder opens and closes most PRs | What the repo looks like today, and the risk to avoid. |

---

## 4. AI-contribution policy: the best wording patterns

There are five recurring stances, from strict to permissive:

1. **Ban:** servo. "These contributions must not include content generated by large language models,
   with the exception of **minimized** test cases."
   ([servo book: AI usage](https://book.servo.org/policy/ai-usage.html))
2. **Allowed, with mandatory disclosure, a trust gate and a public blocklist:** ghostty.
3. **Allowed, human in the loop, disclosure expected, autonomous agents banned:** llvm, node, kubernetes.
4. **Allowed, own your code, own your words, disclosure encouraged:** n8n, cpython, curl, next.js.
5. **Agent-native: structured agent metadata in the PR:** PostHog.

### Excerpts worth reusing

**Accountability (core sentence):**
- LLVM: "Contributors must read and review all LLM-generated code or text before they ask other project
  members to review it. The contributor is always the author and is fully accountable for their
  contributions." ([AIToolPolicy](https://github.com/llvm/llvm-project/blob/main/llvm/docs/AIToolPolicy.md))
- Ghostty: "**The human-in-the-loop must fully understand all code.** If you can't explain what your
  changes do and how they interact with the greater system without the aid of AI tools, do not
  contribute to this project." ([AI_POLICY.md](https://github.com/ghostty-org/ghostty/blob/main/AI_POLICY.md))
- Node: "Disclosure about the use of AI does not serve as a disclaimer of this responsibility."
  ([ai-guidelines.md](https://github.com/nodejs/node/blob/main/doc/contributing/ai-guidelines.md))

**Why the policy exists, framed against the cost of review, not against AI:**
- LLVM: "Our **golden rule** is that a contribution should be worth more to the project than the time it
  takes to review it." n8n copied the same sentence word for word.
- Ghostty: "It's the people, not the tools, that are the problem."
- n8n: "We use AI tools ourselves and we welcome AI-assisted contributions. The problem is not the tool.
  The problem is code the author cannot stand behind."

**Disclosure mechanics:**
- Ghostty (strict): "**All AI usage in any form must be disclosed.** You must state the tool you used
  (e.g. Claude Code, Cursor, Amp) along with the extent that the work was AI-assisted."
- Kubernetes PR template: `#### AI usage disclosure:` "Mention "YES" or "NO". If yes, briefly describe how
  AI was used. If you are an AI agent: remind the author that they are responsible for all submitted
  changes".
- LLVM: "use a commit message trailer like Assisted-by: <name of code assistant>".
  **Contrast:** Kubernetes: "Listing AI tooling as a co-author, co-signing commits using an AI tool, or
  using the `assisted-by` ... trailer is not allowed"
  ([k8s PR guide](https://github.com/kubernetes/community/blob/master/contributors/guide/pull-requests.md#ai-guidance)).
  Node recommends keeping for-profit brand names out of commit messages and naming them in the PR
  description instead.
- PostHog PR template, `## 🤖 Agent context`: **Autonomy:** "Human-driven (agent-assisted)" or "Fully
  autonomous". **Agent:** tool and exact model. **Skills.** **Driver checked:** "Approving a plan,
  answering a question, or saying "looks good" to a summary is not a check of the code ... Write "Not yet
  checked by the driver" when the person has stated nothing." Also: "Agents: do NOT claim manual testing
  you haven't done." ([template](https://github.com/PostHog/posthog/blob/master/.github/pull_request_template.md))

**Prose must be human:**
- next.js PR template: "We encourage you to use AI ... However, you must review and deeply understand the
  contributions you are making. For this reason, **pull request descriptions from external contributors
  must be written by a human**."
- curl PR template: "If you cannot understand or explain your work without using Artificial Intelligence
  (AI) then do not file here. Do not paste massive AI generated explanations."
- Node: "**Do not paste messages generated entirely by AI** in pull requests, issues, or the project's
  communication channels."

**Agents and bots acting on their own:**
- LLVM: "it bans agents that take action in our digital spaces without human approval, such as the
  GitHub `@claude` agent. Similarly, automated review tools that publish comments without human review
  are not allowed."
- Node: "Pull requests must not be opened by automated tooling, unless specifically approved in advance
  by the project." It also says "responses to feedback ... must not be automated by AI tools."

**Protecting learning opportunities:**
- LLVM and Node: "**Using AI tools to fix issues labelled as "good first issues" is forbidden**."

**Tests:**
- Node: "Existing tests should not be removed or modified without human verification."
- CPython: "It is not acceptable to alter or bypass existing tests, or remove desired functionality, in
  order to make a failing test pass."
- n8n: "For a **bug fix**, include at least one regression test that **fails against the latest
  `master`** without your change and passes with it."

**Enforcement wording:**
- LLVM canned reply: "This PR doesn't appear to comply with our policy on tool-generated content, and
  requires additional justification for why it is valuable enough to the project for us to review it."
- CPython bot (bedevere) on `AI-guidelines-not-met`: "Contributors are responsible for reviewing and
  understanding what they submit, checking its claims, and being able to explain changes in their own
  words ... We believe this contribution does not meet our guidelines for using AI tools, so we're closing
  it. If you think we've misunderstood your contribution, please let us know."
  ([devguide](https://devguide.python.org/getting-started/ai-tools/)). CPython uses two tiers:
  `AI-needs-explanation` keeps the PR open, and `AI-guidelines-not-met` closes it.
- Node AgentScan caution: "This is a heuristic, not proof that this pull request was opened by an agent
  or violates policy."
- Ghostty vouch bot: "This project requires that pull request authors are vouched ... This PR will be
  closed automatically." Its denouncement list is public: "other projects who trust our maintainer
  judgement can also block you automatically."

**Maintainer exemption.** Ghostty says outright: "These rules apply only to outside contributions ...
Maintainers are exempt ... they've proven themselves trustworthy." This is the honest way to run a
founder-plus-agents repo: hold your own agents to a **stricter, automated** standard (tests, structured
disclosure) rather than the outside-contributor social standard.

**Canary detection.** Next.js keeps a hidden HTML comment in a contributor doc that asks LLM-written PR
descriptions to include a marker, so maintainers can spot them. I note this as a pattern only. I did not
follow it, and I do not recommend copying it. Visible, explicit disclosure works better and does not
depend on agents obeying hidden text.

---

## 5. Recommended configuration for buildbase-app

Design goals:
- (a) Every change reaches `main` through a PR with green checks, including the founder's.
- (b) Outside contributors grant the rights that dual licensing needs.
- (c) Agent PRs are labelled and carry structured accountability.
- (d) No fake "review theatre".
- (e) Low effort for one person.

Replace `@FOUNDER` with the founder's GitHub handle throughout.

### 5.1 Branch naming

| Who | Pattern | Example |
|---|---|---|
| Humans | `<type>/<issue#>-<slug>`, type ∈ feat, fix, docs, chore, refactor, test, ci, perf | `fix/123-render-timeout` |
| AI agents | `<agent>/<slug>` (Claude Code already creates `claude/<slug>`) or `agent/<tool>/<slug>` | `claude/eloquent-wright-tm3cs7` |
| Dependabot | `dependabot/**` (default) | |
| Releases | tags `vX.Y.Z` only; no long-lived release branches until there is a supported older line | `v0.3.0` |

Enforce the pattern with a small CI job (below) rather than a ruleset rule: branch-name and
commit-metadata ruleset rules may need an Enterprise plan. Fork PRs are exempt, because fork branch
names are the contributor's business. The `claude/` and `agent/` prefixes make agent work filterable
(`head:claude/`).

### 5.2 PR rules (both repos)

- **Squash merge only.** Default squash message: PR title + description. Turn on "Always suggest updating
  PR branches", "Allow auto-merge" and "Automatically delete head branches". Turn off merge commits and
  rebase merging.
- **PR title = Conventional Commits** (`feat(scope): summary`), enforced by
  `amannn/action-semantic-pull-request`, as cal.com, formbricks and n8n do. It becomes the squashed
  commit subject and feeds changelog and release automation.
- **Linked issue required** for outside contributors' code PRs (`Fixes #N` / `Closes #N` / `Refs #N`).
  Features need an issue labelled `accepted`. The founder's and agents' PRs may skip this, but must fill
  in "Why".
- **Size:** soft limit 500 changed lines or 15 files, excluding lockfiles, generated Prisma clients and
  migrations SQL. Over the limit, a label plus a comment, overridable by the founder (n8n pattern).
- **Tests:** a bug fix needs a regression test that fails without the fix (n8n wording). No deleting or
  weakening tests to go green (Node/CPython wording).
- **Draft first for agents:** agents open PRs as **draft**, and mark them ready only after the local
  checks in AGENTS.md pass.
- **AI disclosure is mandatory for everyone.** The template's Agent context block is required. A CI check
  fails if it is missing or unfilled on non-Dependabot PRs.

`.github/pull_request_template.md` (studio; the store version drops the licence line):

```markdown
<!-- Title: Conventional Commits, e.g. "fix(render): retry ffprobe on EAGAIN". It becomes the squashed commit. -->

Fixes #
<!-- Fixes/Closes closes the issue on merge; Refs for partial work. Outside contributors: required. -->

## Why
<!-- The problem, in your own words. Who is affected and what is wrong today. -->

## What changed
<!-- User-visible changes first; mark the rest "mechanical". -->

## How it was tested
<!-- Commands you actually ran and their result. Agents: list only what you ran; never claim manual testing you did not do. -->
- [ ] `pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test` passes locally
- [ ] Bug fix: includes a test that fails without the fix

## AI / agent disclosure (required)
**Autonomy:** Human-written / Human-driven (agent-assisted) / Agent-authored, human-reviewed
**Agent:** <tool, model> or "None"
**Human checked:** <what a person read, ran or decided; or "Not yet checked by a human">

## Checklist
- [ ] I can explain every line of this change without AI help.
- [ ] I have read CONTRIBUTING.md and the AI policy, and (outside contributors) signed the CLA when the bot asks.
- [ ] This PR does not touch licence-enforcement code, or a maintainer asked for it in the linked issue.
```

### 5.3 Issue forms

`.github/ISSUE_TEMPLATE/config.yml`:

```yaml
blank_issues_enabled: false
contact_links:
  - name: Security vulnerability
    url: https://github.com/buildbase-app/reelforge-studio/security/advisories/new
    about: Report privately. Do not open a public issue.
  - name: Question or help
    url: https://github.com/buildbase-app/reelforge-studio/discussions/new?category=q-a
    about: Usage questions and self-hosting help.
  - name: Feature idea
    url: https://github.com/buildbase-app/reelforge-studio/discussions/new?category=ideas
    about: Discuss first; accepted ideas become issues.
  - name: Commercial licence or billing
    url: https://reelforge.buildbase.app/pricing
    about: Licence keys, invoices and commercial terms.
```

Forms (YAML, `type: Bug` / `type: Feature` if organisation issue types are enabled):

- `1-bug.yml`, required fields:
  - ReelForge version or image tag
  - install method (dropdown: Docker image / source / other)
  - database (SQLite / PostgreSQL / MySQL)
  - steps to reproduce
  - expected versus actual behaviour
  - logs (`render: shell`)
  - a checkbox "I searched existing issues"
  - a checkbox "This is not a security vulnerability"
  - optional: "AI tools used to write this report? (tool, extent)" plus the checkbox "I verified every
    claim in this report myself" (the curl/servo rule for AI-found bugs)
- `2-feature.yml`: problem (required), proposed solution, alternatives, "Would you implement it?"
  (dropdown). Auto-label `needs-triage`. Feature PRs wait for the `accepted` label (cal.com pattern).
- `3-docs.yml`: page URL and what is wrong.
- Store repo: the same `config.yml` with store URLs, plus a `bug.yml` that asks for page URL, browser,
  locale and theme (its current checklist mentions 8 locales and light/dark).

Turn on Discussions (categories Q&A, Ideas, Show and tell) so `config.yml` has somewhere to send people.

### 5.4 Required checks

Required checks must **always report**. Studio's `ci.yml` uses `paths-ignore` for docs, so a
docs-only PR would wait forever on a required `test`. Use a single **aggregator job** as the one required
CI check (cal.com has `all-checks.yml` for this):

```yaml
# Added to ci.yml. Remove paths-ignore from the pull_request trigger (keep it for push),
# and add a cheap "changes" job that the heavy jobs use to skip themselves on docs-only diffs.
  required:
    if: always()
    needs: [test, database, image]
    runs-on: ubuntu-24.04
    permissions: {}
    steps:
      - name: All required jobs passed or were skipped
        run: |
          echo '${{ toJSON(needs) }}' | jq -e 'all(.[]; .result == "success" or .result == "skipped")'
```

(`re-actors/alls-green`, SHA-pinned, does the same thing.) Add `merge_group:` to the triggers if you
adopt a merge queue. The required set is:

| Check | Studio | Store | Source |
|---|---|---|---|
| CI aggregate (`required`, or `test` + `database` + `image` with no paths-ignore on PRs) | Y | `analyze` | `ci.yml` |
| `PR title` (semantic) | Y | Y | amannn/action-semantic-pull-request |
| `PR policy` (linked issue for outsiders, disclosure block present, branch name) | Y | Y | github-script, below |
| `CLA` | Y | (DCO instead, or none) | contributor-assistant/github-action |
| `config-docs` | Y | – | existing |
| CodeQL (via a ruleset `code_scanning` rule: block on high or higher, and on errors) | Y | Y | default setup |
| Dependency review (`actions/dependency-review-action`, fail on high, deny licences incompatible with your licensing) | Y | Y | |
| Licence header (`SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0` in new source files) | Y | – | small script or `reuse lint` |

### 5.5 Approvals for a solo founder whose agents author PRs under the founder's account

GitHub never counts an approval from the PR author. With "Require approval of the most recent reviewable
push" on, it also ignores approval from the last pusher. So a required approval can never be met for PRs
opened under the founder's own account. The options, in what large repos actually do:

| Option | Used by | Verdict |
|---|---|---|
| **A. Ruleset bypass in "pull request only" mode for the Admin role.** Required approvals = 1 for everyone; the admin can merge a PR without approval (GitHub shows "Merge without waiting for requirements to be met (bypass rules)"), but **cannot push directly**. Every bypass is logged in Rules → Insights. | microsoft/vscode `main-merge-queue.json`: `"bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"pull_request"}]` | **Recommended now.** Outside PRs need the founder's approval; founder and agent PRs still need green checks, and the bypass is audited. Downside: the bypass also skips required checks unless you are disciplined, so use auto-merge (it waits for checks) instead of clicking bypass. |
| **B. Agents open PRs under a separate bot identity** (a GitHub App such as the Claude GitHub App, or your own `reelforge-agent` App with an installation token). The founder is then *not* the author, so **the founder's approval counts**: a real two-party review. Commits created through the API by an App are signed by GitHub, which also helps with signed commits. | n8n (`n8n-assistant[bot]` release PRs), next.js (`vercel[bot]` reviews), remotion (claude-code-action, Pullfrog) | **Recommended target state.** Keep "require approval of most recent push" **off** if the founder sometimes pushes fixups. |
| **C. AI review bot as a gate.** Vercel Agent on next.js posts approving reviews; n8n's cubic auto-approves internal PRs but "auto-approval was skipped because the PR is from an external contributor". | next.js, n8n | Use the AI review as a **required status check** (pass/fail), not as the approval of record. Whether bot approvals count toward required reviews depends on settings (the "Allow GitHub Actions to create and approve pull requests" toggle and the App's permissions) and is easy to get wrong. |
| **D. Second maintainer account** controlled by the founder. | none | **Do not.** It is self-approval in disguise. GitHub's terms allow one free personal account per person, and a machine account only for automation. |
| **E. No required approvals; all gates are checks.** | dub *(inf)*, remotion *(inf)* | Acceptable fallback for the store, but nothing stops an outside PR from being merged with a careless click. |

**Recommendation:**
- Studio: A now, and B as soon as agents can open PRs through an App token. Required approvals = 1.
  CODEOWNERS review is required, with the admin bypass in `pull_request` mode. An AI review check (C)
  is required for all PRs. Auto-merge is the normal way the founder merges agent PRs.
- Store: the same, and also protect the `production` deployment environment: deployment branches limited
  to `main`, and a required reviewer = the founder for manual promotions.

`.github/CODEOWNERS` (studio):

```
*                         @FOUNDER
# Legal and governance: always founder-owned
/LICENSE.md               @FOUNDER
/COMMERCIAL-LICENSE.md    @FOUNDER
/LICENSING.md             @FOUNDER
/NOTICE                   @FOUNDER
/TRADEMARK.md             @FOUNDER
/CONTRIBUTING.md          @FOUNDER
/AGENTS.md                @FOUNDER
/CLAUDE.md                @FOUNDER
/.github/                 @FOUNDER
# Licence enforcement: maintainer-only zone (n8n "we keep these in-house")
/packages/core/src/licence.ts           @FOUNDER
/packages/db/migrations/**/0003_licence_state/  @FOUNDER
/e2e/mock-licence/        @FOUNDER
```

If outside PRs to the licence path should be refused rather than just reviewed, add a policy step:
label `maintainer-only-path`, comment, close. If you later create a `buildbase-app/maintainers` team, put
the team in CODEOWNERS instead of a person.

### 5.6 Ruleset settings (Settings → Rules → Rulesets; keep the JSON in `.github/rulesets/` like vscode)

**`main` (branch ruleset, target `~DEFAULT_BRANCH`, enforcement Active):**

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "required" },
          { "context": "PR title" },
          { "context": "PR policy" },
          { "context": "CLA" },
          { "context": "config-docs" } ] } },
    { "type": "code_scanning", "parameters": { "code_scanning_tools": [
        { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" } ] } }
  ]
}
```

- `actor_id` 5 is the built-in Admin repository role (the value vscode uses).
- `strict_required_status_checks_policy: false`: with many parallel agent PRs, "require up to date"
  causes rebase storms. Use a **merge queue** instead once more than a few PRs merge per day. Merge queue
  is available to public organisation repos; add `merge_group:` to every required workflow, CLA included.
  Suggested settings: SQUASH, `HEADGREEN`, max 5 to build, timeout 60 min.
- **Signed commits (`required_signatures`): phase 2.** next.js requires it, and an unsigned agent commit
  then blocks the PR ("A `Signed-off-by` line in the commit message is not enough"). Enable it after
  (i) the founder signs with an SSH key and (ii) agents either sign (SSH signing key in the agent
  environment) or commit through an App or the API, which GitHub signs. Squash merges made on GitHub are
  signed by GitHub regardless.

**`release tags` (tag ruleset, include `refs/tags/v*`):** rules `deletion`, `non_fast_forward`,
`update`, and `creation` restricted (only the admin role, via `always` bypass, or the release workflow's
App). This stops a compromised token from re-tagging a release that the signed image pipeline publishes.

**`agent branches` (optional, include `refs/heads/claude/**`, `refs/heads/agent/**`):** `non_fast_forward`
off (agents force-push) and `deletion` allowed. The main point is a ruleset scope you can later tighten.

### 5.7 Dependabot

Studio `.github/dependabot.yml` (pnpm is handled by the `npm` ecosystem):

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly, day: monday }
    cooldown: { default-days: 7 }          # supply-chain delay; drop if unsupported
    open-pull-requests-limit: 5
    groups:
      dev-deps:   { dependency-type: development, update-types: [minor, patch] }
      prod-minor: { dependency-type: production,  update-types: [minor, patch] }
    commit-message: { prefix: "chore(deps)", prefix-development: "chore(deps-dev)" }
    labels: [dependencies]
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: monthly }
    groups: { actions: { patterns: ["*"] } }   # formbricks: one monthly PR moves all actions together
    commit-message: { prefix: "chore(ci)" }
  - package-ecosystem: docker
    directory: "/"
    schedule: { interval: weekly }
    commit-message: { prefix: "chore(docker)" }
```

- The prefixes keep Dependabot titles Conventional, so they pass the title check.
- Turn on **Dependabot alerts** and **security updates** in settings (security updates do not depend on
  the schedule).
- Optional auto-merge workflow for patch-level dev-deps once checks pass, using
  `dependabot/fetch-metadata`.
- Exempt `dependabot[bot]` from the CLA, PR-policy and size checks (n8n skips "bot-authored PRs").
- Store: the same file, but its lockfile is `package-lock.json`, so `npm` with `directory: "/"` plus
  github-actions.

### 5.8 CodeQL

- Use **default setup** (Settings → Advanced Security → Code scanning → Default) for
  `javascript-typescript` **and** `actions`. The `actions` language finds workflow injection and unsafe
  `pull_request_target`, which matters once there are bots with write tokens.
- Gate merges on it with the ruleset `code_scanning` rule above.
- Alongside it: OpenSSF Scorecard (curl, node, llvm) and **zizmor** (cpython, llvm, supabase) on
  `.github/workflows/**`.
- Workflow conventions to put in `.github/AGENTS.md` (next.js has exactly such a file):
  - `permissions: {}` at the top level
  - SHA-pinned third-party actions with a `# vX.Y.Z` comment
  - `persist-credentials: false`
  - never check out the PR head in `pull_request_target`
- Org/repo Actions policy: "Require actions to be pinned to a full-length commit SHA" where offered;
  allow only GitHub-owned, verified and listed actions.

### 5.9 Secret scanning and push protection

- Turn on secret scanning, push protection and validity checks (free on public repos).
- Turn on **Private vulnerability reporting**, and make SECURITY.md point to the "Report a vulnerability"
  advisory form plus a security email with a response-time promise (dub: "We will respond within 48
  hours").
- Keep the existing image secret scan and Trivy in `ci.yml`.
- Add `gitleaks` only if you want pre-commit coverage for agents.
- Push protection bypasses by the founder are logged. Review them monthly.
- The store's deploy secrets (Cloudflare) belong in an **environment** (`production`), never in
  repo-level secrets that fork PR workflows could reach.

### 5.10 First-time contributor workflow approval

- Settings → Actions → General → "Fork pull request workflows from outside collaborators": choose the
  strictest option, **"Require approval for all external contributors"** (outside collaborators). Both
  repos are public and have secrets and deploy paths. Node tells newcomers why: "For a first pull
  request, GitHub Actions require collaborator approval ... so an initial wait is normal."
- "Workflow permissions": read-only `GITHUB_TOKEN`.
- Leave "Allow GitHub Actions to create and approve pull requests" **off**, unless you adopt option B
  through Actions.
- Add a welcome job (cal.com/node pattern) for `FIRST_TIME_CONTRIBUTOR` / `FIRST_TIMER` / `NONE` authors.
  It links CONTRIBUTING, the AI policy and the CLA, and explains the approval wait. Optionally add an
  advisory automation heuristic such as Node's AgentScan step, **never auto-closing on it**.
- If spam grows, consider the Ghostty **vouch** model ([mitchellh/vouch](https://github.com/mitchellh/vouch)):
  unvouched PRs are closed automatically with a pointer to a "Vouch request" discussion form.
  Alternatively, temporarily set interaction limits ("Limit to prior contributors").

### 5.11 CLA (studio) and DCO (store)

- **Studio:** a CLA is required, because PolyForm-NC inbound=outbound would not give BuildBase the right
  to ship contributions under the commercial licence. A DCO only certifies origin; it grants no
  relicensing rights. Replace "By opening a pull request you confirm..." with a recorded signature.
  Option 1, `contributor-assistant/github-action` (CLA Assistant Lite):
  - signatures stored in a **separate private repo** (`remote-organization-name` /
    `remote-repository-name`)
  - `allowlist: @FOUNDER,dependabot[bot],github-actions[bot],claude[bot],*[bot]`
  - sign comment: "I have read the ReelForge CLA and I hereby sign it"
  - triggers on `pull_request_target` and `issue_comment`
  - if a merge queue is adopted, add a trivial `merge_group` job named `CLA` (servo's DCO trick), or build
    n8n's in-house status action

  Option 2: cla-assistant.io. Keep the CLA in plain English and short (n8n's is two sentences), but have
  it reviewed (the repo marks it "draft, pending legal review"). Add a `cla-signed` label for triage.
- **Store:** it is MIT today, so a DCO (`Signed-off-by`, enforced by the DCO GitHub App) is enough. If the
  store is meant to stay proprietary, the bigger question is its MIT licence, not the contribution gate.

### 5.12 Auto-close and bot wording for non-compliant PRs

Principles drawn from the repos:
- Label first and close second.
- Explain the fix and link the policy.
- Invite a reply ("If you think we've misunderstood...").
- Never auto-close on heuristics alone.
- Exempt `OWNER` / `MEMBER` / `COLLABORATOR` and bots.

Workflow skeleton (`pull_request_target`, which reads only the payload and never checks out code):

```yaml
name: PR policy
on:
  pull_request_target:
    types: [opened, edited, reopened, synchronize, ready_for_review]
permissions: {}
jobs:
  policy:
    name: PR policy
    runs-on: ubuntu-24.04
    permissions: { pull-requests: write, issues: write }
    steps:
      - uses: actions/github-script@<sha> # v7
        with:
          script: |
            const pr = context.payload.pull_request;
            const trusted = ['OWNER','MEMBER','COLLABORATOR'].includes(pr.author_association) || pr.user.type === 'Bot';
            const body = pr.body || '';
            const problems = [];
            if (!/\*\*Autonomy:\*\*\s*(Human-written|Human-driven|Agent-authored)/i.test(body)) problems.push('disclosure');
            if (!trusted && !/\b(fixes|closes|resolves|refs)\s+#\d+/i.test(body)) problems.push('issue');
            if (trusted && pr.head.repo.full_name === context.payload.repository.full_name
                && !/^(feat|fix|docs|chore|refactor|test|ci|perf|build|revert|claude|agent|dependabot)\//.test(pr.head.ref))
              problems.push('branch');
            // post or update one sticky comment per problem (wording below), add labels, then:
            if (problems.length) core.setFailed('PR policy: ' + problems.join(', '));
```

Then add a scheduled `actions/stale` job that closes only labelled PRs: `only-pr-labels:
needs-issue,needs-info,cla-missing`, `days-before-pr-stale: 7`, `days-before-pr-close: 7`, issues
untouched. This is n8n's model ("we only close PRs where we asked for changes and got no response").

Wording (adapt `@{author}` and links):

- **Missing linked issue** (label `needs-issue`, close after 7 days):
  > Thanks for the pull request, @{author}! ReelForge accepts code changes that implement an accepted
  > issue, so we can agree on the approach before you spend time on it. Please add `Fixes #<number>` to
  > the description, or [open an issue](…/issues/new/choose) first. Feature ideas start in
  > [Discussions](…/discussions/new?category=ideas). If nothing changes, this PR will be closed in 7 days.
  > Closed PRs can be reopened at any time, so nothing is lost.

- **Disclosure block missing** (check fails; no close):
  > Every pull request, from people or from AI agents, needs the "AI / agent disclosure" section of the
  > template filled in: say whether AI was used, which tool, and what a human checked. Using AI is fine.
  > Not saying so is not. See our [AI policy](…/CONTRIBUTING.md#ai-policy).

- **CLA not signed** (label `cla-missing`; the check stays red; close after 14 days):
  > Before we can merge this, we need your signature on the ReelForge Contributor Licence Agreement.
  > ReelForge is dual-licensed (PolyForm Noncommercial and a commercial licence), and the CLA lets us
  > include your contribution under both while you keep your copyright. To sign, reply with exactly: *I
  > have read the ReelForge CLA and I hereby sign it*.

- **AI guidelines not met** (applied by the founder; the bot closes; CPython/LLVM wording):
  > Thank you for your interest in ReelForge. Contributors are responsible for reviewing and
  > understanding what they submit, checking its claims, and being able to explain the change in their
  > own words. We believe this pull request does not meet our [guidelines for AI-assisted
  > contributions](…), so we're closing it. If you think we've misunderstood it, reply here. You're
  > welcome to explain your approach or ask about the guidelines.

  Also have a softer label `ai-needs-explanation` that keeps the PR open and asks the author to "explain
  in your own words what the change does and how you checked it is correct".

- **Maintainer-only path** (licence enforcement):
  > This pull request changes licence-enforcement code, which the maintainers handle in-house because a
  > mistake there affects every customer's licence. Please open an issue describing the bug or idea and
  > we'll take it from there. Closing for now. Thank you for flagging it!

- **Stale after requested changes** (n8n wording):
  > It's been a while since we asked for changes on this PR and we haven't heard back. If you're still
  > interested, please address the feedback above; otherwise we'll close it in 7 days to keep the review
  > queue manageable. Closed PRs can always be reopened.

### 5.13 AI policy text for CONTRIBUTING.md (proposed)

> **AI-assisted contributions.** You may use AI tools. You are the author and fully accountable for what
> you submit:
> 1. **Understand it.** If you can't explain what your change does and how it fits the system without AI
>    help, don't open the PR.
> 2. **Disclose it.** Fill in the PR template's "AI / agent disclosure": the tool, the extent, and what
>    you checked yourself. Disclosure is not a disclaimer.
> 3. **Write the description and your review replies yourself.** Don't paste model output into issues,
>    PRs or reviews.
> 4. **Same gates as everyone.** Accepted issue first, tests that fail without your fix, no weakened
>    tests, the CLA signed.
> 5. **No unattended agents.** Bots and agents may not open PRs, issues or comments here unless a
>    maintainer approved that automation in advance.
> 6. **Security reports found with AI** must say so and be verified by you before you send them.
>    Fabricated reports get the reporter blocked.
>
> Maintainers' own agents follow a stricter, automated standard: the disclosure block, draft-first PRs,
> all checks green, and a human merge.

For the founder's agents, put the same rules in AGENTS.md:
- open draft PRs on `claude/…` branches, with a Conventional title and the filled disclosure block
- run `pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test` before marking a PR ready
- never touch `.github/`, licence files or `packages/core/src/licence.ts` unless the task says so
- never merge or approve
- keep PRs under the size limit

**Commit trailers.** Pick one rule and write it down. Claude Code's `Co-Authored-By: Claude …` trailer
is allowed by LLVM-style policies but banned by Kubernetes, and Node advises against brand names in
commits. Suggestion: keep the trailer for the founder's own agents, since it is honest provenance and
costs nothing, and do not require it from outsiders.

### 5.14 Rollout order (one sitting each)

1. Settings:
   - merge: squash only, delete branches, auto-merge
   - Actions: approval for all external contributors, read-only token
   - security: secret scanning + push protection, private vulnerability reporting, Dependabot alerts
     and updates, CodeQL default setup
   - Discussions
2. Files: CODEOWNERS, issue forms + `config.yml`, PR template, SECURITY.md, CONTRIBUTING AI policy,
   `dependabot.yml`, `.github/AGENTS.md` workflow rules.
3. Workflows: PR title, PR policy, `required` aggregator, CLA, welcome, stale-close, dependency review.
4. Rulesets: `main` with admin bypass in `pull_request` mode, and `v*` tags. Store the JSON in
   `.github/rulesets/` with a drift check (vscode `rulesets.yml`).
5. Later:
   - an App identity for agent PRs (option B), then turn on signed commits
   - a merge queue when PR volume needs it
   - the vouch model if spam appears

---

## 6. Sources

Files, read at HEAD on 2026-11-21:

- next.js:
  [contributing.md](https://github.com/vercel/next.js/blob/canary/contributing.md),
  [pull_request_template.md](https://github.com/vercel/next.js/blob/canary/.github/pull_request_template.md),
  [ISSUE_TEMPLATE/config.yml](https://github.com/vercel/next.js/blob/canary/.github/ISSUE_TEMPLATE/config.yml),
  [.github/AGENTS.md](https://github.com/vercel/next.js/blob/canary/.github/AGENTS.md),
  [next-maintainer-auto-close.yml](https://github.com/vercel/next.js/blob/canary/.github/workflows/next-maintainer-auto-close.yml)
- react:
  [PULL_REQUEST_TEMPLATE.md](https://github.com/facebook/react/blob/main/.github/PULL_REQUEST_TEMPLATE.md),
  [config.yml](https://github.com/facebook/react/blob/main/.github/ISSUE_TEMPLATE/config.yml),
  [shared_close_direct_sync_branch_prs.yml](https://github.com/facebook/react/blob/main/.github/workflows/shared_close_direct_sync_branch_prs.yml)
- vscode:
  [rulesets/README.md](https://github.com/microsoft/vscode/blob/main/.github/rulesets/README.md),
  [main-merge-queue.json](https://github.com/microsoft/vscode/blob/main/.github/rulesets/main-merge-queue.json),
  [rulesets.yml](https://github.com/microsoft/vscode/blob/main/.github/workflows/rulesets.yml),
  [pull_request_template.md](https://github.com/microsoft/vscode/blob/main/.github/pull_request_template.md),
  [copilot-instructions.md](https://github.com/microsoft/vscode/blob/main/.github/copilot-instructions.md)
- kubernetes:
  [PULL_REQUEST_TEMPLATE.md](https://github.com/kubernetes/kubernetes/blob/master/.github/PULL_REQUEST_TEMPLATE.md),
  [AGENTS.md](https://github.com/kubernetes/kubernetes/blob/master/AGENTS.md),
  [OWNERS](https://github.com/kubernetes/kubernetes/blob/master/OWNERS),
  [community PR guide, AI Guidance](https://github.com/kubernetes/community/blob/master/contributors/guide/pull-requests.md)
- node:
  [CONTRIBUTING.md](https://github.com/nodejs/node/blob/main/CONTRIBUTING.md),
  [ai-guidelines.md](https://github.com/nodejs/node/blob/main/doc/contributing/ai-guidelines.md),
  [collaborator-guide.md](https://github.com/nodejs/node/blob/main/doc/contributing/collaborator-guide.md),
  [contributor-guidance.yml](https://github.com/nodejs/node/blob/main/.github/workflows/contributor-guidance.yml),
  [OpenJS AI Coding Assistants Policy](https://ai-coding-assistants-policy.openjsf.org/)
- cpython:
  [AGENTS.md](https://github.com/python/cpython/blob/main/AGENTS.md),
  [PULL_REQUEST_TEMPLATE.md](https://github.com/python/cpython/blob/main/.github/PULL_REQUEST_TEMPLATE.md),
  [devguide: AI tools](https://devguide.python.org/getting-started/ai-tools/)
  ([source](https://github.com/python/devguide/blob/main/getting-started/ai-tools.rst))
- llvm:
  [AIToolPolicy.md](https://github.com/llvm/llvm-project/blob/main/llvm/docs/AIToolPolicy.md),
  [DeveloperPolicy.md](https://github.com/llvm/llvm-project/blob/main/llvm/docs/DeveloperPolicy.md)
- curl:
  [CONTRIBUTE.md (On AI use in curl)](https://github.com/curl/curl/blob/master/docs/CONTRIBUTE.md),
  [pull_request_template.md](https://github.com/curl/curl/blob/master/.github/pull_request_template.md),
  [config.yml](https://github.com/curl/curl/blob/master/.github/ISSUE_TEMPLATE/config.yml),
  [GOVERNANCE.md](https://github.com/curl/curl/blob/master/docs/GOVERNANCE.md)
- ghostty:
  [AI_POLICY.md](https://github.com/ghostty-org/ghostty/blob/main/AI_POLICY.md),
  [CONTRIBUTING.md](https://github.com/ghostty-org/ghostty/blob/main/CONTRIBUTING.md),
  [vouch-check-pr.yml](https://github.com/ghostty-org/ghostty/blob/main/.github/workflows/vouch-check-pr.yml),
  [vouch-request.yml](https://github.com/ghostty-org/ghostty/blob/main/.github/DISCUSSION_TEMPLATE/vouch-request.yml),
  [CODEOWNERS](https://github.com/ghostty-org/ghostty/blob/main/CODEOWNERS),
  [mitchellh/vouch](https://github.com/mitchellh/vouch)
- servo:
  [AI usage policy](https://book.servo.org/policy/ai-usage.html)
  ([source](https://github.com/servo/book/blob/main/src/policy/ai-usage.md)),
  [Making a pull request](https://github.com/servo/book/blob/main/src/contributing/making-a-pull-request.md),
  [dco-merge-group.yml](https://github.com/servo/servo/blob/main/.github/workflows/dco-merge-group.yml),
  [discussion #36379](https://github.com/servo/servo/discussions/36379)
- cal.com / Cal.diy:
  [CONTRIBUTING.md](https://github.com/calcom/cal.com/blob/main/CONTRIBUTING.md),
  [PULL_REQUEST_TEMPLATE.md](https://github.com/calcom/cal.com/blob/main/.github/PULL_REQUEST_TEMPLATE.md),
  [semantic-pull-requests.yml](https://github.com/calcom/cal.com/blob/main/.github/workflows/semantic-pull-requests.yml),
  [pr-welcome-bot.yml](https://github.com/calcom/cal.com/blob/main/.github/workflows/pr-welcome-bot.yml),
  [AGENTS.md](https://github.com/calcom/cal.com/blob/main/AGENTS.md)
- formbricks:
  [CONTRIBUTING.md](https://github.com/formbricks/formbricks/blob/main/CONTRIBUTING.md),
  [pull_request_template.md](https://github.com/formbricks/formbricks/blob/main/.github/pull_request_template.md),
  [semantic-pull-requests.yml](https://github.com/formbricks/formbricks/blob/main/.github/workflows/semantic-pull-requests.yml),
  [dependabot.yml](https://github.com/formbricks/formbricks/blob/main/.github/dependabot.yml),
  [LICENSE](https://github.com/formbricks/formbricks/blob/main/LICENSE)
- dub:
  [LICENSE.md](https://github.com/dubinc/dub/blob/main/LICENSE.md),
  [SECURITY.md](https://github.com/dubinc/dub/blob/main/SECURITY.md)
- supabase:
  [CONTRIBUTING.md](https://github.com/supabase/supabase/blob/master/CONTRIBUTING.md),
  [pull_request_template.md](https://github.com/supabase/supabase/blob/master/.github/pull_request_template.md),
  [external-pr-comment.yml](https://github.com/supabase/supabase/blob/master/.github/workflows/external-pr-comment.yml),
  [authorize-vercel-deploys.yml](https://github.com/supabase/supabase/blob/master/.github/workflows/authorize-vercel-deploys.yml),
  [org config.yml](https://github.com/supabase/.github/blob/main/.github/ISSUE_TEMPLATE/config.yml)
- n8n:
  [CONTRIBUTING.md](https://github.com/n8n-io/n8n/blob/master/CONTRIBUTING.md),
  [CONTRIBUTOR_LICENSE_AGREEMENT.md](https://github.com/n8n-io/n8n/blob/master/CONTRIBUTOR_LICENSE_AGREEMENT.md),
  [LICENSE.md](https://github.com/n8n-io/n8n/blob/master/LICENSE.md),
  [ci-cla-check.yml](https://github.com/n8n-io/n8n/blob/master/.github/workflows/ci-cla-check.yml),
  [ci-pr-quality.yml](https://github.com/n8n-io/n8n/blob/master/.github/workflows/ci-pr-quality.yml),
  [pull_request_title_conventions.md](https://github.com/n8n-io/n8n/blob/master/.github/pull_request_title_conventions.md),
  [community-pr-close-stale.yml](https://github.com/n8n-io/n8n/blob/master/.github/workflows/community-pr-close-stale.yml),
  [license-enforcement review rule](https://github.com/n8n-io/n8n/blob/master/.agents/review-rules/backend/license-enforcement.md)
- remotion:
  [LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md),
  [contributing docs](https://www.remotion.dev/docs/contributing)
  ([source](https://github.com/remotion-dev/remotion/blob/main/packages/docs/docs/contributing/index.mdx)),
  [claude.yml](https://github.com/remotion-dev/remotion/blob/main/.github/workflows/claude.yml)
- PostHog:
  [pull_request_template.md](https://github.com/PostHog/posthog/blob/master/.github/pull_request_template.md),
  [LICENSE](https://github.com/PostHog/posthog/blob/master/LICENSE),
  [ee/LICENSE](https://github.com/PostHog/posthog/blob/master/ee/LICENSE),
  [CODEOWNERS](https://github.com/PostHog/posthog/blob/master/.github/CODEOWNERS)

PR pages and lists inspected:

- next.js: [#102092](https://github.com/vercel/next.js/pull/102092),
  [merged list](https://github.com/vercel/next.js/pulls?q=is%3Apr+is%3Aclosed+is%3Amerged)
- react: [#38319](https://github.com/facebook/react/pull/38319)
- n8n: [#44604](https://github.com/n8n-io/n8n/pull/44604),
  [community PRs](https://github.com/n8n-io/n8n/pulls?q=is%3Apr+is%3Aclosed+label%3Acommunity)
- cpython: [#162083](https://github.com/python/cpython/pull/162083),
  [AI-guidelines-not-met PRs](https://github.com/python/cpython/pulls?q=is%3Apr+is%3Aclosed+label%3AAI-guidelines-not-met)
- ghostty: [#15231](https://github.com/ghostty-org/ghostty/pull/15231)
- node: [commit-queue PRs](https://github.com/nodejs/node/pulls?q=is%3Apr+is%3Aclosed+label%3Acommit-queue)
- kubernetes: [merged PRs](https://github.com/kubernetes/kubernetes/pulls?q=is%3Apr+is%3Amerged)
- dub: [closed PRs](https://github.com/dubinc/dub/pulls?q=is%3Apr+is%3Aclosed)

Background and GitHub documentation:

- [GitHub: approving a PR with required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)
- [GitHub changelog: prevent Actions from creating and approving PRs](https://github.blog/changelog/2022-05-03-github-actions-prevent-github-actions-from-creating-and-approving-pull-requests/)
- [Community discussion: bot approvals and required reviews](https://github.com/orgs/community/discussions/181487)
- [GitHub: available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub: REST API for rulesets](https://docs.github.com/en/rest/repos/rules)
- [Simon Willison on Servo's policy](https://simonwillison.net/2025/May/12/contributing-to-servo/)
- [Catalogue of open-source AI policies](https://github.com/melissawm/open-source-ai-contribution-policies)
- [Fedora AI-assisted contributions policy proposal](https://communityblog.fedoraproject.org/council-policy-proposal-policy-on-ai-assisted-contributions/)
- [QEMU code provenance (AI ban)](https://www.qemu.org/docs/master/devel/code-provenance.html#use-of-ai-content-generators)

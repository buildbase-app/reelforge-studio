#!/usr/bin/env bash
# Apply ReelForge's GitHub governance to one repository. Idempotent: safe to re-run.
# Needs the GitHub CLI signed in as a repository admin: `gh auth login`.
#
#   scripts/github/apply-repo-settings.sh buildbase-app/reelforge-studio  "pr-policy" "test" "docker"
#   scripts/github/apply-repo-settings.sh buildbase-app/reelforge-selling-public-site "pr-policy" "Code Analysis"
#
# Arguments after the repo are the required status checks (job names) for `main`.
# See docs/GITHUB_GOVERNANCE.md for what each setting does and why.
set -euo pipefail
REPO=${1:?usage: apply-repo-settings.sh OWNER/REPO CHECK [CHECK...]}; shift
[ $# -ge 1 ] || { echo "give at least one required check, e.g. pr-policy"; exit 2; }
command -v gh >/dev/null || { echo "install the GitHub CLI: https://cli.github.com"; exit 2; }
say() { printf '\n== %s\n' "$*"; }

say "Repository settings: squash merge only, PR title as commit, delete merged branches"
gh api -X PATCH "repos/$REPO" --silent \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F allow_auto_merge=true -F delete_branch_on_merge=true -F allow_update_branch=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F has_wiki=false

say "Security: secret scanning + push protection, Dependabot alerts and fixes, private vulnerability reporting, CodeQL"
gh api -X PATCH "repos/$REPO" --silent --input - <<'JSON' || echo "   (some security features need GitHub Advanced Security on private repos; public repos get them free)"
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" },
    "dependabot_security_updates": { "status": "enabled" } } }
JSON
gh api -X PUT "repos/$REPO/vulnerability-alerts" --silent || true
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" --silent || true
gh api -X PATCH "repos/$REPO/code-scanning/default-setup" --silent -f state=configured -f query_suite=default || echo "   (CodeQL default setup: enable it under Settings → Code security if this failed)"

say "Actions: read-only default token, workflows cannot approve PRs, outside contributors need approval to run workflows"
gh api -X PUT "repos/$REPO/actions/permissions/workflow" --silent -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" --silent -f approval_policy=all_external_contributors || true

say "Labels used by the PR policy and issue forms"
for l in "policy: needs-changes|b60205|Fails the PR policy; see the pr-policy comment" "stale|cfd3d7|No activity" \
         "type: bug|d73a4a|Something is broken" "type: feature|a2eeef|New capability" "status: triage|fbca04|Needs a maintainer to look"; do
  IFS='|' read -r name color desc <<<"$l"
  gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null && echo "   label: $name"
done

checks_json=$(printf '{"context":"%s"},' "$@"); checks_json="[${checks_json%,}]"
upsert_ruleset() { # $1 name, $2 json body
  local id; id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name==\"$1\") | .id" 2>/dev/null | head -1)
  if [ -n "$id" ]; then gh api -X PUT "repos/$REPO/rulesets/$id" --silent --input - <<<"$2"; echo "   updated ruleset: $1 ($id)";
  else gh api -X POST "repos/$REPO/rulesets" --silent --input - <<<"$2"; echo "   created ruleset: $1"; fi
}

say "Ruleset: protect main (PR + 1 code-owner approval + green checks, squash only, no force-push/deletion, linear history)"
upsert_ruleset "main protection" "$(cat <<JSON
{
  "name": "main protection",
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
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": $checks_json } }
  ]
}
JSON
)"

say "Ruleset: protect release tags v* (no deletion, no moving; only admins create them)"
upsert_ruleset "release tags" "$(cat <<'JSON'
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" }, { "type": "update" }, { "type": "creation" } ]
}
JSON
)"

say "Done. Check: https://github.com/$REPO/settings/rules"

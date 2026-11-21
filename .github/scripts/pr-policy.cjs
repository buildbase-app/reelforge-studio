/* eslint-disable @typescript-eslint/no-require-imports -- plain Node CommonJS, run by node --test and actions/github-script */
// Pull-request policy for ReelForge repositories. Pure function, no dependencies,
// so it runs the same in GitHub Actions (actions/github-script) and in local tests.
//
// A PR that breaks a rule gets a failing `pr-policy` check (a required status
// check on `main`), a comment that lists what to fix, and the label
// `policy: needs-changes`. See CONTRIBUTING.md, "Pull requests".
'use strict';

const TYPES = [
  'feat',
  'fix',
  'docs',
  'chore',
  'refactor',
  'perf',
  'test',
  'ci',
  'build',
  'revert',
  'security',
];

// Branch names: <type>/<short-kebab-description>, or an AI agent prefix, or bots.
const BRANCH_PATTERNS = [
  new RegExp(`^(${TYPES.join('|')}|hotfix|release)/[a-z0-9][a-z0-9._-]{1,60}$`),
  /^(claude|codex|copilot|cursor|devin|agent)\/[a-z0-9][a-z0-9._-]{1,60}$/,
  /^dependabot\/.+$/,
  /^renovate\/.+$/,
];
const TITLE = new RegExp(
  `^(${TYPES.join('|')})(\\([a-z0-9._/-]+\\))?!?: \\S.{2,98}$`
);
const LINKED_ISSUE =
  /\b(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?|part of)\s+(#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;
const REQUIRED_SECTIONS = [
  '## Summary',
  '## Linked issue',
  '## How was this tested',
  '## Checklist',
  '## AI assistance',
];
// Maintainer-only paths: legal files, governance, CI and licence enforcement.
const PROTECTED_FILES = [
  /^LICENSE(\.md)?$/,
  /^NOTICE$/,
  /^COMMERCIAL-LICENSE\.md$/,
  /^TRADEMARK\.md$/,
  /^LICENSING\.md$/,
  /^CONTRIBUTING\.md$/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^\.github\//,
  /^packages\/core\/src\/licence\.ts$/,
  /^e2e\/mock-licence\//,
  /licence_state/,
];
const BOT_AUTHORS =
  /^(dependabot\[bot\]|renovate\[bot\]|github-actions\[bot\])$/;
const MAX_CHANGED_LINES = 1500;

/**
 * @param {object} pr
 * @param {string} pr.branch       head ref, e.g. "feat/add-caption-presets"
 * @param {string} pr.base         base ref, e.g. "main"
 * @param {string} pr.title
 * @param {string|null} pr.body
 * @param {string} pr.author       login of the PR author
 * @param {boolean} pr.isMaintainer author is an owner/member/collaborator (author_association)
 * @param {string[]} [pr.files]    changed file paths
 * @param {number} [pr.changedLines] additions + deletions
 * @param {boolean} [pr.draft]
 * @param {boolean} [pr.isFork]   PR comes from a fork (fork branch names are the contributor's choice)
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkPullRequest(pr) {
  const errors = [];
  const warnings = [];
  const body = (pr.body || '').replace(/<!--[\s\S]*?-->/g, ''); // template comments do not count
  const isBot = BOT_AUTHORS.test(pr.author || '');

  if (pr.base !== 'main' && !/^release\//.test(pr.base)) {
    errors.push(
      `Target branch is \`${pr.base}\`. Open pull requests against \`main\`.`
    );
  }
  if (!pr.isFork && !BRANCH_PATTERNS.some((re) => re.test(pr.branch))) {
    errors.push(
      `Branch name \`${pr.branch}\` does not follow the convention: \`<type>/<short-description>\` with type one of ${TYPES.map((t) => '`' + t + '`').join(', ')}, \`hotfix\` or \`release\` (lowercase, digits, \`.\`, \`_\`, \`-\`), or an AI agent prefix such as \`claude/…\`, \`codex/…\`, \`copilot/…\`, \`cursor/…\`.`
    );
  }
  if (!TITLE.test(pr.title || '')) {
    errors.push(
      `Title \`${pr.title}\` is not a Conventional Commit: \`<type>(optional-scope): <summary>\`, e.g. \`fix(render): keep the first frame non-empty\`. It becomes the squash commit message.`
    );
  }
  if (isBot) return { errors, warnings }; // bots: branch/title/base only

  const missing = REQUIRED_SECTIONS.filter(
    (s) => !body.toLowerCase().includes(s.toLowerCase())
  );
  if (missing.length) {
    errors.push(
      `The description is missing template sections: ${missing.map((s) => '`' + s + '`').join(', ')}. Use the pull request template.`
    );
  }
  if (!LINKED_ISSUE.test(body)) {
    errors.push(
      'Link the issue this PR resolves in the description, e.g. `Closes #123` (or `Refs #123` for partial work). Open an issue first if there is none.'
    );
  }
  const unchecked = body
    .split('\n')
    .filter((l) => /^\s*[-*] \[ \].*\(required\)/i.test(l));
  if (unchecked.length) {
    errors.push(
      `Required checklist items are not ticked:\n${unchecked.map((l) => '  - ' + l.replace(/^\s*[-*] \[ \]\s*/, '').trim()).join('\n')}`
    );
  }
  const aiSection = (body.split(/^## AI assistance/im)[1] || '').split(
    /^## /m
  )[0];
  const aiTicked = aiSection
    .split('\n')
    .filter((l) => /^\s*[-*] \[[xX]\]/.test(l));
  if (aiTicked.length !== 1) {
    errors.push(
      'Under `## AI assistance`, tick exactly one option: no AI used, AI-assisted, or AI-generated (name the tool and model).'
    );
  } else if (/AI-(assisted|generated)/i.test(aiTicked[0])) {
    if (!/(tool|model)[ \t]*:[ \t]*[A-Za-z0-9]/i.test(aiSection)) {
      errors.push(
        'AI was used: name the tool and model under `## AI assistance` (e.g. `Tool: Claude Code, model: …`).'
      );
    }
    if (!/human checked[ \t]*:[ \t]*[A-Za-z0-9]/i.test(aiSection)) {
      errors.push(
        'AI was used: say what a person read, ran or decided on the `Human checked:` line under `## AI assistance`.'
      );
    }
  }
  const touchedProtected = (pr.files || []).filter((f) =>
    PROTECTED_FILES.some((re) => re.test(f))
  );
  if (touchedProtected.length && !pr.isMaintainer) {
    errors.push(
      `Only maintainers may change licence, governance, CI or licence-enforcement files (open an issue instead): ${touchedProtected.map((f) => '`' + f + '`').join(', ')}.`
    );
  }
  if ((pr.changedLines || 0) > MAX_CHANGED_LINES) {
    warnings.push(
      `This PR changes ${pr.changedLines} lines (over ${MAX_CHANGED_LINES}). Split it into smaller PRs where you can; large PRs take longer to review.`
    );
  }
  if (pr.draft)
    warnings.push(
      'Draft PR: the policy runs again when it is marked ready for review.'
    );
  return { errors, warnings };
}

function renderComment({ errors, warnings }, marker = '<!-- pr-policy -->') {
  if (!errors.length && !warnings.length) {
    return `${marker}\n✅ **PR policy: passed.** Thanks! A maintainer will review once all checks are green.`;
  }
  const lines = [marker];
  if (errors.length) {
    lines.push(
      '❌ **PR policy: changes needed.** This pull request cannot be merged until these are fixed:',
      ''
    );
    errors.forEach((e, i) => lines.push(`${i + 1}. ${e}`));
    lines.push(
      '',
      'Edit the title, description or branch and the check runs again. Pull requests that stay non-compliant for 14 days are closed automatically.',
      'Rules: [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md#pull-requests). AI agents: read [AGENTS.md](../blob/main/AGENTS.md) first.'
    );
  }
  if (warnings.length) {
    lines.push('', '⚠️ **Notes:**');
    warnings.forEach((w) => lines.push(`- ${w}`));
  }
  return lines.join('\n');
}

module.exports = {
  checkPullRequest,
  renderComment,
  TYPES,
  BRANCH_PATTERNS,
  TITLE,
};

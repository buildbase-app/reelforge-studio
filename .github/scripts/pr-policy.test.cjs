/* eslint-disable @typescript-eslint/no-require-imports -- plain Node CommonJS, run by node --test and actions/github-script */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { checkPullRequest, renderComment } = require('./pr-policy.cjs');

const template = fs.readFileSync(
  path.join(__dirname, '..', 'PULL_REQUEST_TEMPLATE.md'),
  'utf8'
);
const filled = template
  .replace('\nCloses #\n', '\nCloses #42\n')
  .replace(/- \[ \] (.*\(required\))/g, '- [x] $1')
  .replace('- [ ] AI-generated', '- [x] AI-generated')
  .replace('Tool: , model:', 'Tool: Claude Code, model: claude-opus')
  .replace(
    /Human checked:[ \t]*/,
    'Human checked: I read the diff and ran the tests'
  );
const good = {
  branch: 'feat/caption-presets',
  base: 'main',
  title: 'feat(captions): add four caption style presets',
  body: filled,
  author: 'someone',
  isMaintainer: false,
  files: ['packages/core/src/x.ts'],
  changedLines: 120,
};

test('a compliant PR passes', () =>
  assert.deepStrictEqual(checkPullRequest(good).errors, []));
test('agent branch prefixes are allowed', () =>
  assert.deepStrictEqual(
    checkPullRequest({ ...good, branch: 'claude/eloquent-wright-tm3cs7' })
      .errors,
    []
  ));
test('the untouched template fails (no issue, unticked boxes, no AI choice)', () => {
  const e = checkPullRequest({ ...good, body: template }).errors.join('\n');
  assert.match(e, /Link the issue/);
  assert.match(e, /Required checklist items/);
  assert.match(e, /tick exactly one/);
});
test('bad branch name fails', () =>
  assert.match(
    checkPullRequest({ ...good, branch: 'my-cool-change' }).errors.join(),
    /Branch name/
  ));
test('bad title fails', () =>
  assert.match(
    checkPullRequest({ ...good, title: 'Added captions' }).errors.join(),
    /Conventional Commit/
  ));
test('wrong base fails', () =>
  assert.match(
    checkPullRequest({ ...good, base: 'dev' }).errors.join(),
    /Target branch/
  ));
test('empty body fails with missing sections', () =>
  assert.match(
    checkPullRequest({ ...good, body: '' }).errors.join(),
    /missing template sections/
  ));
test('AI used without naming the tool fails', () =>
  assert.match(
    checkPullRequest({
      ...good,
      body: filled.replace(
        'Tool: Claude Code, model: claude-opus',
        'Tool: , model:'
      ),
    }).errors.join(),
    /name the tool and model/
  ));
test('two AI options ticked fails', () =>
  assert.match(
    checkPullRequest({
      ...good,
      body: filled.replace('- [ ] No AI used', '- [x] No AI used'),
    }).errors.join(),
    /exactly one/
  ));
test('outsiders cannot change licence files; maintainers can', () => {
  assert.match(
    checkPullRequest({ ...good, files: ['LICENSE.md'] }).errors.join(),
    /Only maintainers/
  );
  assert.deepStrictEqual(
    checkPullRequest({ ...good, files: ['LICENSE.md'], isMaintainer: true })
      .errors,
    []
  );
});
test('an issue link hidden in a template comment does not count', () =>
  assert.match(
    checkPullRequest({
      ...good,
      body: filled.replace('Closes #42', '<!-- Closes #42 -->'),
    }).errors.join(),
    /Link the issue/
  ));
test('fork PRs may use any branch name', () =>
  assert.deepStrictEqual(
    checkPullRequest({ ...good, branch: 'patch-1', isFork: true }).errors,
    []
  ));
test('AI used without saying what a human checked fails', () =>
  assert.match(
    checkPullRequest({
      ...good,
      body: filled.replace(
        'Human checked: I read the diff and ran the tests',
        'Human checked: '
      ),
    }).errors.join(),
    /Human checked/
  ));
test('outsiders cannot change licence enforcement or CI', () => {
  assert.match(
    checkPullRequest({
      ...good,
      files: ['packages/core/src/licence.ts'],
    }).errors.join(),
    /Only maintainers/
  );
  assert.match(
    checkPullRequest({
      ...good,
      files: ['.github/workflows/ci.yml'],
    }).errors.join(),
    /Only maintainers/
  );
});
test('dependabot only needs branch/title/base', () =>
  assert.deepStrictEqual(
    checkPullRequest({
      branch: 'dependabot/npm_and_yarn/zod-4.1.0',
      base: 'main',
      title: 'build(deps): bump zod from 4.0.0 to 4.1.0',
      body: 'Bumps zod',
      author: 'dependabot[bot]',
    }).errors,
    []
  ));
test('large PRs get a warning, not an error', () => {
  const r = checkPullRequest({ ...good, changedLines: 4000 });
  assert.deepStrictEqual(r.errors, []);
  assert.match(r.warnings.join(), /4000 lines/);
});
test('comment lists numbered fixes and the marker', () => {
  const c = renderComment(checkPullRequest({ ...good, title: 'oops' }));
  assert.match(c, /<!-- pr-policy -->/);
  assert.match(c, /1\. Title/);
});

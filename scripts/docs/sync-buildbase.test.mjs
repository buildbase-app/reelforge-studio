// Unit tests of the docs sync against an in-memory fake of the BuildBase docs
// API. Run: pnpm test:docs (node --test, no dependencies).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDesiredDocs,
  excludeSections,
  parseFrontMatter,
  rewriteLinks,
  summarize,
  syncDocs,
} from './sync-lib.mjs';
import { checkTokenEnvironment, createDocsApi } from './sync-buildbase.mjs';

/**
 * A fake of the org API's docs routes with the rules the sync relies on: a
 * new page is an unpublished draft with a random slug, a published page keeps
 * its slug and folder, the list includes drafts, nothing is ever deleted
 * unless DELETE is called (the sync never does).
 */
function fakeApi() {
  let n = 0;
  const newId = () => String(++n).padStart(24, '0');
  const state = { folders: [], tags: [], docs: [], writes: [] };
  const write = (op, detail) => state.writes.push([op, detail]);
  return {
    state,
    async listFolders() {
      return structuredClone(state.folders);
    },
    async createFolder({ name, slug, parentFolder }) {
      if (state.folders.some((f) => f.slug === slug && (f.parentFolder ?? null) === (parentFolder ?? null))) throw new Error('409');
      const f = { _id: newId(), name, slug, parentFolder: parentFolder ?? null, archived: false };
      state.folders.push(f);
      write('createFolder', slug);
      return structuredClone(f);
    },
    async archiveFolder(id, archived) {
      state.folders.find((f) => f._id === id).archived = archived;
      write('archiveFolder', id);
    },
    async listTags() {
      return structuredClone(state.tags);
    },
    async createTag({ title, slug, public: isPublic = true }) {
      if (state.tags.some((t) => t.slug === slug || t.title === title)) throw new Error('409');
      const t = { _id: newId(), title, slug, public: isPublic, archived: false };
      state.tags.push(t);
      write('createTag', slug);
      return structuredClone(t);
    },
    async updateTag(id, { title, slug, public: isPublic }) {
      Object.assign(state.tags.find((t) => t._id === id), { title, slug, public: isPublic });
      write('updateTag', slug);
    },
    async archiveTag(id, archived) {
      state.tags.find((t) => t._id === id).archived = archived;
      write('archiveTag', id);
    },
    async listDocs() {
      return structuredClone(state.docs);
    },
    async createDoc(title) {
      const d = {
        _id: newId(),
        title,
        slug: `${title.toLowerCase().replace(/\W+/g, '-')}-x${n}`,
        description: title,
        content: 'Start writing here...',
        published: false,
        folder: null,
        tags: [],
        suggestedDocs: [],
        seo: { title, description: title, keywords: [] },
        deleted: false,
      };
      state.docs.push(d);
      write('createDoc', title);
      return structuredClone(d);
    },
    async updateDoc(id, patch) {
      const d = state.docs.find((x) => x._id === id);
      if (!d) throw new Error('404');
      if (d.published && ((patch.slug && patch.slug !== d.slug) || (patch.folder && patch.folder !== d.folder))) {
        throw new Error('published pages keep their slug and folder');
      }
      if (patch.slug && state.docs.some((x) => x !== d && x.slug === patch.slug)) throw new Error('409 Slug already exists');
      const next = structuredClone(patch);
      // Like the real API read with a token: only public tags are kept and shown.
      if (next.tags) next.tags = next.tags.filter((t) => state.tags.find((x) => x._id === t)?.public !== false);
      Object.assign(d, next);
      write('updateDoc', { id, fields: Object.keys(patch) });
      return structuredClone(d);
    },
  };
}

const OWNER = { slug: 'source-repo', title: 'Source: repository' };
const ARCHIVED = { slug: 'source-archived', title: 'Source: archived' };

function files(map) {
  return (rel) => {
    if (!(rel in map)) throw new Error('ENOENT');
    return map[rel];
  };
}

const FILES = {
  'docs/public/start/quick-start.md':
    '---\ntitle: "Quick start"\ndescription: "Run it."\nfolder: start\nslug: quick-start\norder: 1\ntags: [getting-started]\n---\n\n# Quick start\n\nSee [the API](../api/overview.md#errors) and [config](../../CONFIG.md).\n',
  'docs/public/start/agents.md': '---\ndescription: "Connect agents."\nfolder: start\norder: 2\n---\n# Connect an agent\n\nHello.\n',
  'docs/public/api/overview.md': '---\ntitle: API\ndescription: The REST API.\nfolder: api\nslug: overview\n---\n\nBody with `code [x](y.md)`.\n',
  'docs/PRIVACY.md': '# Privacy\n\nNo telemetry.\n\n## Test cases\n\ninternal table\n\n## Secrets\n\nHashed.\n',
};

const MANIFEST = {
  sitePrefix: '/docs',
  repoUrl: 'https://github.com/acme/repo/blob/main',
  folders: [
    { path: 'start', name: 'Quick start' },
    { path: 'api', name: 'REST API' },
    { path: 'privacy', name: 'Privacy' },
  ],
  docs: [
    'docs/public/start/quick-start.md',
    'docs/public/start/agents.md',
    'docs/public/api/overview.md',
    { file: 'docs/PRIVACY.md', folder: 'privacy', slug: 'egress', description: 'Egress.', excludeSections: ['Test cases'] },
  ],
};

const desiredFrom = (manifest = MANIFEST, map = FILES) => buildDesiredDocs(manifest, files(map));

describe('front matter and Markdown', () => {
  it('reads strings, numbers, booleans and inline lists', () => {
    const { data, body } = parseFrontMatter('---\na: "x: y"\nb: 3\nc: true\nd: [one, "two"]\ne: plain text\n---\nBody\n');
    assert.deepEqual(data, { a: 'x: y', b: 3, c: true, d: ['one', 'two'], e: 'plain text' });
    assert.equal(body, 'Body\n');
  });

  it('a file without front matter is all body', () => {
    assert.deepEqual(parseFrontMatter('# T\n'), { data: {}, body: '# T\n' });
  });

  it('excludes whole sections by heading, not text inside code blocks', () => {
    const out = excludeSections('a\n## Test cases\nx\n### sub\ny\n## Keep\n```\n## Test cases\n```\n', ['test cases']);
    assert.equal(out, 'a\n## Keep\n```\n## Test cases\n```\n');
  });

  it('rewrites repo links to site paths or GitHub, and leaves code alone', () => {
    const published = new Map([['docs/public/api/overview.md', 'api/overview']]);
    const opts = { sourceFile: 'docs/public/start/quick-start.md', published, sitePrefix: '/docs', repoUrl: 'https://gh/r/blob/main' };
    const md = [
      '[api](../api/overview.md#errors) [cfg](../../CONFIG.md) [ext](https://x.y/a.md) [top](#top) [site](/pricing)',
      '`[not](a.md)` ![img](../../img/a.png)',
      '```',
      '[inside](../api/overview.md)',
      '```',
      '[ref]: ../../LICENSE.md',
    ].join('\n');
    assert.equal(
      rewriteLinks(md, opts),
      [
        '[api](/docs/api/overview#errors) [cfg](https://gh/r/blob/main/docs/CONFIG.md) [ext](https://x.y/a.md) [top](#top) [site](/pricing)',
        '`[not](a.md)` ![img](https://gh/r/blob/main/docs/img/a.png?raw=true)',
        '```',
        '[inside](../api/overview.md)',
        '```',
        '[ref]: https://gh/r/blob/main/docs/LICENSE.md',
      ].join('\n')
    );
  });
});

describe('allowlist to desired pages', () => {
  it('maps front matter and manifest fields, strips the H1, rewrites links, orders by folder and order', () => {
    const { docs, folders } = desiredFrom();
    assert.deepEqual(
      docs.map((d) => d.path),
      ['start/quick-start', 'start/agents', 'api/overview', 'privacy/egress']
    );
    const qs = docs[0];
    assert.equal(qs.title, 'Quick start');
    assert.equal(qs.description, 'Run it.');
    assert.deepEqual(qs.tags, ['getting-started']);
    assert.ok(!qs.content.includes('# Quick start'));
    assert.ok(qs.content.includes('[the API](/docs/api/overview#errors)'));
    assert.ok(qs.content.includes('[config](https://github.com/acme/repo/blob/main/docs/CONFIG.md)'));
    assert.ok(qs.content.endsWith('in the ReelForge Studio repository._\n'));
    assert.equal(docs[1].title, 'Connect an agent');
    assert.equal(docs[1].slug, 'agents');
    assert.ok(!docs[3].content.includes('internal table'));
    assert.ok(docs[3].content.includes('Hashed.'));
    assert.deepEqual(
      folders.map((f) => [f.path, f.name]),
      [
        ['start', 'Quick start'],
        ['api', 'REST API'],
        ['privacy', 'Privacy'],
      ]
    );
  });

  it('reports every problem at once', () => {
    assert.throws(
      () =>
        desiredFrom({
          docs: ['missing.md', { file: 'docs/public/start/agents.md', slug: 'Bad Slug' }, { file: 'docs/PRIVACY.md' }],
        }),
      (e) => /missing\.md: listed in the allowlist but cannot be read/.test(e.message) && /Bad Slug/.test(e.message) && /needs a description/.test(e.message)
    );
  });

  it('refuses one slug in two folders', () => {
    assert.throws(
      () => desiredFrom({ docs: ['docs/public/api/overview.md', { file: 'docs/PRIVACY.md', path: 'privacy/overview', description: 'x y' }] }),
      /both use the slug "overview"/
    );
  });

  it('refuses two files publishing to one path', () => {
    assert.throws(
      () => desiredFrom({ docs: ['docs/public/start/agents.md', { file: 'docs/PRIVACY.md', path: 'start/agents', description: 'x y' }] }),
      /both publish to "start\/agents"/
    );
  });
});

describe('syncDocs', () => {
  const run = (api, desired, extra = {}) => syncDocs({ api, desired, ownerTag: OWNER, archivedTag: ARCHIVED, ...extra });

  it('creates folders, tags and published pages, then a second run changes nothing', async () => {
    const api = fakeApi();
    const first = await run(api, desiredFrom());
    assert.equal(first.changed, true);
    assert.deepEqual(first.folders.created, ['start', 'api', 'privacy']);
    assert.deepEqual(first.docs.created, ['start/quick-start', 'start/agents', 'api/overview', 'privacy/egress']);
    assert.ok(first.tags.created.includes('source-repo') && first.tags.created.includes('getting-started'));
    assert.equal(api.state.tags.find((t) => t.slug === 'source-repo').public, true);

    const qs = api.state.docs.find((d) => d.slug === 'quick-start');
    const start = api.state.folders.find((f) => f.slug === 'start');
    assert.equal(qs.published, true);
    assert.equal(qs.folder, start._id);
    assert.equal(qs.title, 'Quick start');
    assert.deepEqual(qs.seo, { title: 'Quick start', description: 'Run it.', keywords: [] });
    const agents = api.state.docs.find((d) => d.slug === 'agents');
    assert.deepEqual(qs.suggestedDocs, [agents._id], 'reading order: quick-start -> agents');
    assert.deepEqual(agents.suggestedDocs, []);

    const writes = api.state.writes.length;
    const second = await run(api, desiredFrom());
    assert.equal(second.changed, false);
    assert.equal(second.docs.unchanged.length, 4);
    assert.equal(api.state.writes.length, writes, 'no write on the second run');
    assert.match(summarize(second), /No changes/);
  });

  it('updates only the changed fields of an owned page', async () => {
    const api = fakeApi();
    await run(api, desiredFrom());
    const changed = { ...FILES, 'docs/public/api/overview.md': FILES['docs/public/api/overview.md'].replace('Body with', 'New body with') };
    const r = await run(api, desiredFrom(MANIFEST, changed));
    assert.deepEqual(r.docs.updated, [{ path: 'api/overview', fields: ['content'] }]);
  });

  it('archives (never deletes) a page whose file left the allowlist, and restores it when it comes back', async () => {
    const api = fakeApi();
    await run(api, desiredFrom());
    const fewer = { ...MANIFEST, docs: MANIFEST.docs.filter((d) => d !== 'docs/public/api/overview.md') };
    const r = await run(api, desiredFrom(fewer));
    assert.deepEqual(r.docs.archived, ['api/overview']);
    // The link to the removed page now points at the file on GitHub instead.
    assert.deepEqual(r.docs.updated, [{ path: 'start/quick-start', fields: ['content'] }]);
    const page = api.state.docs.find((d) => d.slug === 'overview');
    assert.equal(page.published, false);
    const archivedTag = api.state.tags.find((t) => t.slug === 'source-archived');
    assert.ok(page.tags.includes(archivedTag._id));
    assert.equal(api.state.docs.length, 4, 'nothing deleted');

    const again = await run(api, desiredFrom(fewer));
    assert.equal(again.changed, false, 'an archived page stays archived without writes');

    const back = await run(api, desiredFrom());
    // quick-start links to the API page: its link goes back from GitHub to the site.
    assert.deepEqual(back.docs.updated, [
      { path: 'start/quick-start', fields: ['content'] },
      { path: 'api/overview', fields: ['tags', 'published'] },
    ]);
    const restored = api.state.docs.find((d) => d.slug === 'overview');
    assert.equal(restored.published, true);
    assert.ok(!restored.tags.includes(archivedTag._id));
  });

  it('never touches pages it did not create, and reports a conflict at a wanted path', async () => {
    const api = fakeApi();
    const folder = await api.createFolder({ name: 'REST API', slug: 'api' });
    const cms = await api.createDoc('Marketing guide');
    await api.updateDoc(cms._id, { slug: 'overview', folder: folder._id, published: true, content: 'Written in the console' });
    const other = await api.createDoc('Another CMS page');
    await api.updateDoc(other._id, { slug: 'guide', published: true });
    const before = structuredClone(api.state.docs);

    const r = await run(api, desiredFrom());
    assert.deepEqual(r.docs.conflicts, ['api/overview']);
    assert.match(summarize(r), /Conflicts/);
    for (const d of before) assert.deepEqual(api.state.docs.find((x) => x._id === d._id), d, `page ${d.slug} untouched`);
    assert.equal(api.state.folders.filter((f) => f.slug === 'api').length, 1, 'the existing folder is reused');
  });

  it('restores an archived folder instead of creating a duplicate', async () => {
    const api = fakeApi();
    const f = await api.createFolder({ name: 'Quick start', slug: 'start' });
    await api.archiveFolder(f._id, true);
    const r = await run(api, desiredFrom());
    assert.deepEqual(r.folders.restored, ['start']);
    assert.equal(api.state.folders.filter((x) => x.slug === 'start').length, 1);
  });

  it('makes a private bookkeeping tag public, since private tags are invisible to an API token', async () => {
    const api = fakeApi();
    await api.createTag({ title: 'Source: repository', slug: 'source-repo', public: false });
    const r = await run(api, desiredFrom());
    assert.deepEqual(r.tags.madePublic, ['source-repo']);
    assert.equal((await run(api, desiredFrom())).changed, false);
  });

  it('moves its own page to another folder (slugs are unique across folders)', async () => {
    const api = fakeApi();
    await run(api, desiredFrom());
    const manifest = {
      ...MANIFEST,
      docs: MANIFEST.docs.map((d) => (d === 'docs/public/start/agents.md' ? { file: d, folder: 'api' } : d)),
    };
    const r = await run(api, desiredFrom(manifest));
    assert.deepEqual(r.docs.updated.find((u) => u.path === 'api/agents'), { path: 'api/agents', fields: ['folder'], from: 'start/agents' });
    assert.deepEqual(r.docs.archived, []);
    assert.deepEqual(r.docs.created, []);
    const page = api.state.docs.find((d) => d.slug === 'agents');
    assert.equal(page.folder, api.state.folders.find((f) => f.slug === 'api')._id);
    assert.equal(page.published, true);
    assert.equal(api.state.docs.length, 4);
    assert.equal((await run(api, desiredFrom(manifest))).changed, false);
  });

  it('reports a conflict when a page created elsewhere holds the slug in another folder', async () => {
    const api = fakeApi();
    const cms = await api.createDoc('Overview');
    await api.updateDoc(cms._id, { slug: 'overview', published: true });
    const r = await run(api, desiredFrom());
    assert.deepEqual(r.docs.conflicts, ['api/overview']);
    assert.equal(api.state.docs.find((d) => d._id === cms._id).content, 'Start writing here...');
  });

  it('marks a draft it could not place as its own and archived, then fails loudly', async () => {
    const api = fakeApi();
    const update = api.updateDoc;
    let calls = 0;
    api.updateDoc = async (id, patch) => {
      if (patch.slug && ++calls === 2) throw new Error('boom');
      return update(id, patch);
    };
    await assert.rejects(() => run(api, desiredFrom()), /could not be placed: boom/);
    api.updateDoc = update;
    const orphan = api.state.docs.find((d) => d.slug.includes('-x'));
    const tagSlugs = orphan.tags.map((t) => api.state.tags.find((x) => x._id === t).slug).sort();
    assert.deepEqual(tagSlugs, ['source-archived', 'source-repo']);
    const r = await run(api, desiredFrom());
    assert.equal(r.docs.conflicts.length, 0);
    assert.ok(!r.docs.archived.includes(orphan.slug), 'already archived: left alone');
  });

  it('--dry-run writes nothing and reports what it would do', async () => {
    const api = fakeApi();
    const r = await run(api, desiredFrom(), { dryRun: true });
    assert.equal(api.state.writes.length, 0);
    assert.equal(r.docs.created.length, 4);
    assert.match(summarize(r), /4 would be created/);
  });

  it('handles nested folders', async () => {
    const api = fakeApi();
    const map = { 'a.md': '---\ntitle: Deep\ndescription: Deep page\npath: guides/advanced/deep\n---\nx\n' };
    await run(api, desiredFrom({ docs: ['a.md'] }, map));
    const advanced = api.state.folders.find((f) => f.slug === 'advanced');
    const guides = api.state.folders.find((f) => f.slug === 'guides');
    assert.equal(advanced.parentFolder, guides._id);
    assert.equal(api.state.docs[0].folder, advanced._id);
    assert.equal((await run(api, desiredFrom({ docs: ['a.md'] }, map))).changed, false);
  });
});

describe('credentials and HTTP', () => {
  it('checks that the token belongs to the named environment', () => {
    assert.equal(checkTokenEnvironment('org1-abcdefgh:s3cret', 'abcdefgh'), 'org1');
    assert.equal(checkTokenEnvironment('org1:s3cret', 'production'), 'org1');
    assert.throws(() => checkTokenEnvironment('org1:s3cret', 'abcdefgh'), /belongs to the environment "production"/);
    assert.throws(() => checkTokenEnvironment('org1-abcdefgh:s3cret', 'production'), /"abcdefgh"/);
    assert.throws(() => checkTokenEnvironment('org1-abcdefgh:s3cret', 'abcdefgh', 'org2'), /not BUILDBASE_ORG_ID org2/);
    assert.throws(() => checkTokenEnvironment('nocolon', 'production'), /form/);
    try {
      checkTokenEnvironment('org1:s3cret', 'abcdefgh');
    } catch (e) {
      assert.ok(!e.message.includes('s3cret'), 'never echoes the secret');
    }
  });

  it('sends the bearer token, pages lists, unwraps data and refuses success:false', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const u = new URL(url);
      if (u.pathname === '/api/docs' && init.method === 'GET') {
        const page = Number(u.searchParams.get('$page'));
        return new Response(JSON.stringify({ docs: [{ _id: String(page) }], hasNextPage: page < 2 }), { status: 200 });
      }
      if (u.pathname === '/api/docs/folders') return new Response(JSON.stringify({ success: true, data: { _id: 'f1' } }), { status: 200 });
      return new Response(JSON.stringify({ success: false, message: 'slug is fixed' }), { status: 200 });
    };
    const api = createDocsApi({ serverUrl: 'https://bb.test/', token: 'org-env:secret', fetchImpl });
    assert.deepEqual((await api.listDocs()).map((d) => d._id), ['1', '2']);
    assert.ok(calls[0].url.includes('draftPreview=true'));
    assert.equal(calls[0].init.headers.Authorization, 'Bearer org-env:secret');
    assert.deepEqual(await api.createFolder({ name: 'A', slug: 'aa' }), { _id: 'f1' });
    await assert.rejects(() => api.updateDoc('x', { slug: 'y' }), /saved nothing \(slug is fixed\)/);
  });

  it('does not retry a POST that may have run, but retries a GET', async () => {
    let posts = 0;
    let gets = 0;
    const fetchImpl = async (url, init) => {
      if (init.method === 'POST') {
        posts++;
        return new Response('oops', { status: 502 });
      }
      gets++;
      return gets < 2 ? new Response('busy', { status: 503 }) : new Response(JSON.stringify({ docs: [], hasNextPage: false }), { status: 200 });
    };
    const api = createDocsApi({ token: 'o:s', fetchImpl });
    await assert.rejects(() => api.createDoc('Title'), /HTTP 502/);
    assert.equal(posts, 1);
    assert.deepEqual(await api.listTags(), []);
    assert.equal(gets, 2);
  });
});

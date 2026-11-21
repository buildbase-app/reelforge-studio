// Pure logic of the repo -> BuildBase Docs sync (scripts/docs/sync-buildbase.mjs):
// reading the allowlist and front matter, turning Markdown files into the doc
// pages they should be, and planning and applying the changes against an API
// object. No network or file access of its own beyond what callers pass in, so
// sync-buildbase.test.mjs runs it against an in-memory fake of the API.
//
// Decisions: docs/DECISIONS.md D-080..D-082. How to run: docs/DOCS_PUBLISHING.md.

import { posix } from 'node:path';

// ---------------------------------------------------------------------------
// Front matter (a small YAML subset: `key: value`, quoted strings, numbers,
// booleans and inline lists `[a, b]`). Enough for docs metadata, no dependency.
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v);
      } catch {
        return v.slice(1, -1);
      }
    }
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => parseScalar(s));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Splits `---` front matter from a Markdown file. */
export function parseFrontMatter(text) {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: src };
  const block = src.slice(4, end);
  const rest = src.slice(end + 4).replace(/^[^\n]*\n/, '');
  const data = {};
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) throw new Error(`front matter: cannot read the line "${line}"`);
    data[m[1]] = parseScalar(m[2]);
  }
  return { data, body: rest };
}

// ---------------------------------------------------------------------------
// Markdown transforms
// ---------------------------------------------------------------------------

/** Removes `## Heading` sections (up to the next heading of the same or a higher level). */
export function excludeSections(body, titles) {
  if (!titles?.length) return body;
  const wanted = new Set(titles.map((t) => t.trim().toLowerCase()));
  const out = [];
  let skipLevel = 0;
  let fence = null;
  for (const line of body.split('\n')) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1];
    const h = !fence && !f ? line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/) : null;
    if (h) {
      const level = h[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && wanted.has(h[2].toLowerCase())) {
        skipLevel = level;
        continue;
      }
    }
    if (!skipLevel) out.push(line);
  }
  return out.join('\n');
}

/** Takes the first `# Title` line off the body (the site shows the title itself). */
export function stripLeadingH1(body) {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^<!--.*-->$/.test(lines[i].trim()))) i++;
  const m = lines[i]?.match(/^#\s+(.+?)\s*#*\s*$/);
  if (!m) return { title: null, body };
  lines.splice(i, 1);
  return { title: m[1], body: lines.join('\n') };
}

/** Drops whole-line HTML comments (generator notes); they mean nothing on the site. */
export function stripCommentLines(body) {
  return body
    .split('\n')
    .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
    .join('\n');
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Rewrites repo-relative links: to the doc's site path when the target is
 * published too, otherwise to the file in the repository on GitHub. Absolute
 * URLs, site paths (`/...`) and anchors are kept. Code blocks and code spans
 * are left alone.
 */
export function rewriteLinks(body, { sourceFile, published, sitePrefix, repoUrl }) {
  const dir = posix.dirname(sourceFile);
  const map = (target, image) => {
    if (!target || target.startsWith('#') || target.startsWith('/') || SCHEME.test(target)) return target;
    const hashAt = target.indexOf('#');
    const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
    const hash = hashAt === -1 ? '' : target.slice(hashAt);
    const resolved = posix.normalize(posix.join(dir, decodeURI(pathPart)));
    if (resolved.startsWith('..')) return target;
    const docPath = published.get(resolved);
    if (docPath && !image) return `${sitePrefix}/${docPath}${hash}`;
    if (!repoUrl) return target;
    return `${repoUrl}/${encodeURI(resolved)}${image ? '?raw=true' : ''}${hash}`;
  };
  const inline = (segment) =>
    segment.replace(/(!?)\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^>]+>|[^)\s]+)(\s+"[^"]*")?\s*\)/g, (all, bang, text, rawTarget, title = '') => {
      const angled = rawTarget.startsWith('<');
      const target = angled ? rawTarget.slice(1, -1) : rawTarget;
      const next = map(target, bang === '!');
      return `${bang}[${text}](${angled ? `<${next}>` : next}${title})`;
    });
  let fence = null;
  return body
    .split('\n')
    .map((line) => {
      const f = line.match(/^\s*(```+|~~~+)/);
      if (f) {
        fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1];
        return line;
      }
      if (fence) return line;
      const def = line.match(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)(.*)$/);
      if (def) return `${def[1]}${map(def[2], false)}${def[3]}`;
      // Only outside `code spans`: even segments of a split on backticks.
      return line
        .split(/(`+[^`]*`+)/)
        .map((seg, i) => (i % 2 === 0 ? inline(seg) : seg))
        .join('');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Allowlist -> desired pages
// ---------------------------------------------------------------------------

export const SLUG = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const asList = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

/**
 * Reads the allowlist and every file it names (through `readFile(relPath)`),
 * and returns the pages BuildBase Docs should hold, sorted by folder and
 * order. Throws one error listing every problem.
 */
export function buildDesiredDocs(manifest, readFile) {
  const problems = [];
  const sitePrefix = (manifest.sitePrefix ?? '/docs').replace(/\/$/, '');
  const repoUrl = manifest.repoUrl ? manifest.repoUrl.replace(/\/$/, '') : null;
  const folderNames = new Map((manifest.folders ?? []).map((f) => [f.path, f.name]));
  const folderOrder = new Map((manifest.folders ?? []).map((f, i) => [f.path, i]));

  const entries = (manifest.docs ?? []).map((e) => (typeof e === 'string' ? { file: e } : { ...e }));
  const items = [];
  for (const entry of entries) {
    if (!entry.file) {
      problems.push('an allowlist entry has no "file"');
      continue;
    }
    let text;
    try {
      text = readFile(entry.file);
    } catch {
      problems.push(`${entry.file}: listed in the allowlist but cannot be read`);
      continue;
    }
    let parsed;
    try {
      parsed = parseFrontMatter(text);
    } catch (e) {
      problems.push(`${entry.file}: ${e.message}`);
      continue;
    }
    const { file, excludeSections: exclude, ...overrides } = entry;
    const meta = { ...parsed.data, ...overrides };
    let folder = meta.folder ?? null;
    let slug = meta.slug ?? null;
    if (meta.path) {
      const parts = String(meta.path).split('/').filter(Boolean);
      slug = parts.pop() ?? slug;
      folder = parts.length ? parts.join('/') : folder;
    }
    if (!slug) slug = posix.basename(file, posix.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!SLUG.test(slug)) problems.push(`${file}: slug "${slug}" must be lowercase letters, digits and dashes (2+ characters)`);
    if (folder !== null) {
      folder = String(folder).replace(/^\/|\/$/g, '');
      for (const seg of folder.split('/')) {
        if (!SLUG.test(seg)) problems.push(`${file}: folder "${folder}" has an invalid segment "${seg}"`);
      }
    }
    const body = excludeSections(parsed.body, asList(exclude ?? meta.excludeSections));
    const { title: h1, body: withoutH1 } = stripLeadingH1(body);
    const title = String(meta.title ?? h1 ?? '').trim();
    const description = String(meta.description ?? '').trim();
    if (title.length < 2) problems.push(`${file}: needs a title (front matter "title" or a leading "# " heading)`);
    if (description.length < 2) problems.push(`${file}: needs a description (front matter "description")`);
    const tags = asList(meta.tags).map((t) => String(t).trim().toLowerCase());
    for (const t of tags) if (!SLUG.test(t)) problems.push(`${file}: tag "${t}" must be lowercase letters, digits and dashes`);
    items.push({
      file,
      folder,
      slug,
      path: folder ? `${folder}/${slug}` : slug,
      title,
      description,
      tags,
      keywords: asList(meta.keywords).map(String),
      order: typeof meta.order === 'number' ? meta.order : Number.POSITIVE_INFINITY,
      body: withoutH1,
    });
  }

  const seen = new Map();
  const slugs = new Map();
  for (const it of items) {
    if (seen.has(it.path)) problems.push(`${it.file} and ${seen.get(it.path)} both publish to "${it.path}"`);
    else if (slugs.has(it.slug)) {
      // BuildBase keeps doc slugs unique across all folders (409 "Slug already exists").
      problems.push(`${it.file} and ${slugs.get(it.slug)} both use the slug "${it.slug}"; slugs must be unique across all folders`);
    }
    seen.set(it.path, it.file);
    slugs.set(it.slug, it.file);
  }
  if (problems.length) throw new Error(`The docs allowlist has problems:\n- ${problems.join('\n- ')}`);

  const published = new Map(items.map((it) => [posix.normalize(it.file), it.path]));
  const footer = (file) =>
    repoUrl
      ? `\n\n---\n\nPublished from [\`${file}\`](${repoUrl}/${encodeURI(file)}) in the ReelForge Studio repository.\n`
      : '\n';
  const docs = items.map((it) => {
    const linked = rewriteLinks(stripCommentLines(it.body), { sourceFile: it.file, published, sitePrefix, repoUrl });
    const content = `${linked.replace(/^\s+/, '').replace(/\s+$/, '')}${footer(it.file)}`;
    const { body, ...rest } = it;
    return { ...rest, content };
  });

  const rank = (f) => (f === null ? -1 : folderOrder.get(f.split('/')[0]) ?? Number.MAX_SAFE_INTEGER);
  docs.sort(
    (a, b) =>
      rank(a.folder) - rank(b.folder) ||
      String(a.folder).localeCompare(String(b.folder)) ||
      a.order - b.order ||
      a.title.localeCompare(b.title)
  );

  // Every folder a page needs, parents first, with its display name.
  const folders = [];
  for (const d of docs) {
    if (!d.folder) continue;
    const segs = d.folder.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const path = segs.slice(0, i).join('/');
      if (!folders.some((f) => f.path === path)) {
        folders.push({ path, slug: segs[i - 1], name: folderNames.get(path) ?? titleCase(segs[i - 1]) });
      }
    }
  }
  return { docs, folders, sitePrefix };
}

function titleCase(slug) {
  return slug.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Remote state helpers
// ---------------------------------------------------------------------------

const idOf = (v) => (v && typeof v === 'object' ? String(v._id ?? v.id ?? '') : v ? String(v) : null);
const ids = (list) => [...new Set((list ?? []).map(idOf).filter(Boolean))].sort();

/** Each folder's path, from the chain of parent slugs (the stored path is not rebuilt on a move). */
export function folderPaths(folders) {
  const byId = new Map(folders.map((f) => [idOf(f), f]));
  const memo = new Map();
  const pathOf = (f, depth = 0) => {
    const id = idOf(f);
    if (memo.has(id)) return memo.get(id);
    const parent = f.parentFolder ? byId.get(idOf(f.parentFolder)) : null;
    const p = parent && depth < 20 ? `${pathOf(parent, depth + 1)}/${f.slug}` : f.slug;
    memo.set(id, p);
    return p;
  };
  return new Map(folders.map((f) => [idOf(f), pathOf(f)]));
}

/** The fields the sync owns, read from a page as the API returns it. */
export function remoteFields(doc) {
  return {
    title: doc.title ?? '',
    description: doc.description ?? '',
    content: doc.content ?? '',
    tags: ids(doc.tags),
    published: Boolean(doc.published),
    seo: {
      title: doc.seo?.title ?? '',
      description: doc.seo?.description ?? '',
      keywords: [...(doc.seo?.keywords ?? [])],
    },
    suggestedDocs: ids(doc.suggestedDocs),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The PATCH body that turns `current` into `wanted` (only the changed fields), or null. */
export function diffFields(current, wanted) {
  const patch = {};
  for (const key of Object.keys(wanted)) {
    if (!same(current[key], wanted[key])) patch[key] = wanted[key];
  }
  return Object.keys(patch).length ? patch : null;
}

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

/**
 * Makes BuildBase Docs match the desired pages.
 *
 * `api` has: listFolders, createFolder({name, slug, parentFolder}),
 * archiveFolder(id, archived), listTags, createTag({title, slug, public}),
 * updateTag(id, {title, slug, public}), archiveTag(id, archived), listDocs (drafts included), createDoc(title) and
 * updateDoc(id, patch). Each returns what the API answers.
 *
 * Rules (D-081): pages are matched by path (folder path + slug); only pages
 * carrying the owner tag are ever changed; a page at a wanted path without it
 * is a conflict and is left alone; an owned page whose source left the
 * allowlist is archived (unpublished and tagged), never deleted; folders and
 * tags are created when missing and restored when archived, never removed.
 * With `dryRun` nothing is written and the result says what would change.
 */
export async function syncDocs({ api, desired, ownerTag, archivedTag, dryRun = false, log = () => {} }) {
  const result = {
    dryRun,
    folders: { created: [], restored: [] },
    tags: { created: [], restored: [], madePublic: [] },
    docs: { created: [], updated: [], unchanged: [], archived: [], conflicts: [] },
  };

  // Folders.
  const remoteFolders = await api.listFolders();
  const paths = folderPaths(remoteFolders);
  const folderIdByPath = new Map();
  for (const f of [...remoteFolders].sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)))) {
    const p = paths.get(idOf(f));
    if (!folderIdByPath.has(p)) folderIdByPath.set(p, { id: idOf(f), archived: Boolean(f.archived) });
  }
  for (const f of desired.folders) {
    const parentPath = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : null;
    const known = folderIdByPath.get(f.path);
    if (known && !known.archived) continue;
    if (known?.archived) {
      result.folders.restored.push(f.path);
      log(`folder ${f.path}: restore`);
      if (!dryRun) await api.archiveFolder(known.id, false);
      folderIdByPath.set(f.path, { id: known.id, archived: false });
      continue;
    }
    result.folders.created.push(f.path);
    log(`folder ${f.path}: create`);
    if (dryRun) {
      folderIdByPath.set(f.path, { id: `new-folder:${f.path}`, archived: false });
      continue;
    }
    const parent = parentPath ? folderIdByPath.get(parentPath)?.id : undefined;
    const created = await api.createFolder({ name: f.name, slug: f.slug, ...(parent ? { parentFolder: parent } : {}) });
    folderIdByPath.set(f.path, { id: idOf(created), archived: false });
  }

  // Tags: the two bookkeeping tags plus every tag a page uses. All public: a page
  // read with an API token shows (and keeps) only its public tags, so a private
  // ownership tag would be invisible to the next run. The site hides `source-*`.
  const remoteTags = await api.listTags();
  const tagIdBySlug = new Map();
  const wantedTags = [
    { slug: ownerTag.slug, title: ownerTag.title },
    { slug: archivedTag.slug, title: archivedTag.title },
    ...[...new Set(desired.docs.flatMap((d) => d.tags))].map((slug) => ({ slug, title: slug })),
  ];
  for (const t of wantedTags) {
    if (tagIdBySlug.has(t.slug)) continue;
    const found = remoteTags.find((r) => r.slug === t.slug && !r.archived) ?? remoteTags.find((r) => r.slug === t.slug);
    if (found) {
      if (found.archived) {
        result.tags.restored.push(t.slug);
        log(`tag ${t.slug}: restore`);
        if (!dryRun) await api.archiveTag(idOf(found), false);
      }
      if (found.public === false) {
        result.tags.madePublic.push(t.slug);
        log(`tag ${t.slug}: make public (private tags are not visible to the sync)`);
        if (!dryRun) await api.updateTag(idOf(found), { title: found.title, slug: found.slug, public: true });
      }
      tagIdBySlug.set(t.slug, idOf(found));
      continue;
    }
    result.tags.created.push(t.slug);
    log(`tag ${t.slug}: create`);
    if (dryRun) {
      tagIdBySlug.set(t.slug, `new-tag:${t.slug}`);
      continue;
    }
    const created = await api.createTag({ title: t.title, slug: t.slug, public: true });
    tagIdBySlug.set(t.slug, idOf(created));
  }
  const ownerId = tagIdBySlug.get(ownerTag.slug);
  const archivedId = tagIdBySlug.get(archivedTag.slug);

  // Pages, matched by path.
  const remoteDocs = (await api.listDocs()).filter((d) => !d.deleted);
  const folderPathById = new Map([...folderIdByPath].map(([p, v]) => [v.id, p]));
  for (const [id, p] of paths) if (!folderPathById.has(id)) folderPathById.set(id, p);
  const pathOfDoc = (d) => {
    const fid = idOf(d.folder);
    const fp = fid ? folderPathById.get(fid) : null;
    if (fid && !fp) return null; // in a folder we cannot see: never ours to match
    return fp ? `${fp}/${d.slug}` : d.slug;
  };
  const owned = (d) => ids(d.tags).includes(ownerId);
  const byPath = new Map();
  for (const d of remoteDocs) {
    const p = pathOfDoc(d);
    if (!p) continue;
    const list = byPath.get(p) ?? [];
    list.push(d);
    byPath.set(p, list);
  }

  // 1. Find or create a page for every wanted path, so every page has an id.
  //    Slugs are unique across all folders, so a wanted slug held by a page at
  //    another path is either our own page that moved folder (moved here) or a
  //    conflict.
  const wantedPaths = new Set(desired.docs.map((d) => d.path));
  const pageFor = new Map();
  const moved = new Set();
  for (const d of desired.docs) {
    const atPath = byPath.get(d.path) ?? [];
    const mine = atPath.find(owned);
    if (mine) {
      pageFor.set(d.path, { id: idOf(mine), current: mine, isNew: false });
      continue;
    }
    if (atPath.length) {
      result.docs.conflicts.push(d.path);
      log(`page ${d.path}: CONFLICT, a page created elsewhere already has this path; left alone`);
      continue;
    }
    const holder = remoteDocs.find((r) => r.slug === d.slug);
    if (holder) {
      const from = pathOfDoc(holder);
      if (owned(holder) && from && !wantedPaths.has(from) && d.folder) {
        result.docs.updated.push({ path: d.path, fields: ['folder'], from });
        log(`page ${d.path}: move from ${from}`);
        moved.add(idOf(holder));
        if (!dryRun) {
          // A published page keeps its folder: unpublish, move, then step 2 republishes.
          if (holder.published) await api.updateDoc(idOf(holder), { published: false });
          const placed = await api.updateDoc(idOf(holder), { folder: folderIdByPath.get(d.folder).id });
          pageFor.set(d.path, { id: idOf(holder), current: placed ?? holder, isNew: true });
        } else {
          pageFor.set(d.path, { id: idOf(holder), current: null, isNew: true });
        }
        continue;
      }
      result.docs.conflicts.push(d.path);
      log(`page ${d.path}: CONFLICT, the slug "${d.slug}" is used by ${owned(holder) ? 'another wanted page' : 'a page created elsewhere'} (${from ?? 'in a folder this sync cannot see'})`);
      continue;
    }
    result.docs.created.push(d.path);
    log(`page ${d.path}: create`);
    if (dryRun) {
      pageFor.set(d.path, { id: `new-page:${d.path}`, current: null, isNew: true });
      continue;
    }
    const created = await api.createDoc(d.title);
    const id = idOf(created);
    try {
      // Slug and folder must be set while the page is a draft (a published page keeps both).
      const placed = await api.updateDoc(id, {
        slug: d.slug,
        ...(d.folder ? { folder: folderIdByPath.get(d.folder).id } : {}),
        tags: [ownerId],
      });
      pageFor.set(d.path, { id, current: placed ?? created, isNew: true });
    } catch (e) {
      // Leave no anonymous draft behind: mark it ours and archived, so a later
      // run recognises it and leaves it alone, and a person can find it.
      await api.updateDoc(id, { tags: [ownerId, archivedId] }).catch(() => {});
      throw new Error(`page ${d.path}: created as draft ${id} but could not be placed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2. Bring every page to its wanted fields. `suggestedDocs` links each page to
  //    the next one in its folder: that is the reading order the site follows.
  const inFolder = new Map();
  for (const d of desired.docs) {
    if (!pageFor.has(d.path)) continue;
    const key = d.folder ?? '';
    inFolder.set(key, [...(inFolder.get(key) ?? []), d]);
  }
  for (const d of desired.docs) {
    const page = pageFor.get(d.path);
    if (!page) continue;
    const siblings = inFolder.get(d.folder ?? '');
    const next = siblings[siblings.indexOf(d) + 1];
    const wanted = {
      title: d.title,
      description: d.description,
      content: d.content,
      tags: ids([ownerId, ...d.tags.map((t) => tagIdBySlug.get(t))]),
      published: true,
      seo: { title: d.title, description: d.description, keywords: d.keywords },
      suggestedDocs: next ? [pageFor.get(next.path).id] : [],
    };
    const patch = page.current ? diffFields(remoteFields(page.current), wanted) : wanted;
    if (!patch) {
      result.docs.unchanged.push(d.path);
      continue;
    }
    if (!page.isNew) {
      result.docs.updated.push({ path: d.path, fields: Object.keys(patch) });
      log(`page ${d.path}: update ${Object.keys(patch).join(', ')}`);
    }
    if (!dryRun) await api.updateDoc(page.id, patch);
  }

  // 3. Archive owned pages whose source left the allowlist: unpublish and tag.
  for (const [p, list] of byPath) {
    if (wantedPaths.has(p)) continue;
    for (const d of list.filter((x) => owned(x) && !moved.has(idOf(x)))) {
      const tags = ids(d.tags);
      if (!d.published && tags.includes(archivedId)) continue;
      result.docs.archived.push(p);
      log(`page ${p}: archive (its source is no longer in the allowlist)`);
      if (!dryRun) await api.updateDoc(idOf(d), { published: false, tags: ids([...tags, archivedId]) });
    }
  }

  result.changed =
    result.folders.created.length +
      result.folders.restored.length +
      result.tags.created.length +
      result.tags.restored.length +
      result.tags.madePublic.length +
      result.docs.created.length +
      result.docs.updated.length +
      result.docs.archived.length >
    0;
  return result;
}

/** A short human summary of a sync result. */
export function summarize(r) {
  const n = (a) => a.length;
  const verb = r.dryRun ? 'would be ' : '';
  const lines = [
    `Pages: ${n(r.docs.created)} ${verb}created, ${n(r.docs.updated)} ${verb}updated, ${n(r.docs.archived)} ${verb}archived, ${n(r.docs.unchanged)} unchanged, ${n(r.docs.conflicts)} conflicts.`,
    `Folders: ${n(r.folders.created)} ${verb}created, ${n(r.folders.restored)} ${verb}restored. Tags: ${n(r.tags.created)} ${verb}created, ${n(r.tags.restored)} ${verb}restored.`,
  ];
  if (!r.changed) lines.push('No changes: BuildBase Docs already match the repository.');
  if (n(r.docs.conflicts)) {
    lines.push(`Conflicts (pages at these paths were not created by this sync; rename one side): ${r.docs.conflicts.join(', ')}`);
  }
  return lines.join('\n');
}

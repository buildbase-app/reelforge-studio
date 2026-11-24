import { HttpError, sameOriginLink, type ProjectSummary, type RenderManifest, type RenderSummary } from '../api';
import { fill, h, notice, tableWrap } from '../dom';
import { ago, clock, dateTime, duration, outputFormat, playerKind, size } from '../format';
import type { Ctx, View } from '../main';

const CHECK_LABEL: Record<string, string> = {
  metadata: 'Metadata matches the manifest',
  decode: 'Decodes from start to end',
  duration: 'Length matches the timeline',
  timestamps: 'Timestamps are continuous',
  avDuration: 'Audio and video end together',
  captions: 'Captions meet the reading rules',
  alpha: 'Alpha channel present',
  size: 'Within the GIF size limit',
  entries: 'One PNG per frame in the zip',
  pngHeaders: 'Frame size and colour type match',
  audio: 'Audio codec and length match',
};

function format(r: Pick<RenderSummary, 'width' | 'height' | 'fps' | 'durationSeconds' | 'format' | 'codec' | 'alpha'>): string {
  if (playerKind(r.format) === 'audio') return `${outputFormat(r)} · ${r.durationSeconds.toFixed(1)} s`;
  return `${outputFormat(r)} · ${size(r.width, r.height)} · ${r.fps} fps · ${r.durationSeconds.toFixed(1)} s`;
}

function kindLabel(kind: string): string {
  return kind === 'preview' ? 'Preview' : 'Render';
}

/** Loads posters a few at a time with the key (an <img> cannot send it), into object URLs revoked on leave. */
function posterLoader(ctx: Ctx, signal: AbortSignal, urls: string[]) {
  const queue: Array<() => Promise<void>> = [];
  let active = 0;
  const next = () => {
    while (active < 3 && queue.length && !signal.aborted) {
      const job = queue.shift()!;
      active++;
      void job().finally(() => {
        active--;
        next();
      });
    }
  };
  return (renderId: string, img: HTMLImageElement) => {
    queue.push(async () => {
      try {
        const url = await ctx.api.objectUrl(`/v1/renders/${encodeURIComponent(renderId)}/output?file=poster.png`, signal);
        urls.push(url);
        img.src = url;
      } catch {
        img.alt = `No poster for ${renderId}`;
      }
    });
    next();
  };
}

/** #/library and #/library/:projectId: projects, and the renders of the chosen one. */
export const libraryView: View = (ctx, main, projectId) => {
  const ac = new AbortController();
  const urls: string[] = [];
  const poster = posterLoader(ctx, ac.signal, urls);
  const list = h('ul', { class: 'projects' });
  const more = h('div');
  const pane = h('section', { class: 'renders-pane', 'aria-labelledby': 'project-h' });
  fill(
    main,
    h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Library')),
    h('div', { class: 'library' }, h('nav', { class: 'projects-pane panel', 'aria-label': 'Projects' }, h('h2', { class: 'pane-h' }, 'Projects'), list, more), pane)
  );

  let selected = projectId;
  const projects: ProjectSummary[] = [];

  const showProjects = () => {
    const now = Date.now();
    fill(
      list,
      projects.map((p) =>
        h(
          'li',
          null,
          h(
            'a',
            { href: `#/library/${p.id}`, class: 'project', 'aria-current': p.id === selected ? 'page' : null },
            h('span', { class: 'project-title' }, p.title || p.id),
            h('span', { class: 'sub' }, `${p.scenes} ${p.scenes === 1 ? 'scene' : 'scenes'} · ${p.durationSeconds.toFixed(1)} s · updated ${ago(p.updatedAt, now)}`)
          )
        )
      )
    );
  };

  const loadProjects = async (cursor?: string) => {
    const page = await ctx.api.get<{ projects: ProjectSummary[]; nextCursor: string | null }>(`/v1/projects?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ac.signal);
    projects.push(...page.projects);
    showProjects();
    fill(more, page.nextCursor ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => void loadProjects(page.nextCursor!).catch(fail) }, 'Show more projects') : null);
  };

  const showRenders = async (pid: string) => {
    const p = projects.find((x) => x.id === pid);
    const heading = h('h2', { id: 'project-h' }, p?.title || pid);
    fill(pane, h('div', { class: 'pane-head' }, heading, h('span', { class: 'meta mono' }, pid)), h('p', { class: 'meta' }, 'Loading renders'));
    const { renders } = await ctx.api.get<{ renders: RenderSummary[] }>(`/v1/projects/${encodeURIComponent(pid)}/renders`, ac.signal);
    if (!renders.length) {
      fill(pane, h('div', { class: 'pane-head' }, heading, h('span', { class: 'meta mono' }, pid)), h('p', { class: 'empty' }, 'No renders of this project yet.'));
      return;
    }
    const now = Date.now();
    fill(
      pane,
      h('div', { class: 'pane-head' }, heading, h('span', { class: 'meta' }, `${renders.length} ${renders.length === 1 ? 'output' : 'outputs'}`)),
      h(
        'ul',
        { class: 'render-grid' },
        renders.map((r) => {
          const img = h('img', { alt: `First frame of ${r.renderId}`, width: r.width || 16, height: r.height || 9, loading: 'lazy', decoding: 'async' });
          if (r.posterUrl !== undefined || r.format === undefined) poster(r.renderId, img);
          else img.alt = `${outputFormat(r)}: no picture`;
          return h(
            'li',
            null,
            h(
              'a',
              { href: `#/renders/${r.renderId}`, class: 'render-card' },
              h('span', { class: 'thumb' }, img),
              h('span', { class: 'card-body' }, h('span', { class: 'card-title' }, kindLabel(r.kind), h('span', { class: 'mono sub' }, r.renderId)), h('span', { class: 'sub num' }, format(r)), h('span', { class: 'sub' }, ago(r.createdAt, now)))
            )
          );
        })
      )
    );
  };

  const fail = (e: unknown) => {
    if (ac.signal.aborted || ctx.authLost(e)) return;
    fill(pane, notice(`Could not load the library: ${(e as Error).message}`, 'error'));
  };

  void (async () => {
    await loadProjects();
    if (!projects.length) {
      fill(pane, h('h2', { id: 'project-h', class: 'sr-only' }, 'Renders'), h('p', { class: 'empty' }, 'No projects yet. Projects appear here when an agent or API client creates one.'));
      return;
    }
    selected ??= projects[0]!.id;
    showProjects();
    await showRenders(selected);
  })().catch(fail);

  return () => {
    ac.abort();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
};

/** #/renders/:id: player, format, checks, scenes, versions, storage and downloads of one render. */
export const renderView: View = (ctx, main, renderId) => {
  const id = renderId!;
  const ac = new AbortController();
  const urls: string[] = [];
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/library' }, 'Library'));
  const title = h('h1', { tabindex: '-1' }, 'Render');
  const sub = h('p', { class: 'meta' });
  const body = h('div', { class: 'render' }, h('p', { class: 'meta' }, 'Loading'));
  fill(main, crumbs, h('div', { class: 'page-head' }, h('div', null, title, sub)), body);

  const dl = (rows: Array<[string, Node | string]>) => h('dl', { class: 'facts' }, rows.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v))));
  const section = (heading: string, ...content: Array<Node | null>) => h('section', { class: 'panel' }, h('h2', null, heading), ...content);
  const wideSection = (heading: string, ...content: Array<Node | null>) => h('section', { class: 'panel wide-panel' }, h('h2', null, heading), ...content);

  const downloadManifest = (manifest: unknown) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
    urls.push(url);
    const a = h('a', { href: url, download: `${id}-render-manifest.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  void (async () => {
    const enc = encodeURIComponent(id);
    const [r, m] = await Promise.all([
      ctx.api.get<RenderSummary>(`/v1/renders/${enc}`, ac.signal),
      ctx.api.get<RenderManifest>(`/v1/renders/${enc}/output?file=render-manifest.json`, ac.signal),
    ]);
    const projectTitle = m.project?.title || r.projectId;
    title.textContent = projectTitle;
    document.title = `${projectTitle} · ReelForge Studio`;
    crumbs.append(h('a', { href: `#/library/${r.projectId}` }, projectTitle), h('span', { 'aria-current': 'page', class: 'mono' }, id));
    fill(sub, `${kindLabel(r.kind)} `, h('span', { class: 'mono' }, id), ` · ${dateTime(r.createdAt)}`);

    // The player follows the format (#302): video (MP4, MOV, WebM), the GIF itself, audio, or the poster of a PNG zip.
    const kind = playerKind(r.format);
    const label = `${kindLabel(r.kind)} of ${projectTitle}`;
    const video =
      kind === 'audio'
        ? h('audio', { controls: true, preload: 'metadata', 'aria-label': label })
        : kind === 'video'
          ? h('video', { controls: true, preload: 'metadata', playsinline: true, width: r.width, height: r.height, 'aria-label': label })
          : h('img', { width: r.width, height: r.height, alt: kind === 'image' ? label : `First frame of ${projectTitle} (the frames are in the zip)` });
    const link = kind === 'none' ? null : sameOriginLink(r);
    if (kind !== 'audio')
      ctx.api
        .objectUrl(`/v1/renders/${enc}/output?file=poster.png`, ac.signal)
        .then((u) => (urls.push(u), video instanceof HTMLVideoElement ? (video.poster = u) : kind === 'none' && video instanceof HTMLImageElement ? (video.src = u) : undefined))
        .catch(() => undefined);
    // Sidecar captions play in the player from this server (a <track> needs the same origin).
    const vtt = r.captions?.files.find((f) => f.format === 'vtt');
    const vttLink = vtt ? sameOriginLink({ downloadUrl: vtt.downloadUrl, downloadVia: r.downloadVia }) : null;
    if (vttLink && !r.captions?.burned && kind === 'video') video.append(h('track', { kind: 'captions', src: vttLink, srclang: r.captions?.language ?? 'en', label: 'Captions', default: true }));
    if (kind === 'none') {
      // A zip of PNG frames: the poster stands in for a player.
    } else if (link) (video as HTMLMediaElement | HTMLImageElement).src = link;
    else
      ctx.api
        .objectUrl(`/v1/renders/${enc}/output`, ac.signal)
        .then((u) => (urls.push(u), ((video as HTMLMediaElement | HTMLImageElement).src = u)))
        .catch(() => undefined);
    const file = r.file ?? 'final.mp4';
    const ext = file.slice(file.lastIndexOf('.') + 1);

    const checks = Object.entries(m.checks ?? {});
    if (r.captions) checks.push(['captions', r.captions.qa.ok ? 'pass' : `${r.captions.qa.issues.length} issues`]);
    const scenes = m.scenes ?? [];
    const engines = Object.entries(m.versions?.engines ?? {});
    const storage = h('dd', null, r.storage ? h('span', { class: 'mono break' }, r.storage.prefix) : '–');
    const storageRows = dl([
      ['Driver', r.storage?.driver ?? '–'],
      ['Downloads', r.downloadVia === 'bucket' ? 'Signed by the bucket' : 'Signed by this server'],
    ]);
    storageRows.append(h('div', null, h('dt', null, 'Path'), storage));

    fill(
      body,
      h('div', { class: 'render-grid-2' }, h('div', { class: 'player' }, video), h(
        'div',
        { class: 'render-side' },
        section(
          'Output',
          dl([
            ['Format', outputFormat(r)],
            ['Size', kind === 'audio' ? '–' : size(r.width, r.height)],
            ['Frame rate', `${r.fps} fps`],
            ['Length', `${r.durationSeconds.toFixed(1)} s · ${r.frames} frames`],
            ['Render time', m.wallClockMillis !== undefined ? duration(m.wallClockMillis) : '–'],
            ['Project version', m.projectVersion !== undefined ? String(m.projectVersion) : '–'],
            ['Captions', r.captions ? `${r.captions.burned ? 'Burned in' : 'Sidecar files'} · ${r.captions.cues} cues${r.captions.language ? ` · ${r.captions.language}` : ''}` : 'None'],
          ]),
          h(
            'div',
            { class: 'actions' },
            h('a', { class: 'btn btn-primary', href: sameOriginLink(r) ?? r.downloadUrl, download: `${id}.${ext}`, rel: 'noreferrer' }, `Download ${ext.toUpperCase()}`),
            h('button', { type: 'button', class: 'btn', onclick: () => downloadManifest(m) }, 'Download manifest'),
            (r.captions?.files ?? []).map((f) =>
              h('a', { class: 'btn btn-quiet', href: sameOriginLink({ downloadUrl: f.downloadUrl, downloadVia: r.downloadVia }) ?? f.downloadUrl, download: f.file, rel: 'noreferrer' }, `${f.format.toUpperCase()} captions`)
            )
          ),
          h('p', { class: 'help' }, `The download link is signed and works until ${clock(new Date(r.downloadUrlExpiresAt))}.`)
        ),
        section(
          'Quality checks',
          checks.length
            ? h(
                'ul',
                { class: 'checks' },
                checks.map(([k, v]) => h('li', { class: v === 'pass' ? 'pass' : 'fail' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', null, CHECK_LABEL[k] ?? k), h('span', { class: 'sub' }, v === 'pass' ? 'Passed' : v)))
              )
            : h('p', { class: 'empty' }, 'No checks recorded.')
        )
      )),
      h(
        'div',
        { class: 'render-grid-3' },
        wideSection(
          `Scenes (${scenes.length})`,
          tableWrap(
            'Scenes',
            h(
              'table',
              { class: 'table nowrap' },
              h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Scene'), h('th', { scope: 'col' }, 'Engine'), h('th', { scope: 'col' }, 'Template'), h('th', { scope: 'col', class: 'num' }, 'Frames'), h('th', { scope: 'col', class: 'num' }, 'Time'))),
              h(
                'tbody',
                null,
                scenes.map((sc) =>
                  h(
                    'tr',
                    null,
                    h('td', { class: 'mono' }, sc.sceneId, sc.frameRange ? h('span', { class: 'sub' }, `frames ${sc.frameRange[0]}–${sc.frameRange[1]}`) : null),
                    h('td', null, sc.engine),
                    h('td', null, sc.template ?? 'source'),
                    h('td', { class: 'num' }, String(sc.frames)),
                    h('td', { class: 'num' }, sc.millis !== undefined ? duration(sc.millis) : '–')
                  )
                )
              )
            )
          )
        ),
        section('Storage', storageRows, ctx.isAdmin ? null : h('p', { class: 'help' }, 'The bucket or folder is shown to admin keys.')),
        section(
          'Versions',
          dl([
            ['Server', m.versions?.server ?? '–'],
            ['FFmpeg', (m.versions?.ffmpeg ?? '–').replace(/^ffmpeg version /, '').split(' ')[0]!],
            ...engines.map(([e, v]) => [e, v] as [string, string]),
          ])
        ),
        section('Files', h('ul', { class: 'files' }, r.files.map((f) => h('li', { class: 'mono' }, f))))
      )
    );

    // Bucket and root of the storage: get_storage is admin only.
    if (ctx.isAdmin) {
      ctx.api
        .get<{ location: Record<string, unknown> }>('/v1/storage', ac.signal)
        .then((st) => {
          const where = Object.entries(st.location ?? {})
            .filter(([k, v]) => ['bucket', 'container', 'root', 'prefix', 'region', 'endpoint'].includes(k) && typeof v === 'string')
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ');
          if (where) storageRows.append(h('div', null, h('dt', null, 'Location'), h('dd', { class: 'mono break' }, where)));
        })
        .catch(() => undefined);
    }
  })().catch((e) => {
    if (ac.signal.aborted || ctx.authLost(e)) return;
    title.textContent = e instanceof HttpError && e.status === 404 ? 'Render not found' : 'Render';
    fill(body, notice(e instanceof HttpError && e.status === 404 ? `There is no render ${id}.` : `Could not load the render: ${(e as Error).message}`, 'error'));
  });

  return () => {
    ac.abort();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
};

import { HttpError, TERMINAL, type Job } from '../api';
import { fill, h, notice, status, tableWrap } from '../dom';
import { ago, between, clock, dateTime, jobType, percent } from '../format';
import type { View } from '../main';

const POLL_MS = 3000;
const PAGE = 50;

/** Runs `tick` now and every POLL_MS while the tab is visible; returns a stop function. */
function poll(tick: () => Promise<boolean | void>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    if (document.visibilityState === 'visible') {
      if ((await tick().catch(() => undefined)) === false) return; // the view asked to stop
    }
    if (!stopped) timer = setTimeout(run, POLL_MS);
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function progressBar(job: Job, label: string): HTMLProgressElement {
  const p = h('progress', { max: 100, 'aria-label': label, class: TERMINAL.has(job.status) ? 'settled' : null });
  p.value = Math.round((job.status === 'succeeded' ? 1 : (job.progress?.fraction ?? 0)) * 100);
  return p;
}

function stageText(job: Job): string {
  if (job.status === 'queued') return job.queuePosition !== undefined ? `Position ${job.queuePosition + 1} in the queue` : 'Waiting for a worker';
  if (job.status === 'failed') return job.error ? `${job.error.code}${job.error.stage ? ` at ${job.error.stage}` : ''}` : '';
  if (job.status === 'cancelled') return '';
  const p = job.progress;
  if (!p) return '';
  return [p.stage, p.detail].filter(Boolean).join(' · ');
}

/** Live jobs show their progress; finished ones what they left: the output, or the error. */
function progressCell(j: Job): Array<HTMLElement | string> | HTMLElement | string {
  const renderId = (j.result?.renderId ?? j.result?.runId) as string | undefined;
  if (j.status === 'succeeded') return renderId ? h('span', { class: 'sub' }, 'Output ', h('a', { href: `#/renders/${renderId}`, class: 'mono' }, renderId)) : h('span', { class: 'sub' }, 'Done');
  if (j.status === 'cancelled') return '';
  if (j.status === 'failed') return h('span', { class: 'sub' }, stageText(j));
  return [h('div', { class: 'progress-cell' }, progressBar(j, `Progress of ${j.id}`), h('span', { class: 'num' }, percent(j.progress?.fraction))), h('span', { class: 'sub' }, stageText(j))];
}

function projectLink(job: Job): HTMLElement | string {
  const pid = job.projectId ?? (job.params?.projectId as string | undefined);
  return pid ? h('a', { href: `#/library/${pid}`, class: 'mono' }, pid) : '–';
}

/** #/jobs: the newest jobs, refreshed every few seconds. Units of a fanned-out render show under their render. */
export const jobsView: View = (ctx, main) => {
  const updated = h('span', { class: 'meta' }, 'Loading');
  const counts = h('dl', { class: 'stats' });
  const body = h('div');
  fill(
    main,
    h('div', { class: 'page-head' }, h('h1', { tabindex: '-1' }, 'Jobs'), updated),
    h('section', { 'aria-label': 'Jobs by status' }, counts),
    body
  );

  const render = (jobs: Job[]) => {
    const top = jobs.filter((j) => !j.parentId);
    const n = (st: string) => top.filter((j) => j.status === st).length;
    fill(
      counts,
      (['running', 'queued', 'failed', 'succeeded'] as const).map((st) =>
        h('div', { class: 'stat' }, h('dt', null, status(st)), h('dd', null, String(n(st))))
      )
    );
    if (!top.length) {
      fill(body, h('p', { class: 'empty' }, 'No jobs yet. They appear here when an agent or API client starts a render or a preview.'));
      return;
    }
    const now = Date.now();
    const units = (id: string) => jobs.filter((j) => j.parentId === id).length;
    fill(
      body,
      tableWrap(
        'Jobs',
        h(
          'table',
          { class: 'table jobs' },
          h('caption', { class: 'sr-only' }, `The newest ${top.length} jobs, newest first`),
          h(
            'thead',
            null,
            h('tr', null, h('th', { scope: 'col' }, 'Job'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col', class: 'col-progress' }, 'Progress'), h('th', { scope: 'col', class: 'wide' }, 'Project'), h('th', { scope: 'col', class: 'wide num' }, 'Created'), h('th', { scope: 'col', class: 'wide num' }, 'Time'))
          ),
          h(
            'tbody',
            null,
            top.map((j) =>
              h(
                'tr',
                { 'data-job': j.id },
                h('td', null, h('a', { href: `#/jobs/${j.id}`, class: 'mono' }, j.id), h('span', { class: 'sub' }, jobType(j.type), units(j.id) ? ` · ${units(j.id)} units` : '')),
                h('td', null, status(j.status)),
                h('td', { class: 'col-progress' }, progressCell(j)),
                h('td', { class: 'wide' }, projectLink(j)),
                h('td', { class: 'wide num' }, ago(j.createdAt, now)),
                h('td', { class: 'wide num' }, j.startedAt ? between(j.startedAt, j.finishedAt, now) : '–')
              )
            )
          )
        )
      ),
      h('p', { class: 'meta' }, `Counts cover the newest ${PAGE} jobs.`)
    );
  };

  let shownError = false;
  return poll(async () => {
    try {
      const page = await ctx.api.get<{ jobs: Job[] }>(`/v1/jobs?limit=${PAGE}`);
      render(page.jobs);
      fill(updated, `Updated ${clock(new Date())}, every ${POLL_MS / 1000} s`);
      shownError = false;
    } catch (e) {
      if (ctx.authLost(e)) return false;
      if (!shownError) fill(body, notice(`Could not load jobs: ${(e as Error).message}`, 'error'));
      shownError = true;
    }
  });
};

/** #/jobs/:id: one job, live over its event stream; cancel and retry for keys with the render scope. */
export const jobView: View = (ctx, main, id) => {
  const jobId = id!;
  const ac = new AbortController();
  const stops: Array<() => void> = [() => ac.abort()];
  const head = h('div', { class: 'job-head' });
  const progress = h('section', { class: 'panel job-progress', 'aria-label': 'Progress' });
  const facts = h('dl', { class: 'facts' });
  const problem = h('div');
  const unitsBox = h('section', { class: 'panel', 'aria-labelledby': 'units-h' });
  const actionMsg = h('div', { class: 'action-msg' });
  const log = h('pre', { class: 'log', tabindex: '0', 'aria-label': 'Job log' });
  const logLines: string[] = [];
  let job: Job | null = null;
  let lastStatus = '';

  fill(
    main,
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/jobs' }, 'Jobs'), h('span', { 'aria-current': 'page', class: 'mono' }, jobId)),
    head,
    actionMsg,
    problem,
    h('div', { class: 'job-grid' }, h('div', { class: 'job-main' }, progress, unitsBox), h('section', { class: 'panel', 'aria-label': 'Details' }, facts)),
    h('section', { class: 'panel' }, h('h2', null, 'Log'), log)
  );
  // The h1 exists from the start so the router can focus it.
  const title = h('h1', { tabindex: '-1' }, 'Job');
  fill(head, title);

  const act = async (what: 'cancel' | 'retry') => {
    if (what === 'cancel' && !window.confirm(`Cancel ${jobId}? A cancelled render leaves no output.`)) return;
    fill(actionMsg);
    try {
      if (what === 'cancel') update(await ctx.api.post<Job>(`/v1/jobs/${jobId}/cancel`));
      else {
        const r = await ctx.api.post<{ job: Job }>(`/v1/jobs/${jobId}/retry`, {}, true);
        location.hash = `#/jobs/${r.job.id}`;
      }
    } catch (e) {
      if (ctx.authLost(e)) return;
      fill(actionMsg, notice(e instanceof HttpError && e.status === 403 ? `This key cannot ${what} jobs: ${e.message}` : `Could not ${what}: ${(e as Error).message}`, 'error'));
    }
  };

  const renderHead = (j: Job) => {
    const canCancel = !TERMINAL.has(j.status) && !j.parentId;
    const canRetry = (j.status === 'failed' || j.status === 'cancelled') && !j.parentId;
    const buttons: HTMLElement[] = [];
    if (canCancel) buttons.push(h('button', { type: 'button', class: 'btn', disabled: !ctx.canRender, onclick: () => act('cancel') }, 'Cancel job'));
    if (canRetry) buttons.push(h('button', { type: 'button', class: 'btn btn-primary', disabled: !ctx.canRender, onclick: () => act('retry') }, 'Retry'));
    title.textContent = `${jobType(j.type)} job`;
    fill(
      head,
      h('div', null, title, h('p', { class: 'meta' }, h('span', { class: 'mono' }, j.id), ' · ', status(j.status))),
      buttons.length
        ? h(
            'div',
            { class: 'actions' },
            buttons,
            ctx.canRender ? null : h('p', { class: 'help', id: 'scope-note' }, 'This key is read only: cancel and retry need the render scope.')
          )
        : null
    );
  };

  const renderProgress = (j: Job) => {
    const f = j.status === 'succeeded' ? 1 : (j.progress?.fraction ?? 0);
    fill(
      progress,
      h('h2', { class: 'sr-only' }, 'Progress'),
      h('div', { class: 'big-progress' }, h('span', { class: 'figure num' }, percent(f)), h('span', { class: 'stage' }, stageText(j) || '–')),
      progressBar(j, 'Job progress')
    );
  };

  const renderFacts = (j: Job) => {
    const renderId = (j.result?.renderId ?? j.result?.runId) as string | undefined;
    const rows: Array<[string, Node | string]> = [
      ['Type', jobType(j.type)],
      ['Project', projectLink(j)],
      ['Priority', j.priority ?? 'standard'],
      ['Created', dateTime(j.createdAt)],
      ['Started', dateTime(j.startedAt)],
      ['Finished', dateTime(j.finishedAt)],
      ['Time', j.startedAt ? between(j.startedAt, j.finishedAt) : '–'],
    ];
    if (j.queuePosition !== undefined && j.status === 'queued') rows.push(['Queue position', String(j.queuePosition + 1)]);
    if (j.attempts) rows.push(['Attempts', String(j.attempts)]);
    if (j.workerId) rows.push(['Worker', h('span', { class: 'mono' }, j.workerId)]);
    if (j.retryOf) rows.push(['Retry of', h('a', { href: `#/jobs/${j.retryOf}`, class: 'mono' }, j.retryOf)]);
    if (j.parentId) rows.push(['Unit of', h('a', { href: `#/jobs/${j.parentId}`, class: 'mono' }, j.parentId)]);
    if (renderId && j.status === 'succeeded') rows.push(['Output', h('a', { href: `#/renders/${renderId}`, class: 'mono' }, renderId)]);
    fill(facts, rows.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v))));
    fill(problem, j.error ? h('div', { class: 'notice notice-error', role: 'alert' }, h('strong', null, j.error.code), ` ${j.error.message}`, j.error.unit ? h('span', null, ' (unit ', h('a', { href: `#/jobs/${j.error.unit}`, class: 'mono' }, j.error.unit), ')') : null) : null);
  };

  const update = (j: Job) => {
    job = j;
    if (j.status !== lastStatus) {
      renderHead(j);
      lastStatus = j.status;
    }
    renderProgress(j);
    renderFacts(j);
    document.title = `${title.textContent} ${j.id} · ReelForge Studio`;
  };

  const renderUnits = (units: Job[]) => {
    if (!units.length) {
      fill(unitsBox);
      unitsBox.hidden = true;
      return;
    }
    unitsBox.hidden = false;
    const sorted = [...units].sort((a, b) => Number(a.params.index ?? 99) - Number(b.params.index ?? 99) || a.createdAt.localeCompare(b.createdAt));
    fill(
      unitsBox,
      h('h2', { id: 'units-h' }, `Fan-out units (${units.length})`),
      tableWrap(
        'Fan-out units',
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Unit'), h('th', { scope: 'col' }, 'Scene'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col', class: 'col-progress' }, 'Progress'))),
          h(
            'tbody',
            null,
            sorted.map((u) => {
              const p = u.params;
              const scene = u.type === 'render_join' ? 'Join' : `${Number(p.index) + 1} of ${p.count ?? '?'}${Array.isArray(p.range) ? `, frames ${p.range[0]}–${p.range[1]}` : ''}`;
              return h(
                'tr',
                null,
                h('td', null, h('a', { href: `#/jobs/${u.id}`, class: 'mono' }, u.id)),
                h('td', null, scene, p.sceneId ? h('span', { class: 'sub mono' }, String(p.sceneId)) : null),
                h('td', null, status(u.status)),
                h('td', { class: 'col-progress' }, h('div', { class: 'progress-cell' }, progressBar(u, `Progress of ${u.id}`), h('span', { class: 'num' }, percent(u.status === 'succeeded' ? 1 : u.progress?.fraction))))
              );
            })
          )
        )
      )
    );
  };

  const showLog = () => {
    log.textContent = logLines.length ? logLines.join('\n') : 'No log lines yet.';
    log.scrollTop = log.scrollHeight;
  };

  const loadUnits = async () => {
    const page = await ctx.api.get<{ jobs: Job[] }>(`/v1/jobs?parentId=${encodeURIComponent(jobId)}&limit=200`, ac.signal);
    renderUnits(page.jobs);
  };

  const start = async () => {
    try {
      update(await ctx.api.get<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`, ac.signal));
      const logs = await ctx.api.get<{ lines: string[] }>(`/v1/jobs/${encodeURIComponent(jobId)}/logs?tail=300`, ac.signal);
      logLines.push(...logs.lines);
      showLog();
      await loadUnits();
    } catch (e) {
      if (ac.signal.aborted || ctx.authLost(e)) return;
      fill(head, title, notice(e instanceof HttpError && e.status === 404 ? `There is no job ${jobId}.` : `Could not load the job: ${(e as Error).message}`, 'error'));
      title.textContent = 'Job not found';
      return;
    }
    if (TERMINAL.has(job!.status)) return;
    // Units change on their own schedule: poll them while the render runs.
    stops.push(poll(async () => {
      await loadUnits();
      return !TERMINAL.has(job?.status ?? 'running');
    }));
    // Live progress and log lines over SSE; fall back to polling the job if the stream breaks.
    try {
      await ctx.api.events(
        `/v1/jobs/${encodeURIComponent(jobId)}/events`,
        (event, data) => {
          if (event === 'log') {
            logLines.push((JSON.parse(data) as { line: string }).line);
            if (logLines.length > 1000) logLines.splice(0, logLines.length - 1000);
            showLog();
          } else update(JSON.parse(data) as Job);
        },
        ac.signal
      );
    } catch (e) {
      if (ac.signal.aborted || ctx.authLost(e)) return;
    }
    if (ac.signal.aborted) return;
    if (!TERMINAL.has(job!.status)) {
      stops.push(poll(async () => {
        update(await ctx.api.get<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`, ac.signal));
        return !TERMINAL.has(job!.status);
      }));
    } else void loadUnits().catch(() => undefined);
  };
  void start();
  return () => stops.forEach((s) => s());
};


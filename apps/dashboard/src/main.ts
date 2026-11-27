import { Api, HttpError, can, type Me } from './api';
import { fill, h, mark } from './dom';
import { scopeText } from './format';
import { analyticsView } from './views/analytics';
import { assetsView } from './views/assets';
import { rendersView } from './views/renders';
import { auditView } from './views/audit';
import { jobView, jobsView } from './views/jobs';
import { libraryView, renderView } from './views/library';
import { loginView } from './views/login';
import { configView, keysView, providersView, webhookView, webhooksView } from './views/settings';

/** What every view gets: the API with the signed-in key, and what that key may do. */
export interface Ctx {
  api: Api;
  me: Me;
  /** The key has the render scope (or admin): it may cancel and retry. */
  canRender: boolean;
  isAdmin: boolean;
  /** Whether the key has a scope, as the server decides it (admin implies the others; owner implies all). */
  can(scope: string): boolean;
  /** Call from a view's catch: true when the key stopped working (the person is signed out). */
  authLost(e: unknown): boolean;
}
/** Renders into `main`; returns a cleanup for timers and streams. */
export type View = (ctx: Ctx, main: HTMLElement, arg?: string) => (() => void) | void;

// sessionStorage only, and only when asked: it ends with the tab and is never sent anywhere by the browser.
// It holds the keys of every workspace signed in on this tab, as a JSON list (an older single key still reads).
const STORE = 'reelforge.dashboard.key';
const root = document.getElementById('app')!;

/** One signed-in key and the workspace it works in (requests always run in the key's own workspace, #304). */
interface Session {
  api: Api;
  key: string;
  me: Me;
  workspace: { id: string; name: string };
  keep: boolean;
}
/** Every key signed in on this tab; `session` is the one in use. Switching changes which key the pages call with. */
let sessions: Session[] = [];
let session: Session | null = null;
let shell: { main: HTMLElement; nav: Record<string, HTMLAnchorElement> } | null = null;
let dispose: (() => void) | void;
/** Sign in to one more workspace without leaving the ones already open. */
let adding = false;

function stored(): string[] {
  try {
    const raw = sessionStorage.getItem(STORE);
    if (!raw) return [];
    if (!raw.startsWith('[')) return [raw];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string' && k.length > 0) : [];
  } catch {
    return [];
  }
}
function remember(): void {
  try {
    const keep = sessions.filter((s) => s.keep).map((s) => s.key);
    if (keep.length) sessionStorage.setItem(STORE, JSON.stringify(keep));
    else sessionStorage.removeItem(STORE);
  } catch {
    // storage blocked: the keys stay in memory only
  }
}

async function signIn(key: string, keep: boolean): Promise<void> {
  const api = new Api(key);
  const me = await api.get<Me>('/v1/me');
  // The key's workspace; a server without workspaces has one, named Default.
  const workspace = await api.get<{ id: string; name: string }>('/v1/workspace').catch(() => ({ id: 'default', name: 'Default' }));
  const next: Session = { api, key, me, workspace: { id: workspace.id, name: workspace.name }, keep };
  // The same key again replaces its session; another key of the same workspace is a separate entry.
  sessions = [...sessions.filter((s) => s.me.id !== me.id), next];
  adding = false;
  use(next);
  remember();
}

/** Make `s` the key the pages use, and show the same page for it. */
function use(s: Session): void {
  dispose?.();
  dispose = undefined;
  session = s;
  shell = null;
  route();
}

/** Sign the current key out; another signed-in workspace takes over, or the sign-in page shows. */
function signOut(message?: string): void {
  dispose?.();
  dispose = undefined;
  sessions = sessions.filter((s) => s !== session);
  remember();
  const next = sessions.at(-1);
  if (next && !message) return use(next);
  if (next && message) {
    session = next;
    shell = null;
    route(message);
    return;
  }
  session = null;
  shell = null;
  route(message);
}

/** The workspace picker: every signed-in key, then "Sign in to another workspace". Only shown with workspaces to pick. */
function workspacePicker(current: Session): HTMLElement {
  const select = h(
    'select',
    {
      id: 'workspace',
      class: 'ws-select',
      onchange: () => {
        if (select.value === '+') {
          select.value = current.me.id;
          adding = true;
          dispose?.();
          dispose = undefined;
          shell = null;
          route();
          return;
        }
        const s = sessions.find((x) => x.me.id === select.value);
        if (s && s !== session) use(s);
      },
    },
    ...sessions.map((s) => h('option', { value: s.me.id, selected: s === current }, sessions.some((o) => o !== s && o.workspace.id === s.workspace.id) ? `${s.workspace.name} (${s.me.name})` : s.workspace.name)),
    h('option', { value: '+' }, 'Sign in to another workspace…')
  );
  return h('div', { class: 'ws' }, h('label', { for: 'workspace', class: 'ws-label' }, 'Workspace'), select);
}

function buildShell(me: Me): NonNullable<typeof shell> {
  const nav = {
    jobs: h('a', { href: '#/jobs' }, 'Jobs'),
    library: h('a', { href: '#/library' }, 'Library'),
    renders: h('a', { href: '#/renders' }, 'Renders'),
    assets: h('a', { href: '#/assets' }, 'Assets'),
    analytics: h('a', { href: '#/analytics' }, 'Analytics'),
    settings: h('a', { href: '#/settings' }, 'Settings'),
    audit: h('a', { href: '#/audit' }, 'Audit log'),
  };
  const main = h('main', { id: 'main', class: 'main' });
  fill(
    root,
    h('a', { class: 'skip', href: '#main', onclick: (e) => (e.preventDefault(), main.querySelector('h1')?.focus()) }, 'Skip to content'),
    h(
      'header',
      { class: 'top' },
      h('a', { class: 'brand', href: '#/jobs' }, mark(20), h('span', null, 'RenderWeld')),
      h('nav', { class: 'nav', 'aria-label': 'Dashboard' }, Object.values(nav)),
      h(
        'div',
        { class: 'who' },
        session ? workspacePicker(session) : null,
        h('span', { class: 'who-key' }, h('span', { class: 'who-name' }, me.name), h('span', { class: 'who-scope' }, scopeText(me.scopes))),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => signOut() }, 'Sign out')
      )
    ),
    main
  );
  return { main, nav };
}

type Section = 'jobs' | 'library' | 'renders' | 'assets' | 'analytics' | 'settings' | 'audit';
const ROUTES: Array<[RegExp, View, Section]> = [
  [/^#\/jobs\/([\w-]+)$/, jobView, 'jobs'],
  [/^#\/jobs$/, jobsView, 'jobs'],
  [/^#\/library\/([\w-]+)$/, libraryView, 'library'],
  [/^#\/library$/, libraryView, 'library'],
  [/^#\/renders$/, rendersView, 'renders'],
  [/^#\/assets$/, assetsView, 'assets'],
  [/^#\/renders\/([\w-]+)$/, renderView, 'library'],
  [/^#\/analytics$/, analyticsView, 'analytics'],
  [/^#\/settings$/, configView, 'settings'],
  [/^#\/settings\/keys$/, keysView, 'settings'],
  [/^#\/settings\/webhooks$/, webhooksView, 'settings'],
  [/^#\/settings\/webhooks\/([\w-]+)$/, webhookView, 'settings'],
  [/^#\/settings\/providers$/, providersView, 'settings'],
  [/^#\/audit$/, auditView, 'audit'],
];

function route(message?: string): void {
  dispose?.();
  dispose = undefined;
  if (!session || adding) {
    shell = null;
    document.title = adding ? 'Add a workspace · RenderWeld' : 'Sign in · RenderWeld';
    loginView(root, {
      onSubmit: signIn,
      message,
      ...(adding && session
        ? {
            heading: 'Sign in to another workspace',
            onCancel: () => {
              adding = false;
              route();
            },
          }
        : {}),
    });
    return;
  }
  const hit = ROUTES.map(([re, view, section]) => ({ m: re.exec(location.hash), view, section })).find((r) => r.m);
  if (!hit) {
    location.replace('#/jobs');
    return;
  }
  shell ??= buildShell(session.me);
  for (const [name, a] of Object.entries(shell.nav)) {
    if (name === hit.section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const { api, me } = session;
  const ctx: Ctx = {
    api,
    me,
    canRender: can(me.scopes, 'render'),
    isAdmin: can(me.scopes, 'admin'),
    can: (scope) => can(me.scopes, scope),
    authLost: (e) => {
      if (e instanceof HttpError && e.status === 401) {
        signOut(`Signed out: ${e.message}`);
        return true;
      }
      return false;
    },
  };
  shell.main.replaceChildren();
  dispose = hit.view(ctx, shell.main, hit.m![1]);
  const h1 = shell.main.querySelector('h1');
  document.title = `${h1?.textContent ?? 'Dashboard'} · RenderWeld`;
  if (focusOnRoute) h1?.focus();
  focusOnRoute = true;
}

let focusOnRoute = false;
window.addEventListener('hashchange', () => route());

const saved = stored();
if (saved.length) {
  // Every kept key, in order; one that no longer works is dropped with a message.
  (async () => {
    let failed = 0;
    for (const key of saved) await signIn(key, true).catch(() => failed++);
    if (failed) route(failed === saved.length ? 'Your saved key no longer works. Sign in again.' : 'A saved key no longer works and was signed out.');
  })();
} else route();

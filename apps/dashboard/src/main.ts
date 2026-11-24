import { Api, HttpError, type Me } from './api';
import { fill, h, mark } from './dom';
import { scopeText } from './format';
import { jobView, jobsView } from './views/jobs';
import { libraryView, renderView } from './views/library';
import { loginView } from './views/login';

/** What every view gets: the API with the signed-in key, and what that key may do. */
export interface Ctx {
  api: Api;
  me: Me;
  /** The key has the render scope (or admin): it may cancel and retry. */
  canRender: boolean;
  isAdmin: boolean;
  /** Call from a view's catch: true when the key stopped working (the person is signed out). */
  authLost(e: unknown): boolean;
}
/** Renders into `main`; returns a cleanup for timers and streams. */
export type View = (ctx: Ctx, main: HTMLElement, arg?: string) => (() => void) | void;

// sessionStorage only, and only when asked: it ends with the tab and is never sent anywhere by the browser.
const STORE = 'reelforge.dashboard.key';
const root = document.getElementById('app')!;
let session: { api: Api; me: Me } | null = null;
let shell: { main: HTMLElement; nav: Record<string, HTMLAnchorElement> } | null = null;
let dispose: (() => void) | void;

function stored(): string | null {
  try {
    return sessionStorage.getItem(STORE);
  } catch {
    return null;
  }
}
function remember(key: string | null): void {
  try {
    if (key) sessionStorage.setItem(STORE, key);
    else sessionStorage.removeItem(STORE);
  } catch {
    // storage blocked: the key stays in memory only
  }
}

async function signIn(key: string, keep: boolean): Promise<void> {
  const api = new Api(key);
  const me = await api.get<Me>('/v1/me');
  session = { api, me };
  remember(keep ? key : null);
  route();
}

function signOut(message?: string): void {
  dispose?.();
  dispose = undefined;
  session = null;
  shell = null;
  remember(null);
  route(message);
}

function buildShell(me: Me): NonNullable<typeof shell> {
  const nav = {
    jobs: h('a', { href: '#/jobs' }, 'Jobs'),
    library: h('a', { href: '#/library' }, 'Library'),
  };
  const main = h('main', { id: 'main', class: 'main' });
  fill(
    root,
    h('a', { class: 'skip', href: '#main', onclick: (e) => (e.preventDefault(), main.querySelector('h1')?.focus()) }, 'Skip to content'),
    h(
      'header',
      { class: 'top' },
      h('a', { class: 'brand', href: '#/jobs' }, mark(20), h('span', null, 'ReelForge Studio')),
      h('nav', { class: 'nav', 'aria-label': 'Dashboard' }, nav.jobs, nav.library),
      h(
        'div',
        { class: 'who' },
        h('span', { class: 'who-key' }, h('span', { class: 'who-name' }, me.name), h('span', { class: 'who-scope' }, scopeText(me.scopes))),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => signOut() }, 'Sign out')
      )
    ),
    main
  );
  return { main, nav };
}

const ROUTES: Array<[RegExp, View, 'jobs' | 'library']> = [
  [/^#\/jobs\/([\w-]+)$/, jobView, 'jobs'],
  [/^#\/jobs$/, jobsView, 'jobs'],
  [/^#\/library\/([\w-]+)$/, libraryView, 'library'],
  [/^#\/library$/, libraryView, 'library'],
  [/^#\/renders\/([\w-]+)$/, renderView, 'library'],
];

function route(message?: string): void {
  dispose?.();
  dispose = undefined;
  if (!session) {
    shell = null;
    document.title = 'Sign in · ReelForge Studio';
    loginView(root, { onSubmit: signIn, message });
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
    canRender: me.scopes.includes('render') || me.scopes.includes('admin'),
    isAdmin: me.scopes.includes('admin'),
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
  document.title = `${h1?.textContent ?? 'Dashboard'} · ReelForge Studio`;
  if (focusOnRoute) h1?.focus();
  focusOnRoute = true;
}

let focusOnRoute = false;
window.addEventListener('hashchange', () => route());

const saved = stored();
if (saved) signIn(saved, true).catch(() => signOut('Your saved key no longer works. Sign in again.'));
else route();

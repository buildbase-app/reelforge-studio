import { HttpError } from '../api';
import { fill, h, mark, notice } from '../dom';

/** Sign in with an API key. The key is checked with GET /v1/me before anything else is shown. */
/**
 * With `onCancel`, the person is adding another workspace's key while signed in to one: the page says so and offers
 * to go back.
 */
export function loginView(root: HTMLElement, opts: { onSubmit(key: string, keep: boolean): Promise<void>; message?: string; heading?: string; onCancel?: () => void }): void {
  const key = h('input', {
    id: 'key',
    name: 'key',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    autocapitalize: 'off',
    required: true,
    'aria-describedby': 'key-help',
  });
  const keep = h('input', { id: 'keep', type: 'checkbox' });
  const status = h('div', { class: 'login-status' }, opts.message ? notice(opts.message) : null);
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in');

  const form = h(
    'form',
    {
      class: 'login-form',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const value = key.value.trim();
        if (!value) {
          fill(status, notice('Enter an API key.', 'error'));
          key.focus();
          return;
        }
        submit.disabled = true;
        fill(status);
        try {
          await opts.onSubmit(value, keep.checked);
        } catch (err) {
          const msg = err instanceof HttpError ? (err.status === 401 || err.status === 403 ? `This key was not accepted: ${err.message}` : err.message) : 'The studio did not answer. Check that it is running.';
          fill(status, notice(msg, 'error'));
          submit.disabled = false;
          key.select();
        }
      },
    },
    h('label', { for: 'key' }, 'API key'),
    key,
    h(
      'p',
      { id: 'key-help', class: 'help' },
      'A read key can watch jobs and browse renders. Cancel and retry need the render scope. Create one with ',
      h('code', null, 'renderweld keys create --name dashboard --scopes read'),
      '.'
    ),
    h('div', { class: 'check' }, keep, h('label', { for: 'keep' }, 'Keep me signed in until this tab closes')),
    status,
    submit
  );

  fill(
    root,
    h(
      'main',
      { class: 'login', id: 'main' },
      h(
        'div',
        { class: 'login-card' },
        h('p', { class: 'brand' }, mark(24), h('span', null, 'RenderWeld')),
        h('h1', { tabindex: '-1' }, opts.heading ?? 'Sign in to the dashboard'),
        h(
          'p',
          { class: 'lede' },
          opts.onCancel
            ? 'Use a key of the other workspace. Each key works only in its own workspace; you can switch between the signed-in ones from the header.'
            : 'Watch render jobs and browse finished reels on this studio.'
        ),
        form,
        opts.onCancel ? h('button', { type: 'button', class: 'btn btn-quiet login-cancel', onclick: () => opts.onCancel!() }, 'Back to the dashboard') : null,
        h('p', { class: 'fine' }, 'The key stays in this browser tab and is sent only to this server, in the Authorization header.')
      )
    )
  );
  key.focus();
}

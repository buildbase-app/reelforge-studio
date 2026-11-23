// Answers and checks shared by the `reel` generators. Hygen require()s each
// action's index.js (CommonJS, see ../package.json) and passes the flags as
// `args`; params() returns the template locals or throws one clear error.
// Limits follow the built-in templates in packages/project-schema/src/templates.ts.

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Per-scene seconds and text limits of each template. */
const TEMPLATES = {
  'kinetic-title': { min: 1.5, max: 8 },
  'animated-explainer': { min: 2, max: 20 },
  'html-title': { min: 1, max: 12 },
  'hyperframes-title': { min: 1, max: 12 },
};

/** Flags of each generator: max length, `required`, `list` (several values, or one split on "|"). */
const FLAGS = {
  'kinetic-title': { headline: { max: 60, required: true }, subline: { max: 80 }, cta: { max: 60 }, 'cta-subline': { max: 80 } },
  'animated-explainer': { headline: { max: 60, required: true }, points: { max: 90, required: true, list: 4 } },
  'html-title': {
    headline: { max: 80, required: true }, subline: { max: 120 }, kicker: { max: 40 },
    cta: { max: 80 }, 'cta-subline': { max: 120 }, 'cta-kicker': { max: 40 },
  },
  'hyperframes-title': { headline: { max: 80, required: true }, subline: { max: 120 }, cta: { max: 80 }, 'cta-subline': { max: 120 } },
  'multi-engine': {
    headline: { max: 60, required: true }, subline: { max: 80 },
    'steps-title': { max: 60, required: true }, points: { max: 90, required: true, list: 4 },
    kicker: { max: 40 }, card: { max: 80, required: true },
    outro: { max: 80, required: true }, 'outro-subline': { max: 120 },
  },
};

const COMMON = ['name', 'title', 'theme', 'accent', 'out', 'seconds'];
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function params(generator, args) {
  const fail = (msg) => {
    throw new Error(`reel ${generator}: ${msg}. Usage: hygen reel ${generator} --name <project-id> ${usage(generator)}`);
  };
  const flags = FLAGS[generator];
  const known = [...COMMON, ...Object.keys(flags)].filter((k) => k !== 'seconds' || generator !== 'multi-engine');
  const allowed = new Set([...known, ...known.map(camel), 'dry']);
  for (const k of Object.keys(args)) if (!allowed.has(k)) fail(`unknown flag --${k}`);

  const one = (flag, max, required) => {
    const v = args[flag];
    if (v === undefined || v === '') return required ? fail(`--${flag} is required`) : undefined;
    if (typeof v === 'boolean' || Array.isArray(v)) fail(`--${flag} needs one value`);
    const s = String(v).trim();
    if (!s) return required ? fail(`--${flag} is required`) : undefined;
    if (max && s.length > max) fail(`--${flag} is ${s.length} characters, at most ${max} allowed`);
    return s;
  };
  const list = (flag, max, count) => {
    const raw = [].concat(args[flag] ?? []).flatMap((v) => String(v).split('|')).map((s) => s.trim()).filter(Boolean);
    if (!raw.length) fail(`--${flag} is required (separate points with "|")`);
    if (raw.length > count) fail(`--${flag} has ${raw.length} points, at most ${count} allowed`);
    for (const p of raw) if (p.length > max) fail(`a point in --${flag} is ${p.length} characters, at most ${max} allowed: "${p}"`);
    return raw;
  };

  const name = one('name', 63, true);
  if (!ID.test(name)) fail(`--name "${name}" is not a valid project id (lowercase letters, digits and dashes, starting with a letter or digit)`);
  const theme = one('theme', 63) ?? 'midnight';
  if (!ID.test(theme)) fail(`--theme "${theme}" is not a theme id (built in: default, midnight)`);
  const accent = one('accent');
  if (accent !== undefined && !HEX.test(accent)) fail(`--accent "${accent}" must be a 6-digit hex colour such as #ff3366`);

  const out = { name, theme, accent, j: (v) => JSON.stringify(v) };
  for (const [flag, spec] of Object.entries(flags)) out[camel(flag)] = spec.list ? list(flag, spec.max, spec.list) : one(flag, spec.max, spec.required);
  out.title = one('title', 120) ?? out.headline;
  out.out = one('out') ?? `reels/${name}.json`;

  if (generator !== 'multi-engine') {
    const scenes = out.cta ? 2 : 1;
    const seconds = args.seconds === undefined ? 8 : Number(args.seconds);
    const { min, max } = TEMPLATES[generator];
    if (!Number.isFinite(seconds) || seconds / scenes < min || seconds / scenes > max)
      fail(`--seconds ${args.seconds} gives ${scenes} scene(s) of ${seconds / scenes} s; ${generator} scenes last ${min} to ${max} s`);
    out.sceneSeconds = seconds / scenes;
  }
  return out;
}

function usage(generator) {
  const f = FLAGS[generator];
  return Object.keys(f)
    .map((k) => `--${k} ${f[k].list ? '"<a>|<b>"' : '<text>'}`)
    .map((s, i) => (f[Object.keys(f)[i]].required ? s : `[${s}]`))
    .concat(generator === 'multi-engine' ? [] : ['[--seconds 8]'], ['[--title <text>] [--theme midnight] [--accent #rrggbb] [--out reels/<name>.json]'])
    .join(' ');
}

/** The hook module of one action: `module.exports = hook('kinetic-title')`. */
const hook = (generator) => ({ params: ({ args }) => params(generator, args) });

module.exports = { hook, params, FLAGS, TEMPLATES };

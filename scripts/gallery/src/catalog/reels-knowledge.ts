/**
 * Showcase reels, part 2: data stories, explainers, finance and coding tips,
 * tutorials and podcast clips. Numbers are either common, well-known facts
 * stated generally, or labelled as illustrative/sample data.
 */
import { CV, HFT, HT, MC, R, X, XF, type ReelSpec } from './build';

export const KNOWLEDGE: ReelSpec[] = [
  /* ---------------- data / news story ---------------- */
  {
    slug: 'remote-work-data-story',
    title: 'Where the work week goes',
    category: 'Data story',
    tags: ['data', 'charts', 'work'],
    palette: 'midnight',
    featured: true,
    prompt:
      'Make a data-story reel about how a typical knowledge worker spends the week, using clearly labelled sample data: a hook, a horizontal bar chart, a donut for meeting share, and a takeaway. Midnight theme, 17 seconds.',
    scenes: [
      R(2.5, 'Where does your week go?', 'A sample week, in charts'),
      X('bars', 5.5, { eyebrow: 'Hours per week', title: 'A sample week', bars: [{ label: 'Meetings', value: 14, suffix: ' h' }, { label: 'Focused work', value: 11, suffix: ' h' }, { label: 'Email & chat', value: 9, suffix: ' h' }, { label: 'Admin', value: 6, suffix: ' h' }], highlight: 1, source: 'Sample data for illustration' }),
      X('donut', 5, { title: 'Meetings share', percent: 35, label: 'of a 40-hour week', legend: [{ label: 'Meetings' }, { label: 'Everything else', color: 'accent2' }] }),
      X('tip', 4, { n: 1, topic: 'Takeaway', tip: ['Guard two', 'mornings a week'], detail: 'Book them like *meetings*', icon: 'cal' }),
    ],
  },
  {
    slug: 'city-cycling-growth',
    title: 'City cycling growth',
    category: 'Data story',
    tags: ['data', 'urban', 'transport'],
    palette: 'forest',
    music: 'ambient',
    prompt:
      'A data reel for a fictional city, Riverton, showing cycling trips growing after new bike lanes: a line chart, a stat, and a bar comparison by district. Sample data, forest palette, 16 seconds.',
    scenes: [
      X('line', 6, { eyebrow: 'Riverton (fictional)', title: 'Daily bike trips', points: [4.2, 4.5, 4.4, 5.6, 6.8, 7.4, 8.9, 10.2], value: 10200, caption: 'since the new lanes opened', labels: ['2019', '2021', '2023'] }),
      X('stat', 4, { value: 142, suffix: '%', label: 'more trips in four years', note: 'Sample data' }),
      X('bars', 6, { title: 'Trips by district', bars: [{ label: 'Old Town', value: 3400 }, { label: 'Harbour', value: 2900 }, { label: 'Hillside', value: 1200 }, { label: 'Riverside', value: 2700 }], highlight: 0, source: 'Fictional city, sample data' }),
    ],
  },
  {
    slug: 'renewables-share-story',
    title: 'Renewables share',
    category: 'Data story',
    tags: ['data', 'energy', 'climate'],
    palette: 'ocean',
    prompt:
      'Make an explainer data reel on a fictional country\'s electricity mix: donut for renewable share, bars by source, a globe scene for context and a closing line. Sample data clearly labelled, ocean palette, 18 seconds.',
    scenes: [
      CV('globe', 4.5, { eyebrow: 'Energy mix', lines: ['Where power', 'comes from'] }),
      X('donut', 5, { title: 'Renewable share', percent: 58, label: 'of electricity in 2024 (sample)', legend: [{ label: 'Renewable' }, { label: 'Other', color: 'accent2' }] }),
      X('bars', 5, { title: 'By source (sample)', bars: [{ label: 'Wind', value: 31, suffix: '%' }, { label: 'Solar', value: 17, suffix: '%' }, { label: 'Hydro', value: 10, suffix: '%' }, { label: 'Gas', value: 28, suffix: '%' }], highlight: 0, source: 'Sample data for a fictional country' }),
      HT(3.5, 'Wind is now the biggest single source', 'In this sample mix', 'Takeaway'),
    ],
  },
  {
    slug: 'coffee-price-index',
    title: 'Coffee price index',
    category: 'Data story',
    tags: ['data', 'prices', 'food'],
    palette: 'ember',
    prompt:
      'A quick data reel: the price of a flat white at a fictional café over eight years, as a line chart with a counting price and a tip at the end. Ember palette, 13 seconds, sample data.',
    scenes: [
      X('line', 6.5, { title: 'Flat white price (sample)', points: [2.8, 2.9, 3.0, 3.1, 3.3, 3.7, 4.0, 4.2], prefix: '$', value: 4, suffix: '.20', caption: 'up *50%* in eight years', labels: ['2016', '2020', '2024'] }),
      X('stat', 3, { value: 50, suffix: '%', label: 'more than in 2016' }),
      R(3.5, 'Home brew is looking good', 'Sample data, fictional café'),
    ],
  },
  {
    slug: 'screen-time-weekly',
    title: 'Screen time, by app type',
    category: 'Data story',
    tags: ['data', 'wellbeing', 'phones'],
    palette: 'grape',
    prompt:
      'A data story about weekly screen time by app type, using sample data: bars, a stat on daily pickups, and a three-step "cut back" checklist. Grape palette, 16 seconds.',
    scenes: [
      X('bars', 5.5, { title: 'Hours per week (sample)', bars: [{ label: 'Social', value: 9 }, { label: 'Video', value: 7 }, { label: 'Messaging', value: 5 }, { label: 'Reading', value: 2 }], highlight: 0, source: 'Sample data' }),
      XF('stat', 4, { value: 96, label: 'phone pickups a day', note: 'Sample figure' }),
      X('checklist', 6.5, { title: 'Cut it back', items: ['Grey-scale after *9pm*', 'Move social apps off page one', 'Charge it outside the bedroom'], mark: 'num' }),
    ],
  },
  {
    slug: 'election-turnout-explainer',
    title: 'Turnout by age group',
    category: 'Data story',
    tags: ['data', 'civics', 'charts'],
    palette: 'cobalt',
    prompt:
      'A neutral civic data reel on voter turnout by age group in a fictional town election: bars, a donut for overall turnout and an encouraging close. Sample data, cobalt palette, 15 seconds.',
    scenes: [
      X('bars', 6, { eyebrow: 'Fictional town', title: 'Turnout by age', bars: [{ label: '18–29', value: 41, suffix: '%' }, { label: '30–49', value: 58, suffix: '%' }, { label: '50–64', value: 69, suffix: '%' }, { label: '65+', value: 76, suffix: '%' }], highlight: 0, source: 'Sample data' }),
      X('donut', 5, { title: 'Overall turnout', percent: 61, label: 'of registered voters (sample)' }),
      HFT(4, 'Every vote moves the line', 'Check your registration'),
    ],
  },

  /* ---------------- educational explainer ---------------- */
  {
    slug: 'how-solar-panels-work',
    title: 'How solar panels work',
    category: 'Explainer',
    tags: ['education', 'science', 'energy'],
    palette: 'cobalt',
    featured: true,
    prompt:
      'An educational explainer: how a solar panel turns light into electricity, in four plain steps, with a hook and a calm line-art outro. Cobalt palette, 18 seconds.',
    scenes: [
      R(2.5, 'How does a solar panel work?', 'In four steps'),
      X('step', 3.5, { step: 1, of: 4, title: ['Light hits', 'silicon'], text: 'Photons carry energy', icon: 'sun' }),
      X('step', 3.5, { step: 2, of: 4, title: ['Electrons', 'break free'], text: 'The energy knocks them loose', icon: 'bolt' }),
      MC(4.5, 'Then', ['An electric field pushes them one way (step 3)', 'Wires carry the current out to your home (step 4)']),
      CV('flow', 4, { lines: ['Sunlight in', 'Power out'] }),
    ],
  },
  {
    slug: 'why-the-sky-is-blue',
    title: 'Why the sky is blue',
    category: 'Explainer',
    tags: ['education', 'physics'],
    palette: 'ocean',
    prompt:
      'A short science explainer: why the sky is blue (Rayleigh scattering) in plain words, with a hook, three points and a takeaway. Ocean palette, 14 seconds.',
    scenes: [
      HT(3, 'Why is the sky blue?', 'It is about how light scatters', 'SCIENCE IN 15 SECONDS'),
      MC(6.5, 'Rayleigh scattering', ['Sunlight holds every colour', 'Air molecules scatter short (blue) waves the most', 'So blue light reaches your eyes from all over the sky']),
      X('tip', 4.5, { n: 1, topic: 'Bonus', tip: ['Sunsets are red', 'for the same', 'reason'], detail: 'Light crosses *more air*', icon: 'sun' }),
    ],
  },
  {
    slug: 'compound-interest-explainer',
    title: 'Compound interest, visually',
    category: 'Explainer',
    tags: ['education', 'finance', 'math'],
    palette: 'mint',
    music: 'ambient',
    prompt:
      'Explain compound interest visually: a live line chart growing $1,000 at 7% for 10 years, then the formula in plain words, then a takeaway. Not financial advice. Mint palette, 16 seconds.',
    scenes: [
      CV('liveChart', 6, { lines: ['Compound', 'interest'], start: 1000, end: 1967, label: '$1,000 at 7% a year, 10 years' }),
      MC(5.5, 'Why it snowballs', ['You earn interest on your interest', 'Time matters more than the rate', 'Small, early beats big, late']),
      HT(4.5, 'Start small. Start early', 'Education only, not financial advice', 'Takeaway'),
    ],
  },
  {
    slug: 'how-vaccines-train-immunity',
    title: 'How the immune system learns',
    category: 'Explainer',
    tags: ['education', 'biology', 'health'],
    palette: 'rose',
    prompt:
      'A friendly biology explainer on how the immune system learns to recognise germs, in three steps, using a timeline. General education only. Rose palette, 15 seconds.',
    scenes: [
      R(2.5, 'How your body learns to fight', 'A 15-second biology lesson'),
      X('timeline', 7, { title: 'Learning|a germ', steps: [{ when: 'Day 1', what: 'Cells spot something new' }, { when: 'Days 3–7', what: 'They build matching antibodies' }, { when: 'Later', what: 'Memory cells remember it' }] }),
      X('tip', 5.5, { n: 1, topic: 'Biology', tip: ['Memory makes the', 'second time faster'], detail: 'That is the idea behind *immunity*', icon: 'shield' }),
    ],
  },
  {
    slug: 'what-is-an-api',
    title: 'What is an API?',
    category: 'Explainer',
    tags: ['education', 'tech', 'beginner'],
    palette: 'electric',
    prompt:
      'Explain "what is an API" to a beginner: restaurant analogy as steps, an orbit visual of apps talking to one API, and a one-line definition. Electric palette, 17 seconds.',
    scenes: [
      HFT(2.5, 'What is an API?', 'The restaurant version'),
      MC(6, 'Think of a restaurant', ['You (the app) read the menu', 'The waiter (the API) takes your order', 'The kitchen (the server) makes it']),
      CV('orbit', 5, { lines: ['Apps talk', 'through APIs'], nodes: ['Weather', 'Maps', 'Payments', 'Login', 'Chat'], core: 'API' }),
      HT(3.5, 'An API is a menu for software', undefined, 'Definition'),
    ],
  },
  {
    slug: 'how-to-read-a-chart',
    title: 'How to read a line chart',
    category: 'Explainer',
    tags: ['education', 'data-literacy'],
    palette: 'paper',
    prompt:
      'A data literacy explainer: how to read a line chart honestly. Show a line chart, then three checks (axis start, time range, source). Paper palette, 15 seconds.',
    scenes: [
      X('line', 5.5, { title: 'Looks dramatic…', points: [100, 101, 100.5, 102, 103, 102.5, 104, 105], value: 5, suffix: '%', caption: 'growth, on a *zoomed* axis', labels: ['Mon', 'Wed', 'Fri'] }),
      X('checklist', 6, { title: 'Three checks', items: ['Where does the *y-axis* start?', 'What time range is shown?', 'Who made the data?'], mark: 'num' }),
      R(3.5, 'Read the axis first'),
    ],
  },

  /* ---------------- finance tip (no crypto) ---------------- */
  {
    slug: 'emergency-fund-tip',
    title: 'Emergency fund rule of thumb',
    category: 'Finance tip',
    tags: ['finance', 'saving', 'tip'],
    palette: 'mint',
    prompt:
      'A personal finance tip reel: build an emergency fund of three to six months of expenses. Tip card, a meter stat and steps. Education only. Mint palette, 15 seconds.',
    scenes: [
      X('tip', 4.5, { n: 1, topic: 'Money', tip: ['Build a', '3–6 month', 'cushion'], detail: 'Of *essential* expenses', icon: 'shield' }),
      X('stat', 4.5, { eyebrow: 'Goal', value: 6, suffix: ' months', label: 'of expenses, saved', meter: 0.5, note: 'Halfway there? Keep going' }),
      MC(6, 'How to start', ['Automate a small transfer on payday', 'Keep it in a separate account', 'Refill it after you use it']),
    ],
  },
  {
    slug: 'fifty-thirty-twenty-budget',
    title: 'The 50/30/20 budget',
    category: 'Finance tip',
    tags: ['finance', 'budget', 'tip'],
    palette: 'cream',
    music: 'lofi',
    prompt:
      'Explain the 50/30/20 budgeting rule with a donut and bars, then a takeaway card. Education only, cream palette, 14 seconds.',
    scenes: [
      X('donut', 5, { title: 'The 50/30/20 rule', percent: 50, label: 'needs: rent, food, bills', legend: [{ label: 'Needs 50' }, { label: 'Wants 30', color: 'accent2' }, { label: 'Savings 20', color: 'x3' }] }),
      X('bars', 5, { title: 'On a $3,000 month', bars: [{ label: 'Needs', value: 1500, suffix: '' }, { label: 'Wants', value: 900 }, { label: 'Savings', value: 600 }], highlight: 2 }),
      HT(4, 'Pay your savings first', 'Education, not financial advice', 'Tip'),
    ],
  },
  {
    slug: 'subscription-audit-tip',
    title: 'Subscription audit',
    category: 'Finance tip',
    tags: ['finance', 'subscriptions', 'tip'],
    palette: 'volt',
    prompt:
      'A tip reel about auditing your subscriptions: notification stack of renewals, a yearly-cost stat, and a 3-step checklist. Volt palette, 15 seconds.',
    scenes: [
      X('notifications', 4.5, { title: 'Renews|tomorrow…', items: [{ app: 'Streamly', text: '$15.99 renews tomorrow' }, { app: 'FitPlus', text: '$29 renews Friday' }, { app: 'CloudBox', text: '$9.99 renews Monday' }] }),
      X('stat', 4.5, { prefix: '$', value: 659, label: 'a year for those three', note: 'Fictional services' }),
      X('checklist', 6, { title: 'Audit in 10 min', items: ['List every renewal', 'Cancel what you did not open', 'Set reminders for trials'] }),
    ],
  },
  {
    slug: 'index-funds-basics',
    title: 'Index funds in 15 seconds',
    category: 'Finance tip',
    tags: ['finance', 'investing', 'education'],
    palette: 'midnight',
    prompt:
      'A plain-language explainer on index funds: what they are, why fees matter (live chart), and a reminder that this is education, not advice. Midnight theme, 16 seconds.',
    scenes: [
      R(2.5, 'What is an index fund?', 'Education, not advice'),
      MC(5.5, 'In plain words', ['A fund that buys a whole market index', 'Low fees, because nobody picks stocks', 'Spreads your risk across many companies']),
      CV('liveChart', 5.5, { lines: ['Fees compound', 'too'], start: 10000, end: 18200, label: 'illustrative growth with a 0.1% fee' }),
      HT(2.5, 'Read the fee before the fund', undefined, 'Takeaway'),
    ],
  },
  {
    slug: 'pay-yourself-first',
    title: 'Pay yourself first',
    category: 'Finance tip',
    tags: ['finance', 'habits', 'tip'],
    palette: 'sand',
    prompt:
      'A motivational money habit reel: "pay yourself first". Manifesto words, a step card and a stat about saving 10%. Sand palette, 13 seconds.',
    scenes: [
      X('manifesto', 3.5, { words: ['Pay', 'yourself', 'first'] }),
      X('step', 4.5, { step: 1, of: 1, title: ['Move 10% on', 'payday'], text: '*Before* you spend anything', icon: 'arrow' }),
      X('stat', 5, { prefix: '$', value: 3600, label: 'a year on a $3,000 month', meter: 0.4 }),
    ],
  },

  /* ---------------- coding tips ---------------- */
  {
    slug: 'typescript-satisfies-tip',
    title: 'TypeScript: satisfies',
    category: 'Coding tip',
    tags: ['coding', 'typescript', 'tip'],
    palette: 'electric',
    featured: true,
    prompt:
      'A coding tip reel about TypeScript\'s satisfies operator: hook, code editor typing an example, and a two-point summary. Electric palette, 16 seconds.',
    scenes: [
      HFT(2.5, 'Stop widening your types', 'TypeScript tip: satisfies'),
      X('code', 7, { title: 'Use satisfies', file: 'config.ts', code: ['`type` Route = { path: `string` };', '', '`const` routes = {', '  home: { path: "/" },', '  docs: { path: "/docs" },', '} `satisfies` Record<`string`, Route>;', '', 'routes.docs.path; ~// still typed~'], result: 'tsc --noEmit' }),
      MC(6.5, 'Why it helps', ['Checks the shape like an annotation', 'Keeps the exact keys and literal types']),
    ],
  },
  {
    slug: 'git-undo-last-commit',
    title: 'Git: undo the last commit',
    category: 'Coding tip',
    tags: ['coding', 'git', 'tip'],
    palette: 'default',
    music: 'lofi',
    prompt:
      'A git tip: how to undo the last commit but keep the changes. Code editor with the commands, a versus of soft vs hard reset, and a warning. Default theme, 16 seconds.',
    scenes: [
      X('code', 6, { title: 'Undo, keep changes', file: 'terminal', code: ['~# undo the commit, keep files staged~', 'git reset --soft HEAD~1', '', '~# undo and unstage~', 'git reset HEAD~1'], result: 'changes still in your tree' }),
      X('versus', 6, { title: '--soft vs --hard', left: '--soft', right: '--hard', rows: [{ label: 'Keeps your edits', left: true, right: false }, { label: 'Safe to try', left: true, right: false }, { label: 'Cleans everything', left: false, right: true }] }),
      HT(4, 'Never --hard on shared work', 'Pushed already? Use git revert', 'Warning'),
    ],
  },
  {
    slug: 'css-container-queries',
    title: 'CSS container queries',
    category: 'Coding tip',
    tags: ['coding', 'css', 'frontend'],
    palette: 'grape',
    prompt:
      'Front-end tip: CSS container queries in 15 seconds, with a typed code example and a checklist of when to use them. Grape palette.',
    scenes: [
      X('code', 7, { title: 'Style by container', file: 'card.css', code: ['.cards { `container-type`: inline-size; }', '', '`@container` (min-width: 480px) {', '  .card { display: grid;', '    grid-template-columns: 1fr 2fr; }', '}'], result: 'works in all modern browsers' }),
      X('checklist', 5, { title: 'Use them when', items: ['A component lives in many layouts', 'Sidebars and grids resize it', 'Media queries feel wrong'] }),
      R(3, 'Components, not pages'),
    ],
  },
  {
    slug: 'python-list-comprehension',
    title: 'Python: comprehensions',
    category: 'Coding tip',
    tags: ['coding', 'python', 'beginner'],
    palette: 'forest',
    prompt:
      'Beginner Python tip: turn a for-loop into a list comprehension. Before/after code and a rule of thumb. Forest palette, 15 seconds.',
    scenes: [
      X('code', 5.5, { title: 'The long way', file: 'loop.py', code: ['squares = []', '`for` n `in` range(10):', '    `if` n % 2 == 0:', '        squares.append(n * n)'] }),
      X('code', 5, { title: 'One line', file: 'comprehension.py', code: ['squares = [n * n `for` n `in` range(10)', '           `if` n % 2 == 0]'], result: '[0, 4, 16, 36, 64]' }),
      X('tip', 4.5, { n: 1, topic: 'Python', tip: ['If it needs', 'two lines,', 'use a loop'], detail: 'Readable beats *clever*', icon: 'code' }),
    ],
  },
  {
    slug: 'sql-index-tip',
    title: 'SQL: add the right index',
    category: 'Coding tip',
    tags: ['coding', 'sql', 'performance'],
    palette: 'ocean',
    prompt:
      'Database tip: why an index on the column you filter by makes queries fast. Code snippet, a bar chart comparing query time (illustrative), and a takeaway. Ocean palette, 16 seconds.',
    scenes: [
      X('code', 6, { title: 'Index what you filter', file: 'migration.sql', code: ['`SELECT` * `FROM` orders', '`WHERE` customer_id = 42;', '', '`CREATE INDEX` orders_customer_idx', '  `ON` orders (customer_id);'], result: 'Index Scan using orders_customer_idx' }),
      X('bars', 5.5, { title: 'Query time (illustrative)', bars: [{ label: 'No index', value: 840, suffix: ' ms' }, { label: 'With index', value: 3, suffix: ' ms' }], highlight: 1, source: '1M rows, local test, illustrative' }),
      HT(4.5, 'EXPLAIN before you optimise', undefined, 'Takeaway'),
    ],
  },
  {
    slug: 'regex-email-warning',
    title: 'Don\'t validate email with regex',
    category: 'Coding tip',
    tags: ['coding', 'regex', 'opinion'],
    palette: 'sunset',
    prompt:
      'A spicy coding tip: stop trying to validate email addresses with a giant regex. Show the regex, a "do this instead" checklist, and a punchline. Sunset palette, 14 seconds.',
    scenes: [
      X('code', 5, { title: 'Please don\'t', file: 'validate.js', code: ['`const` re = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;', '~// and 400 more characters…~'] }),
      X('checklist', 5.5, { title: 'Do this instead', items: ['Check for an *@*', 'Send a confirmation link', 'Let the inbox decide'] }),
      R(3.5, 'The inbox is the validator'),
    ],
  },
  {
    slug: 'debounce-in-six-lines',
    title: 'Debounce in six lines',
    category: 'Coding tip',
    tags: ['coding', 'javascript', 'snippet'],
    palette: 'mono',
    prompt:
      'A monochrome coding snippet reel: a debounce function typed out, then where to use it. Mono palette, 13 seconds.',
    scenes: [
      X('code', 7.5, { title: 'Debounce, six lines', file: 'debounce.ts', code: ['`export function` debounce(fn, ms) {', '  `let` t;', '  `return` (...args) => {', '    clearTimeout(t);', '    t = setTimeout(() => fn(...args), ms);', '  };', '}'], result: 'search fires once per pause' }),
      X('checklist', 5.5, { title: 'Use it for', items: ['Search boxes', 'Window resize', 'Autosave'] }),
    ],
  },

  /* ---------------- tutorial steps ---------------- */
  {
    slug: 'tutorial-brand-theme',
    title: 'Tutorial: give a reel your brand',
    category: 'Tutorial',
    tags: ['tutorial', 'reelforge', 'themes'],
    palette: 'default',
    featured: true,
    prompt:
      'A tutorial reel for ReelForge users: how an agent applies a brand theme to a project in three steps (list themes, set theme, render), with code and a stepper. Default theme, 18 seconds.',
    scenes: [
      R(2.5, 'Your brand on every reel', 'Three MCP calls'),
      X('step', 3.5, { step: 1, of: 3, title: ['List the', 'themes'], text: 'Call *list_themes*', icon: 'layers' }),
      X('code', 6, { title: 'Then set it', file: 'agent → MCP', code: ['set_theme({', '  projectId: "spring-promo",', '  theme: { base: "midnight",', '    tokens: { colors: { accent: "#ffcc00" } } }', '})'], result: 'theme applied' }),
      X('step', 3, { step: 3, of: 3, title: ['Render'], text: 'Call *render_project*', icon: 'play' }),
      HT(3, 'Same reel. Your colours', undefined, 'Done'),
    ],
  },
  {
    slug: 'tutorial-pour-over',
    title: 'Tutorial: perfect pour-over',
    category: 'Tutorial',
    tags: ['tutorial', 'coffee', 'how-to'],
    palette: 'sand',
    music: 'lofi',
    prompt:
      'A four-step pour-over coffee tutorial: ratio, bloom, pour, wait — one step card each with a timer at the end. Sand palette, 18 seconds.',
    scenes: [
      X('step', 4, { step: 1, of: 4, title: ['1 g coffee to', '16 g water'], text: 'Medium-fine grind', icon: 'cup' }),
      X('step', 4, { step: 2, of: 4, title: ['Bloom for', '30 seconds'], text: 'Just enough water to *wet* it', icon: 'clock' }),
      X('step', 4, { step: 3, of: 4, title: ['Pour in', 'slow circles'], text: 'Keep the bed *flat*', icon: 'wave' }),
      X('timer', 6, { move: 'Wait', reps: 180, sets: 'Step 4 of 4', cue: 'Done at about *3 minutes*' }),
    ],
  },
  {
    slug: 'tutorial-password-manager',
    title: 'Tutorial: set up a password manager',
    category: 'Tutorial',
    tags: ['tutorial', 'security', 'how-to'],
    palette: 'midnight',
    prompt:
      'A security tutorial: set up a password manager in three steps, with a checklist and a closing tip about two-factor authentication. Midnight theme, 15 seconds.',
    scenes: [
      HFT(2.5, 'One password to rule them all', 'Set up a password manager'),
      MC(6, 'Three steps', ['Pick a manager and set one long passphrase', 'Import or save logins as you go', 'Replace reused passwords, worst first']),
      X('tip', 6.5, { n: 2, topic: 'Security', tip: ['Turn on', 'two-factor', 'too'], detail: 'An *app* beats SMS', icon: 'lock' }),
    ],
  },
  {
    slug: 'tutorial-plant-propagation',
    title: 'Tutorial: propagate a pothos',
    category: 'Tutorial',
    tags: ['tutorial', 'plants', 'home'],
    palette: 'forest',
    prompt:
      'A plant tutorial: propagate a pothos cutting in water in four steps, as a timeline. Forest palette, 14 seconds.',
    scenes: [
      X('timeline', 7.5, { title: 'Pothos in|four steps', steps: [{ when: 'Step 1', what: 'Cut below a node' }, { when: 'Step 2', what: 'Put it in water' }, { when: 'Weeks 2–4', what: 'Roots appear' }, { when: 'Then', what: 'Pot it in soil' }] }),
      X('tip', 6.5, { n: 1, topic: 'Plants', tip: ['Change the water', 'every week'], detail: 'Bright, *indirect* light', icon: 'leaf' }),
    ],
  },

  /* ---------------- podcast clips ---------------- */
  {
    slug: 'podcast-build-notes-ep42',
    title: 'Build Notes, episode 42 clip',
    category: 'Podcast clip',
    tags: ['podcast', 'quote', 'captions'],
    palette: 'default',
    featured: true,
    music: 'ambient',
    prompt:
      'Turn a quote from the fictional podcast "Build Notes" into a clip: waveform, episode title, word-by-word captions, then an end card. Default theme, 14 seconds.',
    scenes: [
      X('podcast', 9, { show: 'Build Notes', episode: 'Ep. 42 · Shipping small', caption: 'Ship the smallest thing that teaches you something real, then do it again tomorrow', host: 'Alex Example' }),
      X('outro', 5, { brand: 'Build Notes', line: 'New episodes *every Tuesday*', button: 'Listen now' }),
    ],
  },
  {
    slug: 'podcast-slow-money-clip',
    title: 'Slow Money podcast clip',
    category: 'Podcast clip',
    tags: ['podcast', 'finance', 'captions'],
    palette: 'sunset',
    prompt:
      'A clip from the fictional podcast "Slow Money": captions word by word over a waveform, then a key takeaway title. Sunset palette, 13 seconds.',
    scenes: [
      X('podcast', 8.5, { show: 'Slow Money', episode: 'Ep. 7 · Boring is beautiful', caption: 'The boring plan you actually stick to beats the perfect plan you quit in March', host: 'Casey Sample' }),
      R(4.5, 'Boring is beautiful', 'Slow Money, episode 7'),
    ],
  },
  {
    slug: 'podcast-design-talk',
    title: 'Design Talk podcast clip',
    category: 'Podcast clip',
    tags: ['podcast', 'design', 'captions'],
    palette: 'cream',
    prompt:
      'Podcast clip for the fictional show "Design Talk": waveform and captions, then a three-point recap. Cream palette, 15 seconds.',
    scenes: [
      X('podcast', 8, { show: 'Design Talk', episode: 'Ep. 19 · Defaults matter', caption: 'Most people never change a setting, so the default is the design', host: 'Jamie Placeholder' }),
      MC(7, 'From this episode', ['Defaults decide behaviour', 'Make the safe choice the easy one', 'Test with people who never open settings']),
    ],
  },
  {
    slug: 'podcast-founder-stories',
    title: 'Founder Stories clip',
    category: 'Podcast clip',
    tags: ['podcast', 'startup', 'captions'],
    palette: 'electric',
    music: 'pulse',
    prompt:
      'A punchy clip from the fictional podcast "Founder Stories" with captions, then a radial equalizer outro. Electric palette, 14 seconds.',
    scenes: [
      X('podcast', 8.5, { show: 'Founder Stories', episode: 'Ep. 88 · First ten customers', caption: 'Your first ten customers come from conversations, not campaigns', host: 'Taylor Example' }),
      CV('equalizer', 5.5, { lines: ['Founder', 'Stories'], sub: 'Every Thursday', bpm: 96 }),
    ],
  },
];

/**
 * Showcase reels, part 1: product launches, SaaS demos, app promos, shops,
 * hiring, changelogs, comparisons, before/after and quote cards. Every brand,
 * product, person and number here is fictional and illustrative.
 */
import { CV, HFT, HT, MC, R, X, XF, type ReelSpec } from './build';

export const BUSINESS: ReelSpec[] = [
  /* ---------------- product launch ---------------- */
  {
    slug: 'lumen-desk-lamp-launch',
    title: 'Lumen desk lamp launch',
    category: 'Product launch',
    tags: ['launch', 'hardware', 'hero'],
    palette: 'ember',
    featured: true,
    music: 'drive',
    prompt:
      'Make a 16-second vertical launch reel for Lumen, a fictional smart desk lamp that adjusts colour temperature through the day. Open with a bold hook, show the product, two key numbers and end on a pre-order call to action. Warm, premium look.',
    scenes: [
      R(2.5, 'Your desk, finally lit right', 'Introducing Lumen'),
      X('product', 4.5, { name: 'Lumen', tagline: 'Light that *follows the sun*', specs: ['2700–6500 K', 'Auto-dim', 'USB-C'], shape: 'device' }),
      X('stat', 4, { eyebrow: 'Battery', value: 72, suffix: 'h', label: 'cordless on one charge', meter: 0.82, note: 'Measured at *50%* brightness' }),
      X('outro', 5, { brand: 'Lumen', line: 'Light that *follows the sun*', button: 'Pre-order now', url: 'lumen.example' }),
    ],
  },
  {
    slug: 'aero-headphones-reveal',
    title: 'Aero headphones reveal',
    category: 'Product launch',
    tags: ['launch', 'audio', 'reveal'],
    palette: 'mono',
    featured: true,
    music: 'pulse',
    prompt:
      'Create a minimal black-and-white reveal reel for Aero, fictional noise-cancelling headphones. Kinetic headline, a slow 3D product turn with spec callouts, a feature grid, and a clean end card. 15 seconds, no colour except greys.',
    scenes: [
      X('manifesto', 3, { words: ['Less', 'noise', 'More you'] }),
      X('product', 5, { name: 'Aero', tagline: 'Silence, *rebuilt*', specs: ['40 h battery', 'Adaptive ANC', '250 g'], shape: 'headphones' }),
      X('featureGrid', 4, { title: 'Made for|long days', tiles: [{ icon: 'clock', label: '40 hours', text: 'per charge' }, { icon: 'wave', label: 'Adaptive', text: 'noise control' }, { icon: 'bolt', label: '10 min', text: '= 5 h play' }, { icon: 'leaf', label: 'Recycled', text: 'aluminium' }] }),
      R(3, 'Aero. Hear what matters', 'Available in two finishes'),
    ],
  },
  {
    slug: 'tide-water-bottle-drop',
    title: 'Tide bottle drop',
    category: 'Product launch',
    tags: ['launch', 'consumer', 'eco'],
    palette: 'ocean',
    music: 'bright',
    prompt:
      'A 14-second drop announcement for Tide, a fictional insulated bottle made from recycled steel. Show the bottle turning, a "24 hours cold" stat, three reasons to buy, then a launch-day countdown.',
    scenes: [
      X('product', 4.5, { name: 'Tide', tagline: 'Cold for *a whole day*', specs: ['750 ml', 'Recycled steel', 'Leak-proof'], shape: 'bottle' }),
      MC(4.5, 'Why Tide?', ['Keeps drinks cold for 24 hours', 'Made from 90% recycled steel', 'Fits every cup holder']),
      X('countdown', 5, { eyebrow: 'Drops in', label: 'Launch day', units: [{ value: 2, unit: 'days' }, { value: 9, unit: 'hrs' }, { value: 30, unit: 'min' }], date: 'Fri · 9am' }),
    ],
  },
  {
    slug: 'pulse-smartwatch-launch',
    title: 'Pulse watch launch',
    category: 'Product launch',
    tags: ['launch', 'wearable', 'health'],
    palette: 'volt',
    prompt:
      'Launch reel for Pulse, a fictional fitness watch: an energetic headline, the watch turning with specs, a seven-day battery stat and a pre-order end card. Neon-on-black, 15 seconds.',
    scenes: [
      HFT(2.5, 'Train smarter. Not longer', 'Pulse, the coach on your wrist'),
      X('product', 4.5, { name: 'Pulse', tagline: 'Your *coach* on your wrist', specs: ['GPS', 'Heart rate', '5 ATM'], shape: 'watch' }),
      X('stat', 4, { eyebrow: 'Battery', value: 7, suffix: ' days', label: 'between charges', meter: 0.7 }),
      X('outro', 4, { brand: 'Pulse', line: 'Pre-order *today*', button: 'Reserve yours', backdrop: 'grid' }),
    ],
  },
  {
    slug: 'orbit-api-launch',
    title: 'Orbit API launch',
    category: 'Product launch',
    tags: ['launch', 'developer', 'api'],
    palette: 'electric',
    featured: true,
    music: 'pulse',
    prompt:
      'Make a launch reel for Orbit, a fictional integrations API for developers. Show integrations orbiting a core, a code snippet that calls it, and a stat about setup time. Futuristic electric-blue style, about 17 seconds.',
    scenes: [
      CV('orbit', 5, { eyebrow: 'Introducing Orbit', lines: ['One API', 'Every tool'], nodes: ['CRM', 'Docs', 'Mail', 'Billing', 'Chat', 'Calendar'], core: 'Orbit' }),
      X('code', 6, { title: 'Connect in one call', file: 'sync.ts', code: ['`import` { orbit } `from` "@orbit/sdk";', '', '`const` crm = orbit.connect("crm");', '`await` crm.contacts.sync({', '  since: "7d",', '});'], result: 'synced 1,204 contacts' }),
      X('stat', 3, { value: 5, suffix: ' min', label: 'from sign-up to first sync', note: 'Median in our own tests' }),
      R(3, 'Orbit is live', 'Start free at orbit.example'),
    ],
  },
  {
    slug: 'nest-planter-launch',
    title: 'Nest planter',
    category: 'Product launch',
    tags: ['launch', 'home', 'plants'],
    palette: 'forest',
    prompt:
      'A calm, natural launch reel for Nest, a fictional self-watering planter. Headline, three-step how-it-works list, a stat on watering frequency, and an outro. Earthy greens, 15 seconds.',
    scenes: [
      X('hero', 4, { eyebrow: 'New from Nest', lines: ['Plants that', 'water', 'themselves'], sub: 'A reservoir that lasts *three weeks*', backdrop: 'split' }),
      X('checklist', 4.5, { title: 'How it works', items: ['Fill the reservoir', 'Roots drink what they need', 'Top up every *3 weeks*'], mark: 'num' }),
      X('stat', 3.5, { value: 21, suffix: ' days', label: 'between top-ups', meter: 0.75 }),
      HT(3, 'Nest. Green, without the guilt', 'nest.example', 'Available now'),
    ],
  },

  /* ---------------- SaaS feature demo ---------------- */
  {
    slug: 'fieldnote-one-click-publish',
    title: 'Fieldnote one-click publish',
    category: 'SaaS feature demo',
    tags: ['saas', 'feature', 'ui-demo'],
    palette: 'cream',
    featured: true,
    music: 'bright',
    prompt:
      'Show off the new "Publish everywhere" button in Fieldnote, a fictional content tool. Hook line, a browser mock-up where the cursor clicks Publish and a toast confirms, then the time saved. Light, friendly look, 16 seconds.',
    scenes: [
      R(2.5, 'Stop copy-pasting posts', 'Fieldnote now publishes everywhere'),
      X('browser', 6, { app: 'Fieldnote', title: 'One click. Every channel', action: 'Publish', toast: 'Published to 4 channels', rows: ['Spring launch post', 'Newsletter #48', 'Pricing update', 'Hiring post'] }),
      X('stat', 4, { value: 3, suffix: ' h', label: 'saved per week, per writer', note: 'Illustrative estimate for a 4-channel team' }),
      X('outro', 3.5, { brand: 'Fieldnote', line: 'Write once. *Publish everywhere.*', button: 'Try it free', backdrop: 'split' }),
    ],
  },
  {
    slug: 'ledgerly-auto-categorise',
    title: 'Ledgerly auto-categorise',
    category: 'SaaS feature demo',
    tags: ['saas', 'finance', 'automation'],
    palette: 'mint',
    prompt:
      'A feature reel for Ledgerly, a fictional bookkeeping app: transactions sort themselves into categories. Show a notification stack, a bar chart of categories, and a two-point summary. 15 seconds, fresh green palette.',
    scenes: [
      X('notifications', 4.5, { title: 'Receipts in.|Books done', items: [{ app: 'Ledgerly', text: 'Coffee beans → Supplies', time: '9:02' }, { app: 'Ledgerly', text: 'Train ticket → Travel', time: '9:15' }, { app: 'Ledgerly', text: 'Laptop → Equipment', time: '10:40' }] }),
      X('bars', 5, { title: 'This month by category', bars: [{ label: 'Supplies', value: 1240, suffix: '' }, { label: 'Travel', value: 860 }, { label: 'Software', value: 610 }, { label: 'Equipment', value: 2100 }], highlight: 3, source: 'Sample data' }),
      MC(5, 'Ledgerly does the sorting', ['Learns your categories from 20 examples', 'Flags anything it is unsure about']),
    ],
  },
  {
    slug: 'standup-bot-chat-demo',
    title: 'Standup bot chat demo',
    category: 'SaaS feature demo',
    tags: ['saas', 'chat', 'productivity'],
    palette: 'grape',
    music: 'lofi',
    prompt:
      'Make a playful reel for Daybreak, a fictional chat assistant that runs async standups. Show a phone with the chat, then the three things it does, then a call to action. Purple-pink palette, 14 seconds.',
    scenes: [
      X('phone', 5.5, { app: 'Daybreak', headline: 'Standups, minus the meeting', chips: ['Async', 'Summaries', 'Reminders'], screen: 'chat' }),
      X('checklist', 4.5, { title: 'Daybreak handles', items: ['Asks each teammate at *9am*', 'Posts one summary', 'Nudges blockers'], mark: 'check' }),
      HFT(4, 'Get your mornings back', 'daybreak.example'),
    ],
  },
  {
    slug: 'beacon-uptime-dashboard',
    title: 'Beacon uptime dashboard',
    category: 'SaaS feature demo',
    tags: ['saas', 'devops', 'monitoring'],
    palette: 'electric',
    prompt:
      'A reel for Beacon, a fictional uptime monitor. Start with an uptime ring at 99.98%, show response-time trend, then the alert channels. Dark technical style, 15 seconds.',
    scenes: [
      X('donut', 4.5, { title: 'Uptime, last 90 days', percent: 99, label: 'all regions, 99.98% exact', legend: [{ label: 'Up' }, { label: 'Maintenance', color: 'accent2' }] }),
      X('line', 5, { title: 'p95 response time', points: [420, 380, 400, 310, 290, 240, 230, 180], value: 180, suffix: ' ms', caption: 'down from *420 ms* after the CDN switch', labels: ['W1', 'W4', 'W8'] }),
      X('featureGrid', 5.5, { title: 'Alerts where|you are', tiles: [{ icon: 'bell', label: 'Push', text: 'in 10 s' }, { icon: 'globe', label: 'Webhook', text: 'any URL' }, { icon: 'user', label: 'On-call', text: 'rotations' }, { icon: 'shield', label: 'Status page', text: 'built in' }] }),
    ],
  },
  {
    slug: 'canvasly-templates-feature',
    title: 'Canvasly templates',
    category: 'SaaS feature demo',
    tags: ['saas', 'design', 'templates'],
    palette: 'sunset',
    prompt:
      'Promote the new template library in Canvasly, a fictional design tool. A hook, a 4-tile feature grid, a stat about template count, and an end card. Warm sunset palette, 14 seconds.',
    scenes: [
      HT(2.5, 'Blank page? Never again', 'Canvasly Templates', 'New'),
      X('featureGrid', 4.5, { title: 'Start from|something good', tiles: [{ icon: 'layers', label: 'Socials', text: '9:16, 1:1, 4:5' }, { icon: 'chart', label: 'Decks', text: 'pitch-ready' }, { icon: 'cal', label: 'Events', text: 'posters' }, { icon: 'book', label: 'Docs', text: 'one-pagers' }] }),
      X('stat', 3.5, { value: 1200, suffix: '+', label: 'templates at launch' }),
      X('outro', 3.5, { brand: 'Canvasly', line: 'Design *faster*', button: 'Browse templates' }),
    ],
  },
  {
    slug: 'inboxzero-triage-feature',
    title: 'Inbox triage feature',
    category: 'SaaS feature demo',
    tags: ['saas', 'email', 'ai-assist'],
    palette: 'midnight',
    prompt:
      'Feature reel for Sift, a fictional email client that triages your inbox. Show the before/after of a messy vs clean inbox, a stat about emails handled, and the steps to turn it on. Use the Midnight theme, 16 seconds.',
    scenes: [
      X('beforeAfter', 5.5, { title: 'Your inbox, triaged', before: { label: 'BEFORE', lines: ['214 unread', 'Everything urgent'] }, after: { label: 'AFTER', lines: ['6 need you', 'The rest: sorted'] }, visual: 'ui' }),
      X('stat', 4, { value: 208, label: 'emails filed for you this week', note: 'Example account' }),
      MC(6.5, 'Turn it on in Sift', ['Open Settings, then Triage', 'Pick what counts as important', 'Review the first day, then relax']),
    ],
  },

  /* ---------------- app store promo ---------------- */
  {
    slug: 'pocket-budget-app-promo',
    title: 'Pocket budget app',
    category: 'App promo',
    tags: ['app', 'finance', 'mobile'],
    palette: 'default',
    featured: true,
    music: 'bright',
    prompt:
      'App store promo for Pocket, a fictional budgeting app. Show the phone UI with balance and spending bars, floating feature chips, a savings stat and a download CTA. Default RenderWeld theme, 15 seconds.',
    scenes: [
      R(2.5, 'Know where your money goes', 'Pocket, the calm budget app'),
      X('phone', 5.5, { app: 'Pocket', headline: 'Money, made calm', chips: ['Instant sync', 'Private', 'Insights', 'Goals'], screen: 'finance' }),
      X('stat', 3.5, { prefix: '$', value: 312, label: 'saved in the first month', note: 'Example user, illustrative' }),
      X('outro', 3.5, { brand: 'Pocket', line: 'Free on iOS and Android', button: 'Download' }),
    ],
  },
  {
    slug: 'habitloop-app-promo',
    title: 'Habitloop app',
    category: 'App promo',
    tags: ['app', 'habits', 'wellbeing'],
    palette: 'rose',
    prompt:
      'Promo reel for Habitloop, a fictional habit tracker. Phone showing today\'s habits ticking off, a streak counter, and a feature list. Light rose palette, upbeat, 14 seconds.',
    scenes: [
      X('phone', 5, { app: 'Habitloop', headline: 'Tiny habits, big streaks', chips: ['Streaks', 'Reminders', 'Widgets'], screen: 'habits' }),
      X('stat', 4, { eyebrow: 'Streak', value: 42, suffix: ' days', label: 'and counting', meter: 0.6 }),
      MC(5, 'Why it sticks', ['Two-tap check-ins', 'Gentle reminders, never guilt', 'Widgets on your home screen']),
    ],
  },
  {
    slug: 'nightdrive-music-app',
    title: 'Nightdrive music app',
    category: 'App promo',
    tags: ['app', 'music', 'mobile'],
    palette: 'sunset',
    music: 'drive',
    prompt:
      'A moody promo for Nightdrive, a fictional music player. Phone with a now-playing screen, a radial equalizer scene and an end card. 14 seconds, sunset colours.',
    scenes: [
      X('phone', 5, { app: 'Nightdrive', headline: 'Music for the long way home', chips: ['Lossless', 'Offline', 'Lyrics'], screen: 'music' }),
      CV('equalizer', 5, { lines: ['Turn it up'], sub: 'Lossless on every plan', bpm: 104 }),
      HT(4, 'Nightdrive', 'Free for 30 days', 'Now on mobile'),
    ],
  },
  {
    slug: 'wayfind-maps-app',
    title: 'Wayfind maps app',
    category: 'App promo',
    tags: ['app', 'maps', 'travel'],
    palette: 'ocean',
    prompt:
      'App promo for Wayfind, a fictional walking-directions app: phone with a route drawing on a map, three features, and a download CTA. Ocean palette, 13 seconds.',
    scenes: [
      X('phone', 5, { app: 'Wayfind', headline: 'Walk it like a local', chips: ['Quiet streets', 'Offline maps', 'Step-free'], screen: 'map' }),
      X('checklist', 4, { title: 'Wayfind picks', items: ['Quieter streets', 'Step-free routes', 'Shade on hot days'] }),
      X('outro', 4, { brand: 'Wayfind', line: 'Get lost *less*', button: 'Download free', backdrop: 'grid' }),
    ],
  },
  {
    slug: 'threadly-shop-app',
    title: 'Threadly shop app',
    category: 'App promo',
    tags: ['app', 'shopping', 'retail'],
    palette: 'paper',
    prompt:
      'Promo for Threadly, a fictional shopping app for recycled bags: phone with a product page, a pricing card, and an outro. Clean paper-like light look, 14 seconds.',
    scenes: [
      X('phone', 5, { app: 'Threadly', headline: 'Bags with a second life', chips: ['Recycled', 'Free returns', 'Carbon-neutral'], screen: 'shop' }),
      X('pricing', 5, { plan: 'Everyday Tote', price: 49, per: 'bag', features: ['Recycled canvas', '3 colours', 'Lifetime repairs'], badge: 'Best seller' }),
      HT(4, 'Threadly', 'Shop the collection in the app', 'New season'),
    ],
  },

  /* ---------------- e-commerce / sale ---------------- */
  {
    slug: 'weekend-sale-countdown',
    title: 'Weekend sale countdown',
    category: 'E-commerce',
    tags: ['sale', 'retail', 'countdown'],
    palette: 'cobalt',
    music: 'stomp',
    prompt:
      'A punchy weekend-sale reel for a fictional homeware shop, Kiln & Co. Kinetic manifesto words, a 30% off stat, a countdown and an outro. Bold cobalt and yellow, 13 seconds.',
    scenes: [
      X('manifesto', 3, { words: ['Weekend', 'sale', 'is on'], footer: 'Kiln & Co' }),
      X('stat', 3.5, { value: 30, suffix: '% off', label: 'every mug, bowl and vase' }),
      X('countdown', 3.5, { label: 'Ends Sunday night', units: [{ value: 1, unit: 'days' }, { value: 6, unit: 'hrs' }, { value: 12, unit: 'min' }] }),
      R(3, 'Shop Kiln & Co', 'Free delivery over $40'),
    ],
  },
  {
    slug: 'coffee-subscription-offer',
    title: 'Coffee subscription offer',
    category: 'E-commerce',
    tags: ['subscription', 'food', 'offer'],
    palette: 'ember',
    prompt:
      'Promote Roastbox, a fictional coffee subscription: hook, a three-step how it works, the price card and a CTA. Warm ember palette, 15 seconds.',
    scenes: [
      HT(2.5, 'Fresh beans. Every other Monday', 'Roastbox', 'Subscription'),
      X('step', 4, { step: 1, of: 3, title: ['Pick your', 'roast'], text: 'Light, medium or *dark*', icon: 'cup' }),
      X('pricing', 5, { plan: 'Roastbox', price: 18, per: 'bag', features: ['Roasted 48 h before', 'Skip any time', 'Free shipping'], badge: 'First bag free' }),
      X('outro', 3.5, { brand: 'Roastbox', line: 'Your first bag is *on us*', button: 'Start now' }),
    ],
  },
  {
    slug: 'sneaker-drop-hype',
    title: 'Sneaker drop',
    category: 'E-commerce',
    tags: ['drop', 'fashion', 'hype'],
    palette: 'volt',
    music: 'stomp',
    prompt:
      'Hype reel for a fictional sneaker drop, "Stride 01" from Kerb. Big kinetic words, a burst moment, a countdown in hours, and an outro. Neon volt palette, 12 seconds.',
    scenes: [
      X('lyric', 3, { words: ['Stride', '01', 'drops', 'Friday'] }),
      CV('burst', 3.5, { lines: ['Kerb', 'Stride 01'], sub: '300 pairs. No restock' }),
      X('countdown', 3, { eyebrow: 'Drop', label: 'Set your alarm' }),
      HFT(2.5, 'kerb.example/stride', 'Friday 10:00'),
    ],
  },

  /* ---------------- hiring ---------------- */
  {
    slug: 'northloop-designer-hiring',
    title: 'Northloop is hiring a designer',
    category: 'Hiring',
    tags: ['hiring', 'design', 'remote'],
    palette: 'grape',
    prompt:
      'Hiring reel for Northloop, a fictional studio, looking for a Senior Product Designer (remote). Role card with chips and perks, a short "what you will do" list, and how to apply. 15 seconds.',
    scenes: [
      X('role', 5, { company: 'Northloop', role: 'Senior Product|Designer', chips: ['Remote (EU)', 'Full-time'], perks: ['4-day week', 'Learning budget', 'Home office setup'] }),
      MC(5.5, 'What you will do', ['Own the mobile app experience end to end', 'Run research with real customers every month', 'Grow our design system']),
      HT(4.5, 'Apply at northloop.example/jobs', 'We reply to everyone within a week', 'Hiring'),
    ],
  },
  {
    slug: 'kitchen-team-hiring',
    title: 'Kitchen team hiring',
    category: 'Hiring',
    tags: ['hiring', 'hospitality', 'local'],
    palette: 'sand',
    prompt:
      'A friendly hiring reel for Olive Room, a fictional neighbourhood restaurant, looking for a line cook. Role card, perks, and the shift pattern as a timeline. Warm sand palette, 14 seconds.',
    scenes: [
      X('role', 5, { company: 'Olive Room', role: 'Line Cook', chips: ['Full-time', 'Evenings'], perks: ['Staff meals', 'Paid training', 'Tips shared'] }),
      X('timeline', 5, { title: 'Your week', steps: [{ when: 'Tue–Sat', what: '4pm to midnight' }, { when: 'Sun', what: 'Brunch, every other week' }, { when: 'Mon', what: 'Always off' }] }),
      R(4, 'Come cook with us', 'Drop by with your CV'),
    ],
  },
  {
    slug: 'backend-engineer-hiring',
    title: 'Backend engineer hiring',
    category: 'Hiring',
    tags: ['hiring', 'engineering', 'startup'],
    palette: 'electric',
    prompt:
      'Hiring post for Relay, a fictional logistics startup, looking for a backend engineer. Code-flavoured: a code snippet of a job object, the role card and a hiring-process timeline. 16 seconds.',
    scenes: [
      X('code', 5.5, { file: 'jobs/backend.ts', code: ['`const` role = {', '  team: "Platform",', '  stack: ["TypeScript", "Postgres"],', '  remote: `true`,', '  oncall: "1 week in 8",', '};'], result: 'role.open === true' }),
      X('role', 5, { company: 'Relay', role: 'Backend|Engineer', chips: ['Remote', 'Senior'], perks: ['Equity', 'Hardware budget', 'Async first'] }),
      X('timeline', 5.5, { title: 'How we hire', steps: [{ when: 'Day 1', what: '30-minute intro call' }, { when: 'Week 1', what: 'Paid take-home, 3 h max' }, { when: 'Week 2', what: 'Meet the team, then offer' }] }),
    ],
  },

  /* ---------------- changelog ---------------- */
  {
    slug: 'fieldnote-changelog-3-2',
    title: 'Fieldnote 3.2 changelog',
    category: 'Changelog',
    tags: ['changelog', 'release', 'saas'],
    palette: 'cream',
    prompt:
      'Turn the Fieldnote 3.2 release notes into a reel: version badge, tagged items (new, faster, fixed), and a thank-you outro. Light cream theme, 13 seconds.',
    scenes: [
      X('changelog', 7, { product: 'Fieldnote', version: '3.2', items: [{ tag: 'NEW', text: 'Dark mode everywhere' }, { tag: 'FAST', text: 'Search is *2× faster*' }, { tag: 'UI', text: 'Cleaner editor toolbar' }, { tag: 'FIX', text: 'Sync after reconnect' }] }),
      R(3, 'Thanks for 600 bug reports', 'Keep them coming'),
      HT(3, 'Update now', 'Fieldnote 3.2 on every platform', 'Release'),
    ],
  },
  {
    slug: 'beacon-changelog-april',
    title: 'Beacon April changelog',
    category: 'Changelog',
    tags: ['changelog', 'devops'],
    palette: 'midnight',
    prompt:
      'Monthly changelog reel for Beacon, a fictional uptime monitor: four tagged items, then a stat on how many checks now run per minute. Midnight theme, 12 seconds.',
    scenes: [
      X('changelog', 6.5, { product: 'Beacon', version: '24.4', items: [{ tag: 'NEW', text: 'Status pages with custom domains' }, { tag: 'NEW', text: 'Webhook retries' }, { tag: 'FAST', text: 'Checks from 12 regions' }, { tag: 'FIX', text: 'Timezone on reports' }] }),
      X('stat', 5.5, { value: 2400, label: 'checks per minute, on average', note: 'Illustrative figure' }),
    ],
  },
  {
    slug: 'pocket-changelog-widgets',
    title: 'Pocket widgets update',
    category: 'Changelog',
    tags: ['changelog', 'mobile', 'app'],
    palette: 'default',
    prompt:
      'A short update reel for Pocket (fictional budget app) announcing home-screen widgets: notification stack, changelog card, and outro. Default theme, 14 seconds.',
    scenes: [
      X('notifications', 4.5, { title: 'Budgets on your|home screen', items: [{ app: 'Pocket', text: 'Groceries: $82 left this week' }, { app: 'Pocket', text: 'Rent saved: on track' }, { app: 'Pocket', text: 'New: lock-screen widget' }] }),
      X('changelog', 5.5, { product: 'Pocket', version: '5.0', items: [{ tag: 'NEW', text: 'Home-screen widgets' }, { tag: 'UI', text: 'Bigger numbers' }, { tag: 'FIX', text: 'Faster bank sync' }] }),
      HFT(4, 'Update Pocket today', 'Free for everyone'),
    ],
  },

  /* ---------------- comparison ---------------- */
  {
    slug: 'manual-vs-agent-editing',
    title: 'Manual vs agent editing',
    category: 'Comparison',
    tags: ['comparison', 'workflow', 'agents'],
    palette: 'default',
    featured: true,
    prompt:
      'Compare editing short videos by hand with letting an agent write the scene manifest and render it. A versus table, a bar chart of time spent per reel, and a closing line. Keep the claims general. Default theme, 16 seconds.',
    scenes: [
      R(2.5, 'Editing by hand vs with an agent'),
      X('versus', 6, { title: 'Same reel, two ways', left: 'By hand', right: 'Agent', rows: [{ label: 'Repeatable', left: false, right: true }, { label: 'Brand theme', left: true, right: true }, { label: 'Batch of 20', left: false, right: true }, { label: 'Your machine', left: true, right: true }] }),
      X('bars', 5, { title: 'Minutes per reel', bars: [{ label: 'By hand', value: 45 }, { label: 'Template tool', value: 20 }, { label: 'Agent + manifest', value: 6 }], highlight: 2, source: 'Illustrative, varies by reel' }),
      HT(2.5, 'Let the agent do the timeline', undefined, 'Takeaway'),
    ],
  },
  {
    slug: 'rent-vs-buy-comparison',
    title: 'Rent vs buy software',
    category: 'Comparison',
    tags: ['comparison', 'finance', 'software'],
    palette: 'sand',
    prompt:
      'Explain renting software by subscription versus buying it once, with a versus table and a simple cumulative cost line chart. Neutral, honest tone with illustrative numbers. Sand palette, 15 seconds.',
    scenes: [
      X('versus', 6, { title: 'Rent or own?', left: 'Rent', right: 'Own', rows: [{ label: 'Low cost up front', left: true, right: false }, { label: 'Cost after 3 years', left: false, right: true }, { label: 'Runs offline', left: false, right: true }, { label: 'Updates included', left: true, right: false }] }),
      X('line', 5.5, { title: 'Cumulative cost (example)', points: [10, 20, 30, 40, 50, 60, 70, 80], prefix: '$', value: 960, caption: 'a $40/month plan after *2 years*', labels: ['M1', 'M12', 'M24'] }),
      MC(3.5, 'It depends on', ['How long you will use it', 'Who runs the servers']),
    ],
  },
  {
    slug: 'espresso-vs-pourover',
    title: 'Espresso vs pour-over',
    category: 'Comparison',
    tags: ['comparison', 'coffee', 'lifestyle'],
    palette: 'ember',
    prompt:
      'A fun comparison reel: espresso vs pour-over coffee. Versus table and two quick stats. Warm ember look, 13 seconds.',
    scenes: [
      X('versus', 6, { title: 'Espresso vs pour-over', left: 'Espresso', right: 'Pour-over', rows: [{ label: 'Under 1 minute', left: true, right: false }, { label: 'Cheap gear', left: false, right: true }, { label: 'Bright, clear taste', left: false, right: true }, { label: 'Makes a latte', left: true, right: false }] }),
      X('stat', 3.5, { value: 25, suffix: ' s', label: 'a classic espresso shot' }),
      X('stat', 3.5, { value: 4, suffix: ' min', label: 'a slow pour-over' }),
    ],
  },

  /* ---------------- before / after ---------------- */
  {
    slug: 'living-room-refresh',
    title: 'Living room refresh',
    category: 'Before & after',
    tags: ['before-after', 'interior', 'home'],
    palette: 'sand',
    featured: true,
    prompt:
      'Before-and-after reel for a fictional interior studio, Hearth: a dull room becomes warm and layered, with a three-tip list after. Sand palette, 15 seconds.',
    scenes: [
      HT(2.5, 'Same room. New light', 'A weekend refresh by Hearth', 'Before / after'),
      X('beforeAfter', 6, { title: 'Same room, new light', before: { label: 'BEFORE', lines: ['One ceiling light', 'Bare walls'] }, after: { label: 'AFTER', lines: ['Three warm lamps', 'Plants and texture'] }, visual: 'room' }),
      X('checklist', 6.5, { title: 'Steal these tips', items: ['Light at *three heights*', 'Warm bulbs (2700 K)', 'One big plant'], mark: 'num' }),
    ],
  },
  {
    slug: 'dashboard-redesign',
    title: 'Dashboard redesign',
    category: 'Before & after',
    tags: ['before-after', 'design', 'saas'],
    palette: 'midnight',
    prompt:
      'Show a fictional analytics dashboard redesign as a before/after wipe, then the improvements as a checklist. Midnight theme, 14 seconds.',
    scenes: [
      X('beforeAfter', 6, { title: 'Dashboard, redesigned', before: { label: 'V1', lines: ['14 charts', 'No hierarchy'] }, after: { label: 'V2', lines: ['4 key numbers', 'Details on demand'] }, visual: 'ui' }),
      X('checklist', 5, { title: 'What changed', items: ['Four numbers up top', 'Details one click away', 'Readable on a phone'] }),
      R(3, 'Less on screen. More understood'),
    ],
  },
  {
    slug: 'sales-growth-before-after',
    title: 'Sales after the rebrand',
    category: 'Before & after',
    tags: ['before-after', 'growth', 'marketing'],
    palette: 'cobalt',
    prompt:
      'A before/after growth reel for a fictional bakery after a rebrand: flat vs rising bar charts, then a line chart. Use clearly illustrative numbers. Cobalt palette, 14 seconds.',
    scenes: [
      X('beforeAfter', 6, { title: 'Six months, two stories', before: { label: 'BEFORE', lines: ['Flat weekends'] }, after: { label: 'AFTER', lines: ['Sold out by noon'] }, visual: 'chart' }),
      X('line', 5, { title: 'Weekly loaves (example)', points: [120, 118, 130, 160, 190, 230, 260, 300], value: 300, caption: '*2.5×* in six months', labels: ['Jan', 'Mar', 'Jun'] }),
      HFT(3, 'Small shop. Big glow-up', 'Illustrative numbers'),
    ],
  },

  /* ---------------- quote cards (fictional) ---------------- */
  {
    slug: 'quote-card-studio-producer',
    title: 'Quote card: studio producer',
    category: 'Quote card',
    tags: ['quote', 'social', 'template'],
    palette: 'paper',
    prompt:
      'Make a testimonial-style quote card template with a clearly fictional person and company, serif quote, avatar initials and a small "illustrative" label, followed by a short stat. Paper palette, 11 seconds.',
    scenes: [
      X('quote', 6, { lines: ['We plan on Monday', 'and post all week', 'The agent does', 'the timeline'], name: 'Jordan Sample', role: 'Producer, Example Studio', serif: true }),
      X('stat', 5, { value: 20, label: 'reels a week, one producer', note: 'Fictional example' }),
    ],
  },
  {
    slug: 'quote-card-founder',
    title: 'Quote card: founder',
    category: 'Quote card',
    tags: ['quote', 'founder', 'template'],
    palette: 'grape',
    prompt:
      'A bold sans-serif quote card for a fictional founder, followed by an outro with a fictional brand. Grape palette, 10 seconds.',
    scenes: [
      X('quote', 5.5, { lines: ['Ship the small thing', 'Then ship it', 'again tomorrow'], name: 'Riley Demo', role: 'Founder, Placeholder Labs' }),
      X('outro', 4.5, { brand: 'Placeholder Labs', line: 'Small teams, *shipping daily*' }),
    ],
  },
  {
    slug: 'quote-card-coach',
    title: 'Quote card: running coach',
    category: 'Quote card',
    tags: ['quote', 'fitness', 'template'],
    palette: 'volt',
    prompt:
      'Quote card for a fictional running coach, with a stat about weekly kilometres after it. Volt palette, 10 seconds.',
    scenes: [
      X('quote', 5.5, { lines: ['Easy days easy', 'Hard days hard', 'Most people get', 'both wrong'], name: 'Sam Placeholder', role: 'Running coach (fictional)' }),
      XF('stat', 4.5, { value: 80, suffix: '%', label: 'of your runs should feel easy', note: 'Common coaching guideline' }),
    ],
  },
  {
    slug: 'quote-card-teacher',
    title: 'Quote card: teacher',
    category: 'Quote card',
    tags: ['quote', 'education', 'template'],
    palette: 'cream',
    prompt:
      'A warm quote card for a fictional teacher about curiosity, serif type, then a Remotion title with the takeaway. Cream palette, 10 seconds.',
    scenes: [
      X('quote', 6, { lines: ['The best question', 'in my class is', '"what if we', 'tried it?"'], name: 'Morgan Example', role: 'Science teacher (fictional)', serif: true }),
      R(4, 'Stay curious', 'Ask one more question today'),
    ],
  },
];

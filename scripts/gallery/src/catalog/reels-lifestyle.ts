/**
 * Showcase reels, part 3: recipes, fitness, travel, real estate, events,
 * motivation, music, sports, listicles, wellbeing and generative brand art.
 * Every place, team, artist, venue and listing is fictional.
 */
import { CV, HFT, HFTT, HT, HTT, MC, R, X, XF, type ReelSpec } from './build';

export const LIFESTYLE: ReelSpec[] = [
  /* ---------------- recipes ---------------- */
  {
    slug: 'ten-minute-miso-ramen',
    title: 'Ten-minute miso ramen',
    category: 'Recipe',
    tags: ['recipe', 'food', 'quick'],
    palette: 'ember',
    featured: true,
    music: 'lofi',
    prompt:
      'A cosy recipe reel for ten-minute miso ramen: a hook, the bowl with ingredients and a timer, three numbered steps, and a closing title. Warm ember palette, 17 seconds.',
    scenes: [
      R(2.5, 'Ramen in ten minutes', 'Weeknight miso'),
      X('recipe', 5.5, { dish: 'Ten-minute miso ramen', minutes: 10, ingredients: ['Noodles', 'White miso', 'Soft egg', 'Scallion', 'Chilli oil'], food: ['#f4a261', '#e9c46a', '#2a9d8f', '#f1faee', '#e76f51'] }),
      X('checklist', 6, { title: 'Three steps', items: ['Whisk miso into hot stock', 'Cook noodles *3 minutes*', 'Top and slurp'], mark: 'num' }),
      HT(3, 'Save it for Tuesday', undefined, 'Recipe'),
    ],
  },
  {
    slug: 'green-goddess-salad',
    title: 'Green goddess salad',
    category: 'Recipe',
    tags: ['recipe', 'healthy', 'salad'],
    palette: 'forest',
    prompt:
      'A fresh salad recipe reel: the bowl with green ingredients, a dressing step list, and a "15 minutes" stat. Forest palette, 15 seconds.',
    scenes: [
      X('recipe', 5.5, { dish: 'Green goddess salad', minutes: 15, ingredients: ['Cucumber', 'Avocado', 'Herbs', 'Lemon', 'Pistachio'], food: ['#7bd389', '#b5e48c', '#52b788', '#f4d35e', '#2d6a4f'] }),
      MC(6, 'The dressing', ['Blend herbs, yoghurt and lemon', 'Add a splash of water to loosen', 'Season, then toss everything']),
      X('stat', 3.5, { value: 15, suffix: ' min', label: 'start to plate' }),
    ],
  },
  {
    slug: 'sheet-pan-tacos',
    title: 'Sheet-pan tacos',
    category: 'Recipe',
    tags: ['recipe', 'dinner', 'family'],
    palette: 'sunset',
    prompt:
      'Family dinner recipe reel: sheet-pan tacos, ingredients bowl, a timer scene for the oven, and an outro. Sunset palette, 16 seconds.',
    scenes: [
      X('recipe', 5.5, { dish: 'Sheet-pan tacos', minutes: 25, ingredients: ['Black beans', 'Peppers', 'Corn', 'Tortillas', 'Lime'], food: ['#3d2c2e', '#ff7e5f', '#feb47b', '#ffd166', '#06d6a0'] }),
      X('timer', 6, { move: 'Roast', reps: 20, sets: 'Oven 220 °C', cue: 'Flip the pan at *10 minutes*' }),
      R(4.5, 'Taco night, sorted', 'One pan to wash'),
    ],
  },
  {
    slug: 'overnight-oats',
    title: 'Overnight oats, three ways',
    category: 'Recipe',
    tags: ['recipe', 'breakfast', 'meal-prep'],
    palette: 'cream',
    prompt:
      'A meal-prep breakfast reel: overnight oats base recipe, then three flavour ideas as a feature grid. Cream palette, 14 seconds.',
    scenes: [
      X('recipe', 5, { dish: 'Overnight oats', minutes: 5, ingredients: ['Oats', 'Milk', 'Yoghurt', 'Chia', 'Honey'], food: ['#e9d8a6', '#f8f9fa', '#ffffff', '#6c757d', '#ffb703'] }),
      X('featureGrid', 5, { title: 'Three ways', tiles: [{ icon: 'heart', label: 'Berry', text: 'raspberry + vanilla' }, { icon: 'sun', label: 'Tropical', text: 'mango + coconut' }, { icon: 'leaf', label: 'Apple pie', text: 'apple + cinnamon' }, { icon: 'star', label: 'Your own', text: 'go wild' }] }),
      HFT(4, 'Breakfast, done last night', 'Keeps 3 days in the fridge'),
    ],
  },
  {
    slug: 'lemon-pasta-recipe',
    title: 'Lemon butter pasta',
    category: 'Recipe',
    tags: ['recipe', 'pasta', 'quick'],
    palette: 'sand',
    prompt:
      'Quick pasta recipe reel: lemon butter pasta bowl with ingredients, four steps and a tip card. Sand palette, 16 seconds.',
    scenes: [
      X('recipe', 5.5, { dish: 'Lemon butter pasta', minutes: 12, ingredients: ['Spaghetti', 'Butter', 'Lemon', 'Parmesan', 'Pepper'], food: ['#f2cc8f', '#ffe8a3', '#f9c74f', '#fefae0', '#6c584c'] }),
      X('checklist', 6, { title: 'Four steps', items: ['Boil pasta in salty water', 'Melt butter with lemon zest', 'Toss with pasta water', 'Cheese, pepper, *done*'], mark: 'num' }),
      X('tip', 4.5, { n: 1, topic: 'Kitchen', tip: ['Save a cup', 'of pasta water'], detail: 'It makes the sauce *silky*', icon: 'cup' }),
    ],
  },

  /* ---------------- fitness ---------------- */
  {
    slug: 'air-squat-form-tip',
    title: 'Air squat form tip',
    category: 'Fitness',
    tags: ['fitness', 'form', 'workout'],
    palette: 'volt',
    featured: true,
    music: 'stomp',
    prompt:
      'A fitness reel: three cues for better air squats, then a 20-rep interval timer, then a motivational sign-off. Neon volt look, 16 seconds.',
    scenes: [
      HFT(2.5, 'Squat better in 3 cues', 'Form check'),
      X('checklist', 5, { title: 'Three cues', items: ['Feet *shoulder-width*', 'Knees track over toes', 'Chest up, sit back'], mark: 'num' }),
      X('timer', 6, { move: 'Air squats', reps: 20, sets: 'Set 1 of 3', cue: 'Slow down, *3 seconds* each' }),
      X('manifesto', 2.5, { words: ['Again', 'Tomorrow'] }),
    ],
  },
  {
    slug: 'hiit-interval-timer',
    title: '20-minute HIIT plan',
    category: 'Fitness',
    tags: ['fitness', 'hiit', 'plan'],
    palette: 'ember',
    prompt:
      'A HIIT workout plan reel: a timeline of four blocks, an interval timer, and a stat on total time. Ember palette, 16 seconds.',
    scenes: [
      X('timeline', 6, { title: '20-minute|HIIT', steps: [{ when: '0–4 min', what: 'Warm-up jog' }, { when: '4–14 min', what: '40 s on, 20 s off' }, { when: '14–18 min', what: 'Core finisher' }, { when: '18–20 min', what: 'Cool down' }] }),
      X('timer', 6, { move: 'Burpees', reps: 12, sets: 'Round 3 of 10', cue: 'Land *softly*' }),
      X('stat', 4, { value: 20, suffix: ' min', label: 'no equipment needed' }),
    ],
  },
  {
    slug: 'running-zone-two',
    title: 'Zone 2 running, explained',
    category: 'Fitness',
    tags: ['fitness', 'running', 'education'],
    palette: 'ocean',
    prompt:
      'Explain zone 2 running simply: what it is, how it should feel, and a weekly split donut. General fitness education, ocean palette, 16 seconds.',
    scenes: [
      R(2.5, 'Run slower to get faster', 'Zone 2, explained'),
      MC(6, 'Zone 2 means', ['You can talk in full sentences', 'About 60–70% of max heart rate', 'It builds your aerobic base']),
      X('donut', 5, { title: 'A week of running', percent: 80, label: 'easy, zone 2', legend: [{ label: 'Easy' }, { label: 'Hard', color: 'accent2' }] }),
      HT(2.5, 'Easy days, easy', undefined, 'Tip'),
    ],
  },
  {
    slug: 'desk-stretch-break',
    title: 'Two-minute desk stretch',
    category: 'Fitness',
    tags: ['fitness', 'office', 'mobility'],
    palette: 'mint',
    music: 'ambient',
    prompt:
      'A two-minute desk stretch routine as steps with a timer, for office workers. Calm mint palette, 15 seconds.',
    scenes: [
      X('step', 4, { step: 1, of: 3, title: ['Neck rolls'], text: '*5* each way', icon: 'user' }),
      X('step', 4, { step: 2, of: 3, title: ['Shoulder', 'shrugs'], text: 'Up for 3, down for 3', icon: 'up' }),
      X('timer', 7, { move: 'Hip flexor', reps: 30, sets: 'Step 3 of 3', cue: 'Hold each side *30 seconds*' }),
    ],
  },
  {
    slug: 'pushup-progression',
    title: 'Push-up progression',
    category: 'Fitness',
    tags: ['fitness', 'strength', 'beginner'],
    palette: 'mono',
    prompt:
      'A beginner push-up progression as a timeline from wall push-ups to full push-ups, then a rep counter. Mono palette, 14 seconds.',
    scenes: [
      X('timeline', 6.5, { title: 'Your first|push-up', steps: [{ when: 'Week 1', what: 'Wall push-ups' }, { when: 'Week 2', what: 'Table push-ups' }, { when: 'Week 3', what: 'Knee push-ups' }, { when: 'Week 4', what: 'The real thing' }] }),
      X('timer', 7.5, { move: 'Push-ups', reps: 10, sets: 'Week 4', cue: 'Body in *one line*' }),
    ],
  },

  /* ---------------- travel ---------------- */
  {
    slug: 'coastal-road-trip',
    title: 'Five-day coastal road trip',
    category: 'Travel',
    tags: ['travel', 'road-trip', 'map'],
    palette: 'ocean',
    featured: true,
    music: 'drive',
    prompt:
      'A travel reel for a fictional five-day coastal road trip: hook, the route drawing on a stylised map with stops, a day-by-day timeline, and an outro. Ocean palette, 18 seconds.',
    scenes: [
      R(2.5, 'Five days on the coast road', 'A slow road trip'),
      X('route', 6.5, { title: 'Coast road', stops: ['Harbor Bay', 'Old Mill', 'Cliffside', 'Sandpoint'], distance: 412, days: '5 days' }),
      X('timeline', 6, { title: 'The plan', steps: [{ when: 'Day 1–2', what: 'Harbor Bay markets' }, { when: 'Day 3', what: 'Cliffside hike' }, { when: 'Day 4–5', what: 'Sandpoint sunsets' }] }),
      HT(3, 'Fictional route. Real wanderlust', undefined, 'Road trip'),
    ],
  },
  {
    slug: 'city-weekend-guide',
    title: '48 hours in Lindenport',
    category: 'Travel',
    tags: ['travel', 'city', 'guide'],
    palette: 'sunset',
    prompt:
      'A city weekend guide for the fictional city of Lindenport: route between four spots, a feature grid of what to do, and a budget stat. Sunset palette, 17 seconds.',
    scenes: [
      X('route', 6, { title: '48 h in Lindenport', stops: ['Station', 'Canal Market', 'Tower Hill', 'Night Pier'], distance: 9, unit: 'km on foot' }),
      X('featureGrid', 5.5, { title: 'Don\'t miss', tiles: [{ icon: 'cup', label: 'Canal coffee', text: 'by the locks' }, { icon: 'sun', label: 'Tower Hill', text: 'golden hour' }, { icon: 'music', label: 'Night Pier', text: 'live sets' }, { icon: 'book', label: 'Old library', text: 'free entry' }] }),
      X('stat', 5.5, { prefix: '$', value: 180, label: 'for the whole weekend', note: 'Without the hotel, illustrative' }),
    ],
  },
  {
    slug: 'packing-light-checklist',
    title: 'Pack light: carry-on only',
    category: 'Travel',
    tags: ['travel', 'packing', 'checklist'],
    palette: 'cream',
    prompt:
      'A travel tip reel: pack a week in a carry-on, with a checklist, a stat on bag weight and a closing title. Cream palette, 14 seconds.',
    scenes: [
      X('checklist', 6, { title: 'One week, one bag', items: ['3 tops, 2 bottoms', 'Layers, not coats', 'Solid toiletries', 'One pair of *good shoes*'] }),
      X('stat', 4, { value: 7, suffix: ' kg', label: 'the usual carry-on limit', meter: 0.7 }),
      R(4, 'Travel light, travel far'),
    ],
  },
  {
    slug: 'island-hopping-plan',
    title: 'Island hopping plan',
    category: 'Travel',
    tags: ['travel', 'islands', 'map'],
    palette: 'mint',
    prompt:
      'An island-hopping reel through four fictional islands, with a route map, ferry times as a timeline and a globe intro. Mint palette, 18 seconds.',
    scenes: [
      CV('globe', 4, { lines: ['Island', 'season'] }),
      X('route', 6.5, { title: 'Four islands', stops: ['Pell', 'Marrow Key', 'Sola', 'Ithen'], distance: 186, unit: 'km by ferry' }),
      X('timeline', 7.5, { title: 'Ferry days', steps: [{ when: 'Mon', what: 'Pell → Marrow Key, 2 h' }, { when: 'Thu', what: 'Marrow Key → Sola, 1 h' }, { when: 'Sat', what: 'Sola → Ithen, 3 h' }] }),
    ],
  },
  {
    slug: 'mountain-hut-trek',
    title: 'Hut-to-hut trek',
    category: 'Travel',
    tags: ['travel', 'hiking', 'outdoors'],
    palette: 'forest',
    prompt:
      'An outdoor reel for a fictional three-day hut-to-hut trek: route with huts, elevation stat, and a gear checklist. Forest palette, 17 seconds.',
    scenes: [
      X('route', 6.5, { title: 'Three huts', stops: ['Valley Inn', 'Pine Hut', 'Ridge Hut', 'Summit'], distance: 38, days: '3 days' }),
      X('stat', 4.5, { value: 2140, suffix: ' m', label: 'climbed in total', meter: 0.66 }),
      X('checklist', 6, { title: 'Pack these', items: ['Rain shell', 'Head torch', 'Hut sleeping liner', 'Cash for the huts'] }),
    ],
  },

  /* ---------------- real estate ---------------- */
  {
    slug: 'sunny-loft-listing',
    title: 'Sunny loft listing',
    category: 'Real estate',
    tags: ['real-estate', 'listing', 'home'],
    palette: 'sand',
    featured: true,
    prompt:
      'A real estate listing reel for a fictional two-bed loft: hook, floor plan drawing with price and specs, a feature grid, and a viewing CTA. Sand palette, 17 seconds.',
    scenes: [
      HT(2.5, 'Light from three sides', 'A riverside loft', 'Just listed'),
      X('listing', 6.5, { title: 'Sunny riverside loft', price: '$420,000', beds: 2, baths: 1, area: '78 m²', place: 'Riverside (fictional)' }),
      X('featureGrid', 5, { title: 'Why you\'ll|love it', tiles: [{ icon: 'sun', label: 'South-facing', text: 'all-day light' }, { icon: 'home', label: 'Top floor', text: 'no neighbours above' }, { icon: 'leaf', label: 'Balcony', text: '9 m²' }, { icon: 'pin', label: 'Riverside', text: '5 min walk' }] }),
      R(3, 'Book a viewing', 'Open house Saturday'),
    ],
  },
  {
    slug: 'family-home-listing',
    title: 'Family home listing',
    category: 'Real estate',
    tags: ['real-estate', 'family', 'listing'],
    palette: 'cream',
    prompt:
      'Listing reel for a fictional four-bed family home: floor plan, nearby places checklist, and price stat. Cream palette, 16 seconds.',
    scenes: [
      X('listing', 6.5, { title: 'Garden family home', price: '$615,000', beds: 4, baths: 2, area: '142 m²', place: 'Elmwood (fictional)' }),
      X('checklist', 5.5, { title: 'Nearby', items: ['Primary school, 6 min walk', 'Park and playground', 'Train to the centre in *18 min*'] }),
      HFT(4, 'Open house this Sunday', '11am to 1pm'),
    ],
  },
  {
    slug: 'studio-apartment-rent',
    title: 'Studio for rent',
    category: 'Real estate',
    tags: ['real-estate', 'rental', 'city'],
    palette: 'electric',
    prompt:
      'A rental listing reel for a fictional city studio: price card per month, floor plan, and an apply CTA. Electric palette, 14 seconds.',
    scenes: [
      X('pricing', 5, { plan: 'City studio', price: 1350, per: 'month', features: ['Bills included', 'Furnished', 'Gym in the building'], badge: 'Available 1 May' }),
      X('listing', 5.5, { title: 'Compact, clever studio', price: '$1,350/mo', beds: 1, baths: 1, area: '34 m²', place: 'Midtown (fictional)' }),
      R(3.5, 'Apply in two minutes', 'Viewings this week'),
    ],
  },
  {
    slug: 'market-report-housing',
    title: 'Local housing market report',
    category: 'Real estate',
    tags: ['real-estate', 'data', 'market'],
    palette: 'midnight',
    prompt:
      'A monthly market report reel for a fictional town: median price line chart, days-on-market stat and a bar comparison of property types. Sample data, Midnight theme, 16 seconds.',
    scenes: [
      X('line', 6, { title: 'Median price (sample)', points: [380, 384, 390, 388, 396, 402, 405, 412], prefix: '$', value: 412, suffix: 'k', caption: 'up *8%* year on year', labels: ['Jan', 'Apr', 'Aug'] }),
      X('stat', 4, { value: 23, suffix: ' days', label: 'median time on market', note: 'Fictional town, sample data' }),
      X('bars', 6, { title: 'Sales by type', bars: [{ label: 'Flats', value: 48 }, { label: 'Terraced', value: 31 }, { label: 'Detached', value: 12 }], highlight: 0, source: 'Sample data' }),
    ],
  },

  /* ---------------- events ---------------- */
  {
    slug: 'night-market-event',
    title: 'Night market',
    category: 'Event',
    tags: ['event', 'local', 'ticket'],
    palette: 'sunset',
    featured: true,
    music: 'pulse',
    prompt:
      'An event promo for a fictional night market: kinetic lyric-style words, a ticket card, a countdown, and the lineup as a timeline. Sunset palette, 18 seconds.',
    scenes: [
      X('lyric', 3, { words: ['Food', 'Music', 'Lights'] }),
      X('ticket', 5, { event: 'Night|Market', date: 'Fri 9 May · 7pm', place: 'Pier 4, Harbor (fictional)' }),
      X('timeline', 5.5, { title: 'Tonight', steps: [{ when: '7pm', what: 'Stalls open' }, { when: '8:30pm', what: 'Live band' }, { when: '10pm', what: 'Lantern walk' }] }),
      X('countdown', 4.5, { eyebrow: 'Opens in', label: 'See you there', units: [{ value: 6, unit: 'days' }, { value: 14, unit: 'hrs' }, { value: 5, unit: 'min' }] }),
    ],
  },
  {
    slug: 'dev-conference-countdown',
    title: 'Dev conference countdown',
    category: 'Event',
    tags: ['event', 'conference', 'tech'],
    palette: 'electric',
    prompt:
      'A countdown reel for a fictional developer conference, ShipConf: globe intro, ticket, speaker topics as a feature grid, then a 3-2-1 flip. Electric palette, 18 seconds.',
    scenes: [
      CV('globe', 4, { eyebrow: 'ShipConf', lines: ['Two days of', 'shipping'] }),
      X('ticket', 5, { event: 'Ship|Conf', date: '12–13 Jun', place: 'Hall 3, Lindenport', tag: 'Early bird' }),
      X('featureGrid', 5, { title: 'Talks on', tiles: [{ icon: 'code', label: 'Agents', text: 'in production' }, { icon: 'shield', label: 'Security', text: 'for small teams' }, { icon: 'chart', label: 'Data', text: 'without the hype' }, { icon: 'rocket', label: 'Shipping', text: 'every day' }] }),
      X('countdown', 4, { label: 'Early bird ends' }),
    ],
  },
  {
    slug: 'charity-run-event',
    title: 'Charity fun run',
    category: 'Event',
    tags: ['event', 'charity', 'community'],
    palette: 'rose',
    prompt:
      'A community event reel for a fictional 5K charity fun run: hero line, route map, fundraising goal donut, and a sign-up outro. Rose palette, 17 seconds.',
    scenes: [
      X('hero', 4, { eyebrow: 'Sun 18 May', lines: ['5K for', 'the library'], sub: 'Walk, jog or *run*', cta: 'Sign up free' }),
      X('route', 5.5, { title: 'Park loop', stops: ['Start gate', 'Lake path', 'Old oak', 'Finish'], distance: 5, unit: 'km' }),
      X('donut', 4.5, { title: 'Fundraising goal', percent: 72, label: 'of $10,000 raised so far (example)' }),
      HFT(3, 'Every step funds a book', 'Fictional event'),
    ],
  },
  {
    slug: 'album-release-countdown',
    title: 'Album release countdown',
    category: 'Event',
    tags: ['event', 'music', 'release'],
    palette: 'grape',
    music: 'drive',
    prompt:
      'A release countdown for "Afterglow", a fictional album by the fictional band Low Tide: silk-line intro, tracklist timeline, countdown, and outro. Grape palette, 18 seconds.',
    scenes: [
      CV('flow', 4, { eyebrow: 'Low Tide', lines: ['Afterglow'], sub: 'The new album' }),
      X('timeline', 6, { title: 'Side A', steps: [{ when: '01', what: 'Northern Lights' }, { when: '02', what: 'Slow Burn' }, { when: '03', what: 'Afterglow' }, { when: '04', what: 'Harbor Song' }] }),
      X('countdown', 4.5, { eyebrow: 'Out in', label: 'Pre-save now', units: [{ value: 3, unit: 'days' }, { value: 0, unit: 'hrs' }, { value: 0, unit: 'min' }] }),
      R(3.5, 'Afterglow · Friday', 'Fictional band, original demo'),
    ],
  },
  {
    slug: 'workshop-webinar-promo',
    title: 'Free workshop promo',
    category: 'Event',
    tags: ['event', 'webinar', 'education'],
    palette: 'paper',
    prompt:
      'Promote a free online workshop, "Write better product docs", by a fictional company: ticket, agenda checklist and countdown. Paper palette, 16 seconds.',
    scenes: [
      X('ticket', 5, { event: 'Better|Docs', date: 'Wed 21 May · 5pm', place: 'Online', tag: 'Free workshop' }),
      X('checklist', 6, { title: 'You will learn', items: ['Structure that scales', 'Write for scanning', 'Examples first', 'Keep docs *tested*'], mark: 'num' }),
      MC(5, 'Who it is for', ['Engineers who write docs', 'PMs, founders and support teams']),
    ],
  },

  /* ---------------- motivational ---------------- */
  {
    slug: 'start-before-ready',
    title: 'Start before you\'re ready',
    category: 'Motivation',
    tags: ['motivation', 'kinetic-type', 'quote'],
    palette: 'mono',
    featured: true,
    music: 'ambient',
    prompt:
      'A motivational kinetic-typography reel: "Start before you\'re ready". Full-screen manifesto blocks, a silk ribbon background line, and a final title. Monochrome, 13 seconds.',
    scenes: [
      X('manifesto', 4.5, { words: ['Start', 'before', 'you\'re', 'ready'] }),
      CV('flow', 4.5, { lines: ['Momentum', 'beats', 'motivation'] }),
      R(4, 'Do the first five minutes'),
    ],
  },
  {
    slug: 'small-steps-daily',
    title: 'One percent a day',
    category: 'Motivation',
    tags: ['motivation', 'habits', 'math'],
    palette: 'cobalt',
    prompt:
      'A motivational reel about 1% daily improvement: kinetic words, a stat (1.01^365 ≈ 37.8), and a closing line. Cobalt palette, 13 seconds.',
    scenes: [
      X('lyric', 3.5, { words: ['One', 'percent', 'a', 'day'] }),
      X('stat', 5, { value: 37, suffix: '×', label: 'better in a year (1.01³⁶⁵)', note: 'The maths of *tiny gains*' }),
      HFT(4.5, 'Small steps. Every day', 'Start today'),
    ],
  },
  {
    slug: 'rest-is-productive',
    title: 'Rest is productive',
    category: 'Motivation',
    tags: ['motivation', 'wellbeing'],
    palette: 'midnight',
    music: 'ambient',
    prompt:
      'A calm motivational reel: "Rest is productive". Aurora background with the message, then three reminders and a quiet outro. Midnight theme, 15 seconds.',
    scenes: [
      CV('flow', 5, { lines: ['Rest is', 'productive'] }),
      MC(6, 'Today, try', ['A walk without your phone', 'Lunch away from the desk', 'Stopping on time']),
      HT(4, 'Recharge counts', undefined, 'Reminder'),
    ],
  },
  {
    slug: 'done-beats-perfect',
    title: 'Done beats perfect',
    category: 'Motivation',
    tags: ['motivation', 'kinetic-type'],
    palette: 'volt',
    prompt:
      'A punchy kinetic-type reel: "Done beats perfect". Lyric-style word cuts on a beat, then a quote card with a fictional maker. Volt palette, 12 seconds.',
    scenes: [
      X('lyric', 4, { words: ['Done', 'beats', 'perfect'] }),
      X('quote', 5, { lines: ['Version one is', 'a conversation,', 'not a verdict'], name: 'Avery Example', role: 'Maker (fictional)' }),
      R(3, 'Ship it today'),
    ],
  },
  {
    slug: 'monday-reset',
    title: 'Monday reset',
    category: 'Motivation',
    tags: ['motivation', 'planning', 'routine'],
    palette: 'rose',
    prompt:
      'A Monday reset routine reel: hero line, a numbered checklist, and manifesto words to finish. Rose palette, 15 seconds.',
    scenes: [
      X('hero', 4, { eyebrow: 'Monday', lines: ['Reset', 'your week'], sub: 'Fifteen minutes, *before* email' }),
      X('checklist', 6, { title: 'The reset', items: ['Clear the desk', 'Pick three priorities', 'Block focus time', 'Plan one fun thing'], mark: 'num' }),
      X('manifesto', 5, { words: ['Plan', 'it.', 'Then', 'go.'] }),
    ],
  },

  /* ---------------- music / lyric kinetic type ---------------- */
  {
    slug: 'kinetic-lyric-run-all-night',
    title: 'Kinetic lyrics: Run all night',
    category: 'Music',
    tags: ['music', 'lyrics', 'kinetic-type'],
    palette: 'sunset',
    featured: true,
    music: 'drive',
    prompt:
      'A lyric video for an original demo hook, "we run all night, we run till the light": one word per beat with colour changes and an equalizer, then a radial visualiser. Sunset palette, 14 seconds.',
    scenes: [
      X('lyric', 7, { words: ['We', 'run', 'all', 'night', 'till', 'the', 'light'], footer: 'Original demo' }),
      CV('equalizer', 7, { lines: ['Run All Night'], sub: 'Original demo · fictional artist', bpm: 120 }),
    ],
  },
  {
    slug: 'kinetic-lyric-slow-burn',
    title: 'Kinetic lyrics: Slow burn',
    category: 'Music',
    tags: ['music', 'lyrics', 'ambient'],
    palette: 'grape',
    music: 'ambient',
    prompt:
      'A slow lyric video for an original line, "slow burn, golden hour, stay": words on a slow beat over slow silk lines. Grape palette, 13 seconds.',
    scenes: [
      CV('flow', 5, { eyebrow: 'Low Tide (fictional)', lines: ['Slow Burn'] }),
      X('lyric', 8, { words: ['Slow', 'burn,', 'golden', 'hour,', 'stay'], beat: 1.4, footer: 'Original lyric' }),
    ],
  },
  {
    slug: 'beat-drop-visualizer',
    title: 'Beat drop visualiser',
    category: 'Music',
    tags: ['music', 'visualizer', 'generative'],
    palette: 'electric',
    music: 'stomp',
    prompt:
      'A generative music visualiser reel: radial equalizer on the beat, then kinetic words on the beat, then a title. Electric palette, 13 seconds.',
    scenes: [
      CV('equalizer', 5, { lines: ['Drop'], bpm: 128 }),
      X('lyric', 5, { words: ['Hands', 'up', 'for', 'the', 'drop'], footer: 'Original beat' }),
      HFT(3, 'Original beat', 'Procedural visuals'),
    ],
  },
  {
    slug: 'playlist-of-the-week',
    title: 'Playlist of the week',
    category: 'Music',
    tags: ['music', 'playlist', 'list'],
    palette: 'mint',
    music: 'lofi',
    prompt:
      'A "playlist of the week" reel for a fictional radio show: phone with now-playing, a tracklist timeline of fictional songs, and an outro. Mint palette, 16 seconds.',
    scenes: [
      X('phone', 5.5, { app: 'Radio Lo', headline: 'Five for Friday', chips: ['Lo-fi', 'Focus', '45 min'], screen: 'music' }),
      X('timeline', 6, { title: 'This week', steps: [{ when: '01', what: 'Paper Planes — Mira K' }, { when: '02', what: 'Rain Room — Oslo Kids' }, { when: '03', what: 'Tape Hiss — Juno' }] }),
      R(4.5, 'Press play', 'All artists fictional'),
    ],
  },
  {
    slug: 'concert-setlist',
    title: 'Tonight\'s setlist',
    category: 'Music',
    tags: ['music', 'live', 'event'],
    palette: 'ember',
    music: 'pulse',
    prompt:
      'A concert setlist reel for a fictional band: lyric-style band name, setlist timeline, and a burst finale. Ember palette, 15 seconds.',
    scenes: [
      X('lyric', 3, { words: ['Low', 'Tide', 'live'] }),
      X('timeline', 6.5, { title: 'Setlist', steps: [{ when: '9:00', what: 'Northern Lights' }, { when: '9:20', what: 'Slow Burn' }, { when: '9:45', what: 'Afterglow' }, { when: 'Encore', what: 'Harbor Song' }] }),
      CV('burst', 5.5, { lines: ['Thank you,', 'Harbor'] }),
    ],
  },

  /* ---------------- sports stats ---------------- */
  {
    slug: 'harbor-fc-match-recap',
    title: 'Harbor FC match recap',
    category: 'Sports',
    tags: ['sports', 'football', 'stats'],
    palette: 'cobalt',
    featured: true,
    music: 'stomp',
    prompt:
      'A match recap for fictional teams Harbor FC vs Ridge United: final scoreboard with stat bars, a goals timeline, and a player-of-the-match stat. Cobalt palette, 17 seconds.',
    scenes: [
      X('scoreboard', 6.5, { league: 'City League', home: 'Harbor FC', away: 'Ridge United', score: [3, 1], stats: [{ label: 'Possession', home: 58, away: 42 }, { label: 'Shots', home: 14, away: 6 }, { label: 'Corners', home: 7, away: 3 }] }),
      X('timeline', 5.5, { title: 'Goals', steps: [{ when: '12\'', what: 'Harbor · header from a corner' }, { when: '38\'', what: 'Ridge · penalty' }, { when: '61\'', what: 'Harbor · long-range shot' }, { when: '88\'', what: 'Harbor · counter-attack' }] }),
      X('stat', 5, { eyebrow: 'Player of the match', value: 2, suffix: ' goals', label: 'No. 9, fictional player' }),
    ],
  },
  {
    slug: 'basketball-season-stats',
    title: 'Season stats leader',
    category: 'Sports',
    tags: ['sports', 'basketball', 'stats'],
    palette: 'ember',
    prompt:
      'A season stats reel for a fictional basketball player: points-per-game line chart, bar comparison with league average, and a title. Ember palette, 15 seconds.',
    scenes: [
      X('line', 6, { title: 'Points per game', points: [14, 17, 16, 19, 22, 21, 25, 27], value: 27, suffix: ' ppg', caption: 'career high this season', labels: ['Y1', 'Y4', 'Y8'] }),
      X('bars', 5, { title: 'vs league average', bars: [{ label: 'Points', value: 27 }, { label: 'League avg', value: 11 }], highlight: 0, source: 'Fictional player, sample data' }),
      R(4, 'MVP season?', 'All stats fictional'),
    ],
  },
  {
    slug: 'marathon-splits',
    title: 'Marathon splits',
    category: 'Sports',
    tags: ['sports', 'running', 'data'],
    palette: 'volt',
    prompt:
      'A running data reel: marathon 5K splits as bars, finish time stat and a negative-split tip. Volt palette, 15 seconds, sample data.',
    scenes: [
      X('bars', 6, { title: '5K splits (min)', bars: [{ label: '0–5K', value: 26 }, { label: '15–20K', value: 25 }, { label: '30–35K', value: 25 }, { label: '40K+', value: 24 }], highlight: 3, source: 'Sample race' }),
      X('stat', 4, { value: 3, suffix: ':38', label: 'finish time, sample runner' }),
      X('tip', 5, { n: 1, topic: 'Racing', tip: ['Run the second', 'half faster'], detail: 'A *negative split*', icon: 'trophy' }),
    ],
  },
  {
    slug: 'cycling-tour-stage',
    title: 'Stage 7 preview',
    category: 'Sports',
    tags: ['sports', 'cycling', 'map'],
    palette: 'forest',
    prompt:
      'A cycling race stage preview for a fictional tour: route with climbs, elevation stat and three things to watch. Forest palette, 16 seconds.',
    scenes: [
      X('route', 6, { title: 'Stage 7', stops: ['Valmont', 'Col du Pin', 'Lac Vert', 'Sommet'], distance: 168, unit: 'km' }),
      X('stat', 4, { value: 3900, suffix: ' m', label: 'of climbing', meter: 0.9 }),
      MC(6, 'Watch for', ['Attacks on the final climb', 'Crosswinds by the lake', 'A sprint for the bonus seconds']),
    ],
  },

  /* ---------------- listicle / countdown ---------------- */
  {
    slug: 'top-five-focus-tips',
    title: 'Top 5 focus tips',
    category: 'Listicle',
    tags: ['listicle', 'productivity', 'countdown'],
    palette: 'default',
    music: 'bright',
    prompt:
      'A countdown listicle: five focus tips from 5 to 1, as tip cards, with a 3-2-1 flip intro. Default theme, 19 seconds.',
    scenes: [
      X('countdown', 3, { label: 'Top 5 focus tips' }),
      X('tip', 3.5, { n: 5, topic: 'Focus', tip: ['Phone in', 'another room'], icon: 'lock' }),
      X('tip', 3, { n: 4, topic: 'Focus', tip: ['One tab', 'at a time'], icon: 'layers' }),
      X('tip', 3, { n: 3, topic: 'Focus', tip: ['25 minutes,', 'then a break'], icon: 'clock' }),
      X('tip', 3.5, { n: 2, topic: 'Focus', tip: ['Write the next', 'step down'], icon: 'book' }),
      X('tip', 3, { n: 1, topic: 'Focus', tip: ['Start with', 'the hard part'], icon: 'flame' }),
    ],
  },
  {
    slug: 'three-books-to-read',
    title: '3 kinds of books to read this year',
    category: 'Listicle',
    tags: ['listicle', 'books', 'reading'],
    palette: 'paper',
    prompt:
      'A reading listicle: three kinds of books to read this year (a classic, a field outside yours, a biography), as steps, plus a reading-goal stat. Paper palette, 16 seconds.',
    scenes: [
      X('step', 4, { step: 1, of: 3, title: ['One old', 'classic'], text: 'It lasted for a *reason*', icon: 'book' }),
      X('step', 4, { step: 2, of: 3, title: ['One far from', 'your field'], text: 'Steal ideas from *elsewhere*', icon: 'globe' }),
      X('step', 4, { step: 3, of: 3, title: ['One life', 'story'], text: 'Biographies are *case studies*', icon: 'user' }),
      X('stat', 4, { value: 12, label: 'books a year = one a month', meter: 0.33 }),
    ],
  },
  {
    slug: 'five-free-dev-tools',
    title: '5 habits of calm developers',
    category: 'Listicle',
    tags: ['listicle', 'coding', 'habits'],
    palette: 'electric',
    prompt:
      'A developer listicle: five habits of calm developers as a feature grid and a checklist, with a hook. Electric palette, 15 seconds.',
    scenes: [
      HFT(2.5, '5 habits of calm developers'),
      X('featureGrid', 5.5, { title: 'Habits', tiles: [{ icon: 'book', label: 'Read the error', text: 'all of it' }, { icon: 'target', label: 'Small PRs', text: 'one purpose' }, { icon: 'shield', label: 'Tests first', text: 'for bugs' }, { icon: 'clock', label: 'Stop on time', text: 'fresh tomorrow' }] }),
      X('checklist', 7, { title: 'And number five', items: ['Write down *why*, not just what', 'In the commit message', 'Future you says thanks'] }),
    ],
  },
  {
    slug: 'weekend-ideas-countdown',
    title: '4 cheap weekend ideas',
    category: 'Listicle',
    tags: ['listicle', 'lifestyle', 'weekend'],
    palette: 'sunset',
    prompt:
      'A fun listicle: four cheap weekend ideas, as a notification-style stack and a feature grid, then a manifesto sign-off. Sunset palette, 14 seconds.',
    scenes: [
      X('featureGrid', 5.5, { title: 'Cheap|weekend ideas', tiles: [{ icon: 'sun', label: 'Sunrise hike', text: 'free' }, { icon: 'book', label: 'Library day', text: 'free' }, { icon: 'cup', label: 'Picnic', text: 'about $15' }, { icon: 'music', label: 'Open mic', text: 'about $5' }] }),
      X('notifications', 5, { title: 'Group chat|says yes', items: [{ app: 'Friends', text: 'Picnic Saturday?' }, { app: 'Friends', text: 'I will bring lemonade' }, { app: 'Friends', text: 'Count me in' }] }),
      X('manifesto', 3.5, { words: ['Go', 'outside'] }),
    ],
  },

  /* ---------------- wellbeing / community ---------------- */
  {
    slug: 'box-breathing-guide',
    title: 'Box breathing, guided',
    category: 'Wellbeing',
    tags: ['wellbeing', 'breathing', 'calm'],
    palette: 'ocean',
    music: 'ambient',
    prompt:
      'A guided box-breathing reel: a calm silk-line intro, a four-count timer, and steps. General wellbeing, not medical advice. Ocean palette, 17 seconds.',
    scenes: [
      CV('flow', 4.5, { lines: ['Breathe', 'with me'] }),
      MC(6, 'Box breathing', ['Breathe in for four', 'Hold for four', 'Out for four, hold for four']),
      X('timer', 6.5, { move: 'Breathe', reps: 4, sets: 'Round 1 of 4', cue: 'Shoulders *down*' }),
    ],
  },
  {
    slug: 'community-garden-signup',
    title: 'Community garden sign-up',
    category: 'Wellbeing',
    tags: ['community', 'garden', 'local'],
    palette: 'forest',
    prompt:
      'A community reel for a fictional neighbourhood garden: hero line, plots-left stat, what you get checklist, and outro. Forest palette, 16 seconds.',
    scenes: [
      X('hero', 4, { eyebrow: 'Elm Street Garden', lines: ['Grow food', 'with', 'neighbours'], sub: 'Plots open for *spring*', backdrop: 'split' }),
      X('stat', 4, { value: 12, label: 'plots left this season', meter: 0.3 }),
      X('checklist', 5, { title: 'You get', items: ['A 2 × 3 m plot', 'Shared tools and water', 'Saturday workshops'] }),
      R(3, 'Sign up at the library', 'Fictional garden'),
    ],
  },
  {
    slug: 'digital-detox-weekend',
    title: 'Digital detox weekend',
    category: 'Wellbeing',
    tags: ['wellbeing', 'phones', 'habits'],
    palette: 'sand',
    prompt:
      'A digital detox reel: before/after of a cluttered vs calm phone screen, a three-step plan, and a calm closing title. Sand palette, 15 seconds.',
    scenes: [
      X('beforeAfter', 6, { title: 'Your phone, calmer', before: { label: 'BEFORE', lines: ['42 notifications', 'Red badges everywhere'] }, after: { label: 'AFTER', lines: ['Only people', 'Badges off'] }, visual: 'ui' }),
      MC(5.5, 'The weekend plan', ['Notifications off, except calls', 'Apps off the home screen', 'Paper book on the nightstand']),
      HT(3.5, 'Bored is good', undefined, 'Detox'),
    ],
  },
  {
    slug: 'volunteer-drive',
    title: 'Volunteer drive',
    category: 'Wellbeing',
    tags: ['community', 'volunteering', 'nonprofit'],
    palette: 'rose',
    prompt:
      'A volunteer recruitment reel for a fictional food bank: hours stat, roles as feature grid, and a sign-up outro. Rose palette, 15 seconds.',
    scenes: [
      X('stat', 4, { eyebrow: 'Last year', value: 3200, label: 'volunteer hours (example)', note: 'Thank you, *Harbor*' }),
      X('featureGrid', 5.5, { title: 'Pick a|role', tiles: [{ icon: 'cart', label: 'Sorting', text: 'Sat mornings' }, { icon: 'home', label: 'Delivery', text: 'with a car' }, { icon: 'user', label: 'Welcome desk', text: 'weekday evenings' }, { icon: 'heart', label: 'Kitchen', text: 'Sundays' }] }),
      X('outro', 5.5, { brand: 'Harbor Food Bank', line: 'Two hours *changes a week*', button: 'Volunteer', backdrop: 'split' }),
    ],
  },

  /* ---------------- generative / brand art ---------------- */
  {
    slug: 'generative-brand-loop',
    title: 'Generative brand loop',
    category: 'Generative',
    tags: ['generative', 'hyperframes', 'brand'],
    palette: 'grape',
    featured: true,
    music: 'ambient',
    prompt:
      'Make a generative brand loop entirely in HyperFrames: an orbit diagram, silk lines, and a confetti burst finale, all procedural canvas animation. Grape palette, 14 seconds.',
    scenes: [
      CV('orbit', 5, { lines: ['Every frame', 'is code'], nodes: ['Canvas', 'CSS', 'SVG', 'Seek', 'Theme'], core: 'HF' }),
      CV('flow', 4.5, { lines: ['Seeked frame', 'by frame'] }),
      CV('burst', 4.5, { lines: ['Rendered', 'locally'] }),
    ],
  },
  {
    slug: 'four-engines-one-timeline',
    title: 'Four engines, one timeline',
    category: 'Generative',
    tags: ['reelforge', 'engines', 'showcase'],
    palette: 'default',
    featured: true,
    music: 'pulse',
    prompt:
      'A showcase reel that uses all four ReelForge engines in one timeline: a Remotion title, a Motion Canvas list, an agent-written HTML scene and a HyperFrames generative globe, cut back to back. Default theme, 18 seconds.',
    scenes: [
      R(3, 'Four engines. One timeline', 'Remotion · Motion Canvas · HTML · HyperFrames'),
      MC(5, 'In this reel', ['This title: Remotion', 'This list: Motion Canvas', 'Next: HTML, then HyperFrames']),
      X('stat', 4, { eyebrow: 'HTML engine', value: 4, label: 'engines rendered this reel', note: 'Checked with *ffprobe*' }),
      CV('globe', 6, { eyebrow: 'HyperFrames', lines: ['Rendered on', 'your machine'] }),
    ],
  },
  {
    slug: 'midnight-theme-showcase',
    title: 'Midnight theme showcase',
    category: 'Generative',
    tags: ['themes', 'midnight', 'showcase'],
    palette: 'midnight',
    prompt:
      'Showcase the built-in Midnight theme across engines: a Remotion title, a built-in HTML title, a HyperFrames title, and a silk-line scene. 14 seconds.',
    scenes: [
      R(3, 'The Midnight theme', 'Built in'),
      HTT(3, 'Same tokens in HTML', 'Background, accent and font from the theme', 'HTML'),
      HFTT(3, 'And in HyperFrames', 'One theme, every engine'),
      CV('flow', 5, { lines: ['Midnight'] }),
    ],
  },
  {
    slug: 'default-theme-showcase',
    title: 'Default theme showcase',
    category: 'Generative',
    tags: ['themes', 'default', 'showcase'],
    palette: 'default',
    prompt:
      'Showcase the built-in Default theme with each engine\'s built-in template: Remotion kinetic title, Motion Canvas explainer, HTML title and HyperFrames title, then a silk outro. 16 seconds.',
    scenes: [
      R(3, 'The Default theme', 'Every built-in template'),
      MC(4.5, 'Built-in templates', ['kinetic-title (Remotion)', 'animated-explainer (Motion Canvas)', 'html-title and hyperframes-title']),
      HTT(3, 'html-title', 'CSS keyframes, seeked frame by frame', 'HTML'),
      HFTT(2.5, 'hyperframes-title', 'Local HyperFrames renderer'),
      CV('flow', 3, { lines: ['Your turn'] }),
    ],
  },
  {
    slug: 'colour-palette-tour',
    title: 'Inline theme tokens tour',
    category: 'Generative',
    tags: ['themes', 'brand', 'tokens'],
    palette: 'cobalt',
    prompt:
      'Show how inline theme tokens give a reel a brand look without creating a theme: a code card with the tokens, a feature grid in those colours, and an outro. Cobalt palette, 15 seconds.',
    scenes: [
      X('code', 6, { title: 'Brand in 4 lines', file: 'manifest.json', code: ['"theme": {', '  "base": "midnight",', '  "tokens": { "colors": {', '    "accent": "#ffcc00" } }', '}'], result: 'validate_project → ok' }),
      XF('featureGrid', 5, { title: 'Tokens|everywhere', tiles: [{ icon: 'layers', label: 'Colours', text: '6 tokens' }, { icon: 'book', label: 'Font', text: 'family + weight' }, { icon: 'clock', label: 'Motion', text: 'speed' }, { icon: 'target', label: 'Radius', text: 'and spacing' }] }),
      X('outro', 4, { brand: 'Your brand', line: 'Inline tokens, *no theme to create*' }),
    ],
  },
];

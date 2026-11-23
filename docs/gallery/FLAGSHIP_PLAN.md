# Flagship gallery: research and the plan for 100 reels

The gallery has to show what people actually share, not developer tooling: story-led explainers that hold attention and prove the studio handles complex scenes. Each reel has 1,000+ animated elements per frame, one pure `draw(t)` per reel, and is rendered by the studio over MCP. Founder brief, 2026-11-23.

## What goes viral (research, 2026-11-23)

| Signal | Source |
| --- | --- |
| Zack D. Films' most-viewed short, "How Stitches Work", has about 253M views. The channel has about 79–84B views in total, and 23 of its shorts are over 100M. Its biggest topics are the human body and "how it works". | [Zack D. Films wiki](https://zackdfilms.fandom.com/wiki/Zack_D._Films), [Viewstats](https://www.viewstats.com/@zackdfilms/channelytics), [ivideonow analysis](https://ivideonow.com/blog/why-zack-d-films-dominates-youtube-shorts-with-unsettling-3d-animation-content-en) |
| Two "how it works" shorts have 112.6M and 105.2M views (secondary source). | [MakeViral](https://www.makeviral.ai/tools/3d-explainer-video-generator) |
| Kurzgesagt: flat vector art with "clever animation" on complex science, with tens of millions of views per film. | [Wikipedia](https://www.Wikipedia.org/wiki/Kurzgesagt) |
| The Infographics Show reports 4.5B+ views; its top video is a 90M-view explainer. | [Wyzowl roundup](https://wyzowl.com/explainer-video-examples/) |
| Real Engineering broke through with "Why are plane windows round?" | [Wikipedia](https://en.wikipedia.org/wiki/Brian_McManus_(YouTuber)) |
| "How a Jet Airliner Works" (Jacob O'Neal) has about 14M views. | search result, 2026-11-23 |
| Craft note: explainers fail when they explain *how* before the viewer cares *why*. Hook first. | [Lunabloom](https://blog.lunabloomai.com/best-animated-explainer-videos/) |

We found no verified 2025 TikTok, Instagram or X view rankings; the platforms don't publish them. The figures above are YouTube Shorts and long-form, where the same creators cross-post. Re-check the numbers before quoting them publicly.

**Formats that work, and what each reel takes from them:**

1. **Question hook in the first 2 s**, with a number: "400 tonnes. How does it fly?"
2. **Reveal the inside:** a cutaway, cross-section or zoom. That's where the 1,000+ elements live: particles, teeth, cells, stars.
3. **One idea per beat**, with captions of 4–8 words.
4. **A payoff fact** that people repeat, and a calm end card.
5. **Honest scale:** "about" for figures, and an on-screen speed chip when time is sped up or slowed down.

## The first five (done, waiting for founder review)

| Reel | Format | Elements per frame |
| --- | --- | --- |
| How does a 400-tonne plane fly? | Cutaway, engineering | 1,400–3,800 |
| How a rocket gets to orbit (and lands back) | Space, engineering | 1,000–3,300 |
| Your heart never takes a day off | Body story | 1,200–5,300 |
| How small is Earth, really? | Scale zoom | 1,100–18,500 |
| How a watch keeps time with no battery | Satisfying mechanism | 1,500–4,700 |

## The next 95 (after the founder approves the style)

Grouped by format, so each batch can reuse techniques. Every topic is general knowledge, stated with "about" and without medical, legal or financial advice.

**Body (20).**
How stitches heal a cut; what happens when you crack your knuckles; how a vaccine trains your body; how your eyes focus; how hearing works (cochlea); what happens when you hold your breath; how a broken bone heals; how your brain makes a memory; why you get goosebumps; how your kidneys filter blood; how lungs swap oxygen; what caffeine does to your brain; how a sneeze travels; how nerves send a signal; how your stomach digests a meal; how muscles contract; how teeth decay; why we yawn; how blood clots; how your body fights a fever.

**Machines and engineering (20).**
How a car engine works (four strokes); how an elevator never falls; how a bullet train stays on the track; how a jet carrier launches a plane; how a submarine dives; how a helicopter flies; how a lock and key work; how a nuclear reactor makes power; how a wind turbine works; how a bridge holds a truck; how a camera shutter works; how an escalator loops; how a zipper works; how a hydraulic press works; how a tunnel boring machine digs; how a 3D printer builds; how a jet ski propels; how ABS brakes stop a skid; how a dam makes power; how a crane lifts 1,000 tonnes.

**Space (12).**
What happens inside a black hole; how the Moon makes tides; how a solar eclipse lines up; how the James Webb telescope unfolds; how a Mars rover lands; how the ISS stays up; how stars are born; why Saturn has rings; how GPS finds you; how a comet's tail forms; how the northern lights glow; what if Earth stopped spinning.

**Nature and Earth (15).**
How lightning forms; how a hurricane spins; how bees build honeycomb; how ants farm fungus; how a volcano erupts; how a tsunami crosses an ocean; how a tree drinks water; how a caterpillar becomes a butterfly; how birds migrate; how coral reefs grow; how a snowflake forms; how rain forms; how earthquakes start; how photosynthesis works; how the deep ocean is mapped.

**Scale and numbers (10).**
How deep the ocean really is; how tall Everest is next to the sky; how fast light really is; how big a blue whale is; how many ants are on Earth; how old the universe is on a 1-year calendar; how small an atom is; how long a billion seconds is; how much water is on Earth; how far Voyager has travelled.

**Everyday tech (12).**
How Wi-Fi sends a photo; how a microwave heats food; how a touchscreen feels your finger; how undersea cables carry the internet; how a QR code stores data; how noise-cancelling headphones work; how a fridge makes cold; how a battery stores energy; how solar panels make power; how an induction hob heats; how a smoke detector works; how a barcode is read.

**History and stories (6).**
How the pyramids were built (current theories); how the Titanic sank, minute by minute; how Apollo 11 landed; how the Panama Canal lifts ships; how a Roman aqueduct carried water; how the first flight stayed up.

## How we build and check each reel

- **One file per reel** in `scripts/gallery/src/flagship/`, following `plane.ts`. It is checked with `preview.ts` (contact sheet plus element count per frame), then rendered with `pnpm gallery render <slug>` through the studio over MCP.
- **Gate:**
  - every sampled frame has at least 1,000 elements;
  - no page errors;
  - `draw(t)` is pure;
  - text stays inside x 84–996 and y 240–1600, at 34 px or more, in sentence case;
  - captions over busy art have a backing;
  - the composition is under 200 KB;
  - the founder reviews the first frame of every batch.
- **Publishing:** reels go to R2 and the gallery Collection (`docs/GALLERY.md`). That waits on R2 being enabled (#89).

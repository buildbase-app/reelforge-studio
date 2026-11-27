# Waitlist email 1: Tue Dec 1, 2026

BuildBase email campaign to the waitlist audience (#51, #249 §3). Send only
after the go-live gate on Nov 30 passed (live checkout, published prices,
production sender #92). If it did not, do not send this; see the note at the
end.

## Before pasting

- Replace `{{price}}` (e.g. "from $X") and, only if a launch price exists,
  `{{launch_price_end}}` **by hand**. They are not BuildBase merge tags; left in,
  BuildBase would treat them as unknown tags.
- `{{unsubscribe}}` and `{{companyAddress}}` **are** BuildBase merge tags. Keep
  them: the pre-send check refuses a campaign without an unsubscribe link and
  a postal address.
- The block marked `[LAUNCH PRICE ONLY]` goes in only if #91 decides a launch
  price. Its end date is 16 December 2026, 13:00 UTC, and nothing else.
- Plain text first. If you use the HTML editor, keep one column, no images
  required to understand the message, and the same words.

## Subject options

1. RenderWeld is on sale: a video studio your AI agent drives
2. You asked to hear first: RenderWeld is ready to install
3. Your agent writes the scenes, your server renders the reel

Preview text: "Free for personal use. One-time Commercial licence. Here is what
it does and what it does not do yet."

## Body

```text
Hi,

You joined the RenderWeld waitlist. It is ready to install today.

What it is
RenderWeld is a short-form video studio you run on your own computer
or server, in Docker. Your AI agent connects to it over MCP (or a script over
REST), writes the scenes and their timing, and the studio renders them with
four engines (Remotion, Motion Canvas, HTML/CSS and HyperFrames) into one
vertical MP4, checked with ffprobe.

What it costs
- Personal use: free. Claim a Personal licence key, no payment page.
- Anything that earns money: a one-time Commercial licence, {{price}}.
- No per-video fees to RenderWeld. (Remotion needs its own licence for
  companies of more than 3 people; a voice provider bills you directly.)

[LAUNCH PRICE ONLY]
The launch price ends on {{launch_price_end}}. After that the regular
price applies.
[/LAUNCH PRICE ONLY]

What works, with proof
- Claude Code, an MCP SDK script, REST and a local model each made a reel
  on every engine; every run is recorded in the tutorials.
- 119 showcase reels rendered by the studio and checked one by one.
- API keys with scopes, an audit log, signed webhooks, and a job queue that
  spreads renders over several workers.

What it does not do yet
- Captions are stored but not rendered.
- Tested on Linux only (x64 and arm64). macOS and Windows are untested.
- Codex is documented but not proven; other MCP clients are untested.
- Voiceover (ElevenLabs) is tested against a mock only.

Get started
Pricing and the free Personal key:
https://renderweld.com/pricing?utm_source=buildbase-email&utm_medium=email&utm_campaign=launch-2026-12&utm_content=1201-wl1-pricing

Connect your agent (Claude Code, Codex, any MCP client, REST):
https://renderweld.com/agents?utm_source=buildbase-email&utm_medium=email&utm_campaign=launch-2026-12&utm_content=1201-wl1-agents

If something does not work on your machine, reply to this email. I read
every reply.

{{founder_name}}
RenderWeld

--
You get this because you joined the RenderWeld waitlist.
Unsubscribe: {{unsubscribe}}
{{companyAddress}}
```

## If the go-live gate did not pass

Do not announce a sale. Either skip Dec 1, or send a short "still in early
access" note that links `/agents` only, with no price and no date. Never
promise a date the founder has not confirmed.

## Facts checked

- Four engines, MCP and REST, ffprobe checks: [`README.md`](../../README.md) "What works today".
- Free Personal key with no payment page; one-time Commercial licence:
  [`LICENSING.md`](../../LICENSING.md); [walkthroughs](../public/walkthroughs.md)
  "Claim a free Personal licence".
- "No per-video fees to RenderWeld" with the Remotion and voice-provider
  qualifier: [`DESIGN_BRIEF.md` §7](../research/DESIGN_BRIEF.md) item 1,
  [`README.md`](../../README.md) "Licensing".
- Tutorial proofs: [`docs/tutorials/README.md`](../tutorials/README.md).
- 119 reels: [`examples/gallery/QUALITY.md`](../../examples/gallery/QUALITY.md).
- Keys, audit log, webhooks, queue: [`STATUS.md` §3](../STATUS.md).
- Limitations: [`README.md`](../../README.md); [`STATUS.md` §6](../STATUS.md) A2.
- Unsubscribe and postal address required: BuildBase docs, Email campaigns
  overview, "Unsubscribes" (https://docs.buildbase.app/email/overview, read
  2026-11-23).
- Launch-price rule: #91, #249 §2.

# UTM scheme for the launch

Issue #45 (measurement), used by every file in this folder (#51, #249).
Every link to `https://reelforge.buildbase.app` in launch copy carries these
four parameters. BuildBase Analytics then shows visits, goals and orders per
channel, and the same table is the traffic-source evidence for #56.

## The four parameters

| Parameter | Value | Rule |
| --- | --- | --- |
| `utm_source` | the channel (table below) | lowercase, one word or kebab-case |
| `utm_medium` | the kind of placement (table below) | one of `email`, `launch`, `community`, `social`, `article`, `dm`, `directory`, `short` |
| `utm_campaign` | `launch-2026-12` | the same for every launch link, as #45 and `SITE_PLAN.md` §F.5 set it |
| `utm_content` | `MMDD-<slug>` | the posting date (UTC) and what was posted, e.g. `1202-maker-comment` |

`utm_content` carries the date and the post, so one campaign name groups the
whole launch and each post still shows on its own. Keep every value lowercase
with hyphens; no spaces, no personal data, no names of the people you message.

## Per channel

| Channel | File | `utm_source` | `utm_medium` | `utm_content` pattern | Example |
| --- | --- | --- | --- | --- | --- |
| Waitlist email 1 (Dec 1) | `01-…` | `buildbase-email` | `email` | `1201-wl1-<link>` | `1201-wl1-pricing` |
| Waitlist email 2 (Dec 14) | `02-…` | `buildbase-email` | `email` | `1214-wl2-<link>` | `1214-wl2-agents` |
| Product Hunt (Dec 2) | `03-…` | `producthunt` | `launch` | `1202-<listing\|maker-comment\|reply>` | `1202-listing` |
| Show HN (Dec 3) | `04-…` | `hackernews` | `community` | `1203-showhn` | `1203-showhn` |
| Reddit (Dec 4 to 6) | `05-…` | `reddit` | `community` | `MMDD-r-<subreddit>` | `1204-r-sideproject` |
| X | `06-…` | `x` | `social` | `MMDD-post-<nn>` or `MMDD-thread` | `1202-thread` |
| LinkedIn | `06-…` | `linkedin` | `social` | `MMDD-post-<nn>` | `1208-post-04` |
| dev.to (Dec 7) | `07-…` | `devto` | `article` | `1207-mcp-article` | `1207-mcp-article` |
| Founder outbound | `08-…` | `outbound` | `dm` | `MMDD-<agency\|creator\|builder>` | `1209-agency` |
| MCP directories (Dec 12 to 13) | `09-…` | the directory, e.g. `mcp-so`, `glama` | `directory` | `MMDD-listing` | `1212-listing` |
| YouTube Shorts (`SITE_PLAN.md` §B.7) | — | `youtube` | `short` | `MMDD-<reel-slug>` | `1205-how-solar-panels-work` |

`SITE_PLAN.md` §B.7 used `utm_campaign=launch` for YouTube; use
`launch-2026-12` instead so all launch traffic sits in one campaign.

## Building a link

```text
https://reelforge.buildbase.app/agents?utm_source=hackernews&utm_medium=community&utm_campaign=launch-2026-12&utm_content=1203-showhn
```

Paths used in this kit: `/` (home), `/agents`, `/pricing`, `/waitlist`,
`/gallery` (only once the reels show there, #89) and
`/docs/start/quick-start` (only once production docs load, #93; today it
answers 404, so link the repository's quick start instead).

## Links that carry no UTMs

GitHub links (the repository, a tutorial, a doc) carry no UTMs: GitHub
ignores them and BuildBase Analytics cannot see visits there. Where a post
can link either, link the site. Email links go to the site only.

## Checking it works

1. Open one tagged link per channel in a private window before posting.
2. In BuildBase Analytics, check the visit shows under that source and
   campaign (the goals themselves are #45's work).
3. After posting, note the post URL and date in #51 (one checklist comment
   per channel), as #51 asks.

## Facts checked

- Campaign value and "`utm_source` = channel": #45 and
  [`SITE_PLAN.md` §F.5](../research/SITE_PLAN.md) ("A UTM convention table in
  the README (`utm_source` = channel, `utm_campaign` = `launch-2026-12`)").
- `/docs/start/quick-start` answers 404 and `/gallery` says "The gallery is
  being rendered" on production: checked 2026-11-23 with `curl` against
  https://reelforge.buildbase.app.

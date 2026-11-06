# Channel research

## Why this and not the obvious thing

987 of 1,058 contacts on this book have a YouTube link. **Two have a note.**

The CRM knows almost nothing written down about these people, which is why the
Desk Assistant's brief read thin — and their channel is sitting there saying a
great deal. For a business that sells YouTube help to realtors, whether
somebody posts weekly or stopped in August is not background colour, it *is*
the qualifying conversation.

## What it reads

The **official YouTube Data API v3**, public data only, three quota units per
contact: `channels` → `playlistItems` → `videos`. The free allowance is 10,000
units a day, so about 3,300 contacts.

**No scraping.** Nothing parses HTML, nothing pretends to be a browser, and the
function talks to exactly one host — there is a test asserting that.

**Zillow was asked for and is deliberately absent.** It has no public API for
agent profiles and its terms forbid scraping. Building it would mean breaking
a site's terms and shipping something that breaks again the first time their
markup changes. If a Zillow profile matters, the rep pastes what they can see
and it is labelled rep-provided, like any other pasted excerpt.

Old-style `/c/` and `/user/` URLs are refused with an explanation rather than
guessed at: resolving them costs a search call at 100 units against 3 for
everything else. Seven links on this book are YouTube **search-result pages**,
which name no channel at all; those are reported as a bad link to fix on the
contact.

## What it works out

`channelSignals` in logic.js, which is arithmetic over the numbers the API
returned — **no model is involved**:

- last upload, and whether that makes them dormant (42 days)
- posting cadence, as the **median** gap across the last 20 uploads, so one
  long holiday does not redefine the habit
- uploads this quarter against last quarter
- shorts versus long-form median views, claimed **only** when there are at
  least three of each — two shorts against eleven long videos is not a finding
- a breakout video, only when it beat the median by 3× — the merely-highest
  video is not an outlier
- reach against subscriber count

`channelQuestions` turns those into questions, and **every one carries the
number it came from**:

> "You were posting weekly until August — what got in the way?"
> *from: last upload 97 days ago*

That provenance is the whole reason a rep can say it out loud. It can be
checked on the channel in ten seconds. "They seem to be losing momentum"
cannot be checked at all.

## What it will not claim

- A **hidden** subscriber count is reported as hidden, never as zero.
  `Number(null)` is `0`, and the first version of this said a channel with a
  hidden count had **no subscribers** — a false statement about somebody's
  channel, printed as a sourced fact, for a rep to repeat back to the person
  who owns it.
- A video whose duration cannot be read counts as **neither** short nor long.
  `null <= 180` is true in JavaScript, so the obvious version filed every
  unreadable duration under shorts and moved the medians the comparison is
  built on.
- Subscriber counts are rounded to three significant figures **by YouTube**,
  which `subscribersApprox` says rather than printing false precision.

## Untrusted input

Video titles are written by whoever owns the channel. Nothing interprets them,
nothing executes them, and **no model sees them**. A title reading "ignore
previous instructions" is stored and displayed as a title.

## Caching

`client_research`, one row per contact per source, replaced on refresh. A read
under 24 hours old is served from it. Re-reading 987 channels on every brief
would spend the day's quota in about three hours and make the assistant slower
than opening YouTube by hand.

A **quota** failure is deliberately not cached: that is about today, not about
the channel, and remembering it would leave the contact blank until somebody
forced a refresh.

## Setup

1. **Create a YouTube Data API v3 key** in Google Cloud Console (same project
   as the Calendar credentials is fine) and set it as the `YOUTUBE_API_KEY`
   secret on the Supabase project. Without it the function returns `no_key`
   and says so; the brief still works from your own records.
2. **Apply `supabase/migrations/20261106190000_client_research.sql`** — the
   cache table. Not yet applied. `supabase db push` does not work on this
   repo; see `docs/desk-assistant.md`. Paste it into the SQL editor.
3. **Deploy `channel-research`**, and the functions that bundle `logic.js`,
   which changed.

Until 1 and 2 are done the panel shows the reason rather than failing silently.

## Still open

- **Only the rep's own channel link is used.** There is no search, so a
  contact with no link on file gets nothing. Adding search means a paid API
  and a decision about cost.
- Websites and blogs are still the **paste** path. A guarded server-side
  fetcher for arbitrary URLs would need SSRF validation on destinations *and*
  every redirect hop, and is not built.

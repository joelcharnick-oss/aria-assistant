# Known issues & incident log

What has gone wrong with this app, why, what fixed it, and what now watches
for it. Built from the commit history (Aug–Nov 2026). Keep this updated when
something new breaks — the weekly Claude health check reads it.

Live app: https://aria-assistant-wh9l.onrender.com (Render free tier, Node,
Upstash Redis for storage). Breakfast picker UI: `/breakfast.html`.

## Monitoring now in place

| Check | When | What it catches | Alerts via |
|---|---|---|---|
| `verify-deploy.yml` | every push to `main` | push didn't go live within 15 min (#1) | `deploy-alert` issue → email |
| `daily-health.yml` → live-app | daily, ~5:13 AM PT | app down; live commit ≠ latest `main` (#1); Redis unconfigured/broken (#4); `/api/breakfast` failing (#3) | `deploy-alert` issue → email |
| `daily-health.yml` → dependency-audit | daily | high/critical npm vulnerabilities (#6) | `deploy-alert` issue → email |
| Weekly Claude check-in | weekly | everything above, plus Actions not running, signs of #2 in `/api/debug-log`, model retirement (#7) | push notification / report |

Alert issues close themselves when the check passes again.

---

## 1. Render auto-deploy silently stopped (Oct 22 – Nov 20, 2026)

**What happened:** The GitHub → Render connection broke without any error.
Every commit pushed to `main` after `38ded13` (Oct 22) sat undeployed for a
month. Found only by manually checking the Render dashboard. Fixed by
reconnecting GitHub in Render; `f6100a5` was the first auto-deploy after.

**Knock-on effect:** The fixes for #2 and #3 committed Oct 27 – Nov 6
(`c9592fd`, `3fa7df6`, `4571aae`, `c0ab49b`) were **not live until Nov 20**.
Any "choices disappeared" reports in that window were against the *old* code
and say nothing about whether those fixes work.

**Now:** `GET /` reports `commit` (from `RENDER_GIT_COMMIT`); both GitHub
workflows compare it to `main`. Render deploy notifications set to "All".

**If it happens again:** Render → aria-assistant → Deploys (is there a deploy
for the commit? failed?) → Settings → Build (source
`joelcharnick-oss / aria-assistant`, branch `main`) → Settings → Deploy
(Auto-Deploy on) → reconnect GitHub. Stopgap: Manual Deploy → latest commit.

## 2. Kids' breakfast choices disappearing (recurring, Oct–Nov 2026)

The most-reported problem. A series of separate race conditions, each fixed:

| Date | Commit | Cause |
|---|---|---|
| Oct 13 | `adcb5cb` | Saves pushed the whole state blob; a stale tab overwrote newer picks |
| Oct 15 | `85a1d93` | `save.choices()` and `save.history()` raced each other |
| Oct 19 | `2d401af` | 5-min background resync wiped open edit forms |
| Oct 20 | `59cabca` | Background `load()` raced in-flight saves |
| Oct 22 | `af14929` | **Moved all merging to the server** (patches, single serialized queue) |
| Oct 27 | `3fa7df6` | Same race for items/active/itemOrder; `toggleItem()` never saved |
| Nov 4 | `4571aae` | Day-rollover reset raced the morning's first picks (44% failure in stress test → 0%) |
| Nov 6 | `c0ab49b` | Added write audit log at `GET /api/debug-log` |

**Open — likely remaining cause (found Nov 20, not yet fixed):**
`load()` in `public/breakfast.html` gives up after **3 seconds**. On Render's
free tier the server sleeps after ~15 min idle and takes ~50 s to wake. When an
always-open device (the kitchen iPad PWA resumed from the app switcher)
re-syncs against a sleeping server, `load()` times out and sets
`serverAvailable = false`. From then on `pushToServer()` **returns without
sending anything and without any warning** — picks are saved only to that
device's localStorage. The next successful sync (≤5 min later, or on refocus)
applies the server's state, which never received those picks, so they vanish
from the screen and from history. This matches "picks were there, then gone."

Possible fixes: retry/lengthen the load timeout and keep retrying in the
background; queue patches while offline instead of dropping them; show a
banner when `serverAvailable` is false; or move to a paid Render instance
(no sleep).

**Diagnosing:** `GET /api/debug-log` shows recent writes, but it is in memory
only — a free-tier spin-down erases it, so check it the same morning. A write
with non-empty `choicesKidsBefore` and empty `choicesKidsAfter` without a
`dayRollover` is a wipe. Missing writes for a pick point to the issue above.

## 3. Saves silently dropped / storage outage looked like "no data" (Oct 27)

`c9592fd`: failed saves were swallowed with `.catch(() => {})` — now retried
with backoff, then a toast. `GET /api/breakfast` returned `200 {}` on a Redis
error — now returns 500 so clients keep their local copy. Setup screen shows a
banner if `/api/status` reports Redis broken. (Note: the `serverAvailable =
false` path in #2 still drops saves silently.)

## 4. Free tier's disk is wiped on every restart/deploy

Without `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, data goes to
`breakfast-data.json` on local disk, which Render's free tier discards. The
daily check fails if `/api/status` reports Redis unconfigured or not working.

## 5. Always-open device kept showing yesterday's picks (Sep 25–28)

Day-rollover reset only ran on page load/focus; an iPad PWA resumed from the
app switcher never reloads. Fixed with a 5-minute periodic resync (`cc17793`).

## 6. Vulnerable dependencies (Oct 22)

`38ded13`: `npm audit fix` for proxy-addr (critical), follow-redirects (high),
qs/body-parser/express (moderate). Daily `npm audit --audit-level=high` now
watches for new ones.

## 7. Hard-coded Claude model ID (Aug 18)

The insights endpoint first used a wrong model ID (`4e70a20`). Both
`/whatsapp` and `/api/insights` hard-code `claude-opus-4-6`; when Anthropic
retires that model, both break. The weekly check looks for a retirement
notice.

## 8. Smaller fixed bugs

- iOS Safari didn't support `AbortSignal.timeout` → replaced with
  `AbortController` (`6c41ab2`, Aug 18).
- Sub-option chips didn't respond to taps — HTML quoting bug (`4db78fe`, Aug 25).

## Other notes

- `GET /api/debug-log` is public and includes device IP addresses and user
  agents. Consider removing it or requiring a token once #2 is settled.
- Conversation memory for the WhatsApp assistant is in memory and resets on
  every restart/spin-down (by design, but worth knowing).

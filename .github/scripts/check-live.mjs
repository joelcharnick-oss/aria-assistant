#!/usr/bin/env node
// Checks the live Render deployment of this app. Used by the GitHub Actions
// workflows in .github/workflows/ — no dependencies, Node 18+.
//
// Why this exists: in Oct–Nov 2026 Render's auto-deploy silently stopped
// firing for about a month. Every fix pushed to main sat undeployed and
// nothing anywhere said so. GET / now reports the live commit
// (RENDER_GIT_COMMIT), so these checks compare it against what GitHub has.
//
// Usage:
//   node check-live.mjs wait-for-commit <sha>
//       Polls until the live app reports <sha>. Exits 1 on timeout.
//   node check-live.mjs health <expected-sha> [grace-minutes-since-commit]
//       One-shot check: app up, running <expected-sha>, storage healthy,
//       breakfast data readable. A commit newer than the grace window is
//       allowed to not be live yet (its deploy may still be running).
//
// Env:
//   BASE_URL            default https://aria-assistant-wh9l.onrender.com
//   TIMEOUT_MINUTES     wait-for-commit timeout, default 15
//   POLL_SECONDS        default 20
//   COMMIT_TIME         ISO time of <expected-sha> (health mode grace window)
//   GITHUB_STEP_SUMMARY appended with a markdown report when set
//   REPORT_FILE         same report, for the alert issue body

import { appendFileSync } from 'node:fs';

const BASE_URL = (process.env.BASE_URL || 'https://aria-assistant-wh9l.onrender.com').replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function summary(md) {
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  if (process.env.REPORT_FILE) appendFileSync(process.env.REPORT_FILE, md + '\n');
}

// Free Render instances spin down when idle and take ~50s+ to wake, so give
// each request a generous timeout and a couple of retries before calling it down.
async function getJson(path, { timeoutMs = 90_000, tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE_URL + path, { signal: ctrl.signal, headers: { 'cache-control': 'no-cache' } });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, body, text };
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(10_000);
    } finally {
      clearTimeout(t);
    }
  }
  return { status: 0, body: null, text: String(lastErr?.message || lastErr) };
}

const short = s => (s ? String(s).slice(0, 7) : String(s));

async function waitForCommit(sha) {
  const timeoutMin = Number(process.env.TIMEOUT_MINUTES || 15);
  const pollMs = Number(process.env.POLL_SECONDS || 20) * 1000;
  const deadline = Date.now() + timeoutMin * 60_000;
  let last = null;
  console.log(`Waiting up to ${timeoutMin} min for ${BASE_URL} to report commit ${sha}`);
  while (Date.now() < deadline) {
    const r = await getJson('/', { tries: 1 });
    const live = r.body?.commit ?? null;
    last = r.status ? `HTTP ${r.status}, commit ${short(live)}` : `unreachable (${r.text})`;
    console.log(`[${new Date().toISOString()}] ${last}`);
    if (r.status === 200 && live === sha) {
      summary(`### ✅ Deploy verified\nThe live app is running \`${short(sha)}\` — auto-deploy worked.`);
      return 0;
    }
    await sleep(pollMs);
  }
  summary([
    `### ❌ Push to main did not go live`,
    `After ${timeoutMin} minutes the live app still isn't running \`${short(sha)}\`.`,
    `Last check: ${last}.`,
    ``,
    `**This is the same failure as the month-long silent auto-deploy outage.** Check, in order:`,
    `1. Render dashboard → aria-assistant → **Deploys**: is there a deploy for \`${short(sha)}\`? If it failed, open its log.`,
    `2. If there's no deploy at all: Settings → **Build** → Source should be \`joelcharnick-oss / aria-assistant\`, branch \`main\`. Reconnect GitHub if needed, and check Settings → **Deploy** → Auto-Deploy is on.`,
    `3. As a stopgap, use **Manual Deploy → Deploy latest commit**.`,
  ].join('\n'));
  return 1;
}

async function health(expectedSha, graceMinutes = 20) {
  const problems = [];
  const notes = [];

  const root = await getJson('/');
  const live = root.body?.commit ?? null;
  if (root.status !== 200 || root.body?.status !== 'Aria is online') {
    problems.push(`App is down or unhealthy at \`/\` (${root.status ? 'HTTP ' + root.status : root.text}).`);
  } else if (!live) {
    problems.push('App is up but `/` reports no `commit` — RENDER_GIT_COMMIT missing, so deploys can\'t be verified.');
  } else if (live !== expectedSha) {
    const commitTime = process.env.COMMIT_TIME ? Date.parse(process.env.COMMIT_TIME) : NaN;
    const ageMin = Number.isNaN(commitTime) ? Infinity : (Date.now() - commitTime) / 60_000;
    if (ageMin < graceMinutes) {
      notes.push(`Latest main commit \`${short(expectedSha)}\` is only ${Math.round(ageMin)} min old and not live yet (live: \`${short(live)}\`) — its deploy is probably still running.`);
    } else {
      problems.push(`Live app is running \`${short(live)}\` but main is at \`${short(expectedSha)}\`. **Auto-deploy may have stopped again** — check Render → Deploys and Settings → Build.`);
    }
  } else {
    notes.push(`Live app is running the latest main commit \`${short(live)}\`.`);
  }

  const st = await getJson('/api/status');
  if (st.status !== 200 || !st.body) {
    problems.push(`\`/api/status\` failed (${st.status ? 'HTTP ' + st.status : st.text}).`);
  } else if (!st.body.redisConfigured) {
    problems.push('Redis is **not configured** — breakfast data is going to local disk, which Render\'s free tier wipes on every restart/deploy.');
  } else if (!st.body.redisWorking) {
    problems.push(`Redis is configured but **not working**${st.body.error ? ` (${st.body.error})` : ''} — saves will fail.`);
  } else {
    notes.push('Redis storage is configured and responding.');
  }

  const bf = await getJson('/api/breakfast');
  if (bf.status !== 200 || !bf.body || typeof bf.body !== 'object') {
    problems.push(`\`/api/breakfast\` failed (${bf.status ? 'HTTP ' + bf.status : bf.text}) — devices can't load shared state.`);
  } else {
    notes.push('Shared breakfast data loads normally.');
  }

  if (problems.length) {
    summary(['### ❌ Daily health check found problems', ...problems.map(p => `- ${p}`), '', ...notes.map(n => `- ${n}`)].join('\n'));
    return 1;
  }
  summary(['### ✅ Daily health check passed', ...notes.map(n => `- ${n}`)].join('\n'));
  return 0;
}

const [mode, arg, grace] = process.argv.slice(2);
let code;
if (mode === 'wait-for-commit' && arg) code = await waitForCommit(arg);
else if (mode === 'health' && arg) code = await health(arg, grace ? Number(grace) : undefined);
else {
  console.error('usage: check-live.mjs wait-for-commit <sha> | health <expected-sha> [grace-minutes]');
  code = 2;
}
process.exit(code);

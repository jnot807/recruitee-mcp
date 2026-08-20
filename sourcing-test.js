#!/usr/bin/env node
'use strict';
// Guards rt_source_candidates.
//
// THE HAZARD THIS EXISTS FOR. /search/new/candidates silently ignores anything
// it does not recognise. An unknown entity name, `nin` instead of `not_in`, an
// unknown sort — none of them error. The search simply comes back unfiltered,
// which on this tenant is 23,000 people and looks exactly like a filter that
// matched everybody. A recruiter reading that has no way to tell.
//
// So half of these checks are the ordinary "does it work" kind, and half exist
// to prove the client REFUSES what the API would have swallowed. The second
// half runs without a token; the first half needs one and is skipped without.

const client = require('./client');

let failures = 0;
function check(name, pass, detail) {
  process.stdout.write(`${pass ? 'ok   ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!pass) failures++;
}
async function throws(name, fn, expect) {
  try {
    await fn();
    check(name, false, 'it was accepted — the API would have ignored it and returned everybody');
  } catch (e) {
    check(name, expect.test(e.message), expect.test(e.message) ? 'refused' : `wrong message: ${e.message}`);
  }
}

(async () => {
  // ── Refusals. No token needed: these must never reach the network. ───────
  await throws('an unknown sort is refused', () => client.sourceCandidates({ sortBy: 'newest' }), /not a valid sort/i);
  await throws('an unknown candidate status is refused', () => client.sourceCandidates({ status: 'rejected' }), /not a valid candidate status/i);
  await throws('an unknown job status is refused', () => client.sourceCandidates({ jobStatus: 'open' }), /not a valid job status/i);

  if (!client.readToken()) {
    process.stdout.write('\nNo API token configured, so the live half was skipped.\n');
    process.exit(failures ? 1 : 0);
  }

  // ── Live behaviour. ─────────────────────────────────────────────────────
  const all = await client.sourceCandidates({ limit: 1 });
  check('an unfiltered search returns the whole database', all.total > 1000, `${all.total} candidates`);
  check('and says so rather than implying it was filtered', /whole database/.test(all.filtersApplied));

  const text = await client.sourceCandidates({ query: 'renewals AND churn', limit: 1 });
  check('a text search is actually applied', text.total > 0 && text.total < all.total, `${text.total} of ${all.total}`);

  // The failure that started all this: a query the API ignores comes back as
  // the full database. If this ever equals `all.total` again, the endpoint has
  // gone back to ignoring us and every result since is suspect.
  check('...and is not silently ignored', text.total !== all.total, 'a filtered count must differ from the unfiltered one');

  const nonsense = await client.sourceCandidates({ query: 'zzzznotarealtermatall', limit: 1 });
  check('a term nobody matches returns nothing', nonsense.total === 0, `${nonsense.total}`);
  check('an empty result offers the real stage names', Array.isArray(nonsense.availableStages) && nonsense.availableStages.length > 0);

  // Boolean operators, the thing that makes this worth using over a name search.
  const broad = await client.sourceCandidates({ query: 'renewals OR churn', limit: 1 });
  check('OR widens what AND narrowed', broad.total > text.total, `OR ${broad.total} > AND ${text.total}`);

  const offers = await client.listOffers({ limit: 50 });
  const role = offers.find((o) => o.status === 'published') || offers[0];
  if (role) {
    const on = await client.sourceCandidates({ offer: role.title, limit: 1 });
    const off = await client.sourceCandidates({ excludeOffer: role.title, limit: 1 });
    check('a role filter and its exclusion partition the database',
      on.total + off.total === all.total,
      `${on.total} on + ${off.total} not on = ${on.total + off.total}, database is ${all.total}`);

    const both = await client.sourceCandidates({ offer: role.title, excludeOffer: role.title, limit: 1 });
    check('including and excluding the same role yields nobody', both.total === 0, `${both.total}`);

    // The bug this pins: a role and a job status are two constraints on the
    // SAME entity. Sent as two filter objects the role is dropped without a
    // word, and the search returns everyone with that job status — a number
    // four times too big that looks entirely reasonable.
    if (role.status === 'published') {
      const byStatus = await client.sourceCandidates({ jobStatus: 'published', limit: 1 });
      const both = await client.sourceCandidates({ offer: role.title, jobStatus: 'published', limit: 1 });
      check('a role plus a job status keeps the role',
        both.total === on.total && both.total !== byStatus.total,
        `role+status ${both.total} should equal role ${on.total}, not status ${byStatus.total}`);
    }

    const combined = await client.sourceCandidates({ query: 'renewals AND churn', offer: role.title, limit: 1 });
    check('filters AND together rather than replacing each other',
      combined.total <= text.total && combined.total <= on.total,
      `${combined.total} ≤ text ${text.total} and ≤ role ${on.total}`);
  } else {
    check('a role filter and its exclusion partition the database', false, 'no offers visible to test with');
  }

  await throws('an unknown tag name is refused, with the real ones listed',
    () => client.sourceCandidates({ tags: ['definitely-not-a-real-tag'] }), /No tag called .* This company has: /);

  const capped = await client.sourceCandidates({ query: 'manager', limit: 5000 });
  check('limit is capped rather than passed through', capped.returned <= 100, `asked 5000, got ${capped.returned}`);

  const ev = await client.sourceCandidates({ query: 'renewals', limit: 3 });
  check('every result carries the evidence for why it matched',
    ev.candidates.every((c) => Array.isArray(c.whyMatched)));
  check('and the evidence is readable text, not HTML',
    ev.candidates.every((c) => c.whyMatched.every((w) => !/<em>|&amp;|&lt;/.test(w.text))));
  check('every result says which roles the person is already on',
    ev.candidates.every((c) => Array.isArray(c.roles)));

  process.stdout.write(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  process.stdout.write(`\ncrashed: ${e.message}\n`);
  process.exit(1);
});

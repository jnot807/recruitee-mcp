#!/usr/bin/env node
'use strict';
// Proves the server speaks MCP and, if a token is present, that the token
// reaches Recruitee. Run: node recruitee/smoke-test.js
//
// Without a token it still passes the protocol half — a tool call comes back
// with the "no token" error rather than a crash, which is the correct failure.

const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, 'server.js');

function rpc(child, msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

async function main() {
  const child = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const seen = new Map();
  let buf = '';

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id) seen.set(m.id, m); } catch { /* not ours */ }
    }
  });

  const wait = (id, ms = 15000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (seen.has(id)) { clearInterval(tick); resolve(seen.get(id)); }
      else if (Date.now() - t0 > ms) { clearInterval(tick); reject(new Error(`timed out waiting for id ${id}`)); }
    }, 50);
  });

  let failures = 0;
  const check = (label, pass, detail = '') => {
    process.stdout.write(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
    if (!pass) failures++;
  };

  try {
    rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
    const init = await wait(1);
    check('initialize', !!init.result, init.result?.serverInfo?.name);

    rpc(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await wait(2);
    const tools = list.result?.tools || [];
    check('tools/list', tools.length > 0, `${tools.length} tools`);

    // The safety property that matters most: no tool may REJECT or REMOVE a
    // candidate. Assert it, don't assume it.
    //
    // Stage moves used to be on this list and are now deliberately allowed
    // (rt_set_stage), because advancing somebody is bookkeeping, not a
    // judgement. The line moved to disqualification.
    const forbidden = tools.filter((t) => /disqualif|reject|delete|destroy|requalif|anonymi|conceal/i.test(t.name));
    check('no destructive tools exposed', forbidden.length === 0, forbidden.map((t) => t.name).join(', ') || 'none');

    // A stage mover is allowed to exist, but only one that cannot requalify:
    // changing the stage of a disqualified placement would reverse a human's
    // rejection as a side effect. The refusal lives in client.moveStage, so
    // assert it at the source rather than trusting the description.
    const mover = tools.find((t) => t.name === 'rt_set_stage');
    if (mover) {
      const clientSrc = require('node:fs').readFileSync(path.join(__dirname, 'client.js'), 'utf8');
      check('stage moves refuse a disqualified placement',
        /disqualifiedAt[\s\S]{0,400}?requalify/.test(clientSrc),
        'client.moveStage must throw on a disqualified placement');
      check('stage moves are scoped to one offer',
        !!mover.inputSchema?.required?.includes('offer'),
        'a candidate can sit on several pipelines; moving "them" must name which');
    }

    // Every write must advertise the two-call gate. Derived from the schema —
    // a name-pattern list silently stops covering each new write tool.
    const READS = /^rt_(list_offers|get_stages|offer_candidates|get_candidate|search_candidates|source_candidates|get_rating_scale|get_evaluations|get_notes)$/;
    const writes = tools.filter((t) => !READS.test(t.name));
    const ungated = writes.filter((t) => !t.inputSchema?.properties?.confirm);
    check('every write has a confirm gate', ungated.length === 0,
      ungated.length ? `ungated: ${ungated.map((t) => t.name).join(', ')}` : `${writes.length} writes, 0 ungated`);

    rpc(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rt_list_offers', arguments: { limit: 3 } } });
    const call = await wait(3);
    const text = call.result?.content?.[0]?.text || '';
    const payload = (() => { try { return JSON.parse(text); } catch { return {}; } })();

    if (payload.error && /No Recruitee API token/.test(payload.error)) {
      check('rt_list_offers (no token)', true, 'refused cleanly with setup instructions');
      process.stdout.write('\nNo API token configured, so the live half was skipped.\nGenerate one in Tellent, then run in this folder: npm run set-token -- <token>\n');
    } else if (payload.offers) {
      check('rt_list_offers (live)', true, `${payload.offers.length} offers`);
      for (const o of payload.offers) process.stdout.write(`        ${o.id}  ${o.title} (${o.status})\n`);
    } else {
      check('rt_list_offers', false, payload.error || text.slice(0, 200));
    }
  } finally {
    child.kill();
  }

  process.stdout.write(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`smoke test crashed: ${e.message}\n`); process.exit(1); });

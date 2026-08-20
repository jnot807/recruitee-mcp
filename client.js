'use strict';
// Recruitee / Tellent REST client.
//
// WHY THIS EXISTS. The Composio `recruitee` connector builds its base URL with
// the full hostname (`<company>.recruitee.com`) sitting in the path segment
// where Recruitee expects the bare company id. Every tool whose input schema
// lacks a `company_id` override therefore fails: CREATE_CANDIDATE 422s with
// "Company id is invalid", and the notes and pipeline-stage endpoints 403.
// Unfixable from the caller's side, because Composio strips arguments that are
// not in the tool's schema.
//
// Building the base URL from a configured company id here makes that entire
// class of bug impossible. It also opens up the real API: apidocs.recruitee.com
// documents
// ~948 endpoints, where the docs.recruitee.com set the connector was built
// against covers about fifteen and describes itself as "most commonly used".
//
// AUTH is a personal API token (Settings > Apps and plugins > API tokens >
// Personal API tokens), sent as `Authorization: Bearer`. Recruitee's own documentation is
// blunt about what that means: a token "will allow to perform the same actions
// as in the web or mobile application IN THE NAME OF THAT USER". There is no
// scoping. An admin's token can disqualify, delete and anonymise.
//
// That is why this file exposes no destructive call at all. Not gated behind a
// flag, not commented out — absent. Stage moves, disqualification and deletion
// are real endpoints that this client deliberately does not implement, so no
// prompt, bug or confused caller can reach them.

const API_ROOT = 'https://api.recruitee.com';

const path = require('node:path');
const fs = require('node:fs');

// Token AND company live together: neither is useful alone, and a token that
// silently addressed somebody else's tenant would be the worst kind of wrong.
// There is deliberately NO default company — this ships to whoever wants it,
// so a baked-in tenant would be both an accident waiting to happen and
// somebody's account details in a public repository.
const TOKEN_PATH = path.join(__dirname, 'session', 'token.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) || {}; } catch { return {}; }
}

function companyId() {
  const v = String(process.env.RECRUITEE_COMPANY_ID || readConfig().companyId || '').trim();
  if (!v) {
    throw new RecruiteeError(
      'No Recruitee company set. It is on the same screen as the token — Settings > Apps and plugins > ' +
      'API tokens, in the "Current company details" panel. Either the numeric ID or the subdomain works. ' +
      'Then run `npm run set-token -- <token> <company>` inside the recruitee-mcp folder, or set ' +
      'RECRUITEE_COMPANY_ID.'
    );
  }
  return v;
}

// Env first so a shell can override; the file is the persistent home.
function readToken() {
  const fromEnv = String(process.env.RECRUITEE_API_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  return String(readConfig().token || '').trim() || null;
}

// Either value can be set on its own — re-running with just a token after a
// rotation must not wipe the company that was already working.
function writeToken(token, company) {
  const prev = readConfig();
  const next = {
    token: String(token || prev.token || '').trim() || null,
    companyId: String(company || prev.companyId || '').trim() || null,
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return TOKEN_PATH;
}

class RecruiteeError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// One request. Every path here is relative to /c/{company_id}, so a caller can
// never accidentally address another tenant.
async function api(method, endpoint, { body, query } = {}) {
  const token = readToken();
  if (!token) {
    throw new RecruiteeError(
      'No Recruitee API token. Generate one at Settings > Apps and plugins > API tokens > Personal API tokens ' +
      '(app.tellent.com), then run `npm run set-token -- <token>` inside the recruitee-mcp folder, or set RECRUITEE_API_TOKEN.'
    );
  }

  const url = new URL(`${API_ROOT}/c/${companyId()}${endpoint}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((one) => url.searchParams.append(`${k}[]`, String(one)));
    else url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }

  if (!res.ok) {
    // Surface Recruitee's own validation messages rather than a bare status —
    // "Company id is invalid" is the line that identified the Composio bug.
    const detail = parsed?.errors
      ? parsed.errors.map((e) => e.message || e.code).join('; ')
      : (text || '').slice(0, 300);
    throw new RecruiteeError(`${method} ${endpoint} → ${res.status}${detail ? `: ${detail}` : ''}`, {
      status: res.status,
      body: parsed || text,
    });
  }
  return parsed;
}

// ── Reads ──────────────────────────────────────────────────────────────────

async function listOffers({ query, limit = 50 } = {}) {
  const out = await api('GET', '/offers', { query: { q: query, limit } });
  const offers = out?.offers || [];
  return offers.map((o) => ({
    id: o.id,
    title: o.title,
    status: o.status,
    kind: o.kind,
    department: o.department,
    slug: o.slug,
    candidatesCount: o.candidates_count,
    pipelineTemplateId: o.pipeline_template_id,
  }));
}

// The stages of one offer, with a live count in each. Composio cannot do this
// at all — its GET_PIPELINE_STAGES has no company_id parameter, so it 403s.
//
// NOT via /offers/{id}/pipeline_templates: that lists the templates AVAILABLE to
// the offer (three of them here) without their stages. The placements endpoint
// returns the offer's real pipeline already grouped by stage, in one call.
async function getStages(offerId) {
  const out = await api('GET', `/offers/${Number(offerId)}/placements`);
  const stages = out?.stages || [];
  return {
    offerId: Number(offerId),
    stages: stages.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      group: s.group,
      position: s.position,
      candidates: s.placements_count ?? (s.placements || []).length,
      fairEvaluationsEnabled: s.fair_evaluations_enabled,
    })),
  };
}

// Candidates ON one offer. This is the fix for the second Composio defect: its
// GET_CANDIDATES silently ignores offerId and hands back the whole
// 11,400-record company database however you ask.
//
// The response is grouped by stage, not a flat placements array — so the stage
// name comes from the group, and flattening has to happen here.
async function offerCandidates(offerId, { limit = 200 } = {}) {
  const out = await api('GET', `/offers/${Number(offerId)}/placements`);
  const rows = [];
  for (const stage of out?.stages || []) {
    for (const p of stage.placements || []) {
      rows.push({
        placementId: p.id,
        candidateId: p.candidate_id ?? p.candidate?.id ?? null,
        name: p.candidate?.name || p.name || null,
        stageId: stage.id,
        stageName: stage.name,
        disqualifiedAt: p.disqualified_at || null,
        disqualifyReason: p.disqualify_reason || null,
        hiredAt: p.hired_at || null,
        ratings: p.ratings || {},
        createdAt: p.created_at,
      });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

async function getCandidate(candidateId) {
  const out = await api('GET', `/candidates/${Number(candidateId)}`);
  const c = out?.candidate || out;
  return {
    id: c.id,
    name: c.name,
    emails: c.emails || [],
    phones: c.phones || [],
    source: c.source,
    tags: c.tags || [],
    adminUrl: c.adminapp_url || null,
    createdAt: c.created_at,
    placements: (c.placements || []).map((p) => ({
      placementId: p.id,
      offerId: p.offer_id,
      stageId: p.stage_id,
      disqualifiedAt: p.disqualified_at || null,
      disqualifyReason: p.disqualify_reason || null,
      ratings: p.ratings || {},
    })),
    openQuestionAnswers: c.open_question_answers || [],
    groupedOpenQuestionAnswers: c.grouped_open_question_answers || [],
    references: out?.references || undefined,
  };
}

// Find candidates by name.
//
// NOT /search/new/candidates — that endpoint accepts `query` (and `term`) and
// ignores both, returning all 23,021 records every time. Exactly the failure
// mode Composio's GET_CANDIDATES has with offerId, and just as quiet. The plain
// /candidates list does filter.
async function searchCandidates({ query, limit = 25 } = {}) {
  const out = await api('GET', '/candidates', { query: { query, limit } });
  return (out?.candidates || []).map((h) => ({
    id: h.id,
    name: h.name,
    emails: h.emails || [],
    offerIds: (h.placements || []).map((p) => p.offer_id),
    adminUrl: h.adminapp_url || null,
  }));
}

// ── Evaluations ────────────────────────────────────────────────────────────

// The scale the company is actually configured for. `rating` on a submission
// must be one of these, and the set differs per tenant: a thumbs_4 scale has no
// "neutral", a thumbs_5 does. Validating against a guess would file the wrong
// verdict, so this is read, never assumed.
async function getRatingScale() {
  const out = await api('GET', '/candidates/settings/rating_scale');
  const scale = out?.default_rating_scale || out?.rating_scale || {};
  return {
    presentation: scale.presentation ?? null,
    range: scale.range ?? null,
    scoreDisplay: scale.score_display ?? null,
    points: scale.points ?? null,
    raw: out,
  };
}

// Every evaluation on a candidate, flattened into one readable list: who gave
// it, what they said, when, and at which stage.
//
// NOT /interview/candidates/{id}/results — that path 404s. The list lives at
// /interview/results with a candidate_id filter.
//
// ATTRIBUTION IS UNRELIABLE ON THE WAY BACK. Anything written through an API
// token is filed under the token owner, so `reviewer` is who Recruitee thinks
// evaluated, which for API-written rows is whoever holds the token rather than
// whoever ran the interview. The note usually names the real interviewer; that
// reconciliation is a question for the user, not a guess to make here.
async function getEvaluations(candidateId, { offerId } = {}) {
  const out = await api('GET', '/interview/results', {
    query: { candidate_id: Number(candidateId), offer_id: offerId },
  });
  const rows = out?.interview_results || [];

  // Recruitee returns names in a `references` sidecar rather than expanding them
  // on each row — the same shape the candidate list uses. Without this join the
  // stage and the reviewer come back as bare ids, which is exactly the detail a
  // caller needs in order to place the evaluation in the pipeline.
  const ref = new Map();
  (out?.references || []).forEach((r) => {
    const name = r.name || r.title
      || [r.first_name, r.last_name].filter(Boolean).join(' ')
      || null;
    ref.set(`${r.type}:${r.id}`, name);
  });

  const evaluations = rows
    .filter((r) => !offerId || r.offer_id === Number(offerId))
    .map((r) => ({
      id: r.id,
      rating: r.rating || null,
      note: r.rating_note || null,
      stage: r.stage?.name || ref.get(`Stage:${r.stage_id}`) || null,
      stageId: r.stage_id ?? null,
      offerId: r.offer_id ?? null,
      offerTitle: r.offer?.title || ref.get(`Offer:${r.offer_id}`) || null,
      reviewer: r.admin?.name || ref.get(`Admin:${r.admin_id}`) || r.guest?.name || null,
      interviewTemplate: r.interview_template_name || null,
      answers: (r.interview_result_answers || []).length,
      createdAt: r.created_at || null,
    }));
  return {
    candidateId: Number(candidateId),
    count: evaluations.length,
    evaluations,
    hiddenCount: (out?.hidden_results_preview || []).length,
    note: evaluations.length
      ? 'Read these before writing a new evaluation, so a new one builds on them rather than repeating them. If you copy them elsewhere, carry the evaluation id across so a re-sync updates rather than duplicates.'
      : 'No evaluations on this candidate in Recruitee.',
  };
}

// Write one evaluation onto a candidate, then READ IT BACK.
//
// Takes NAMES or ids for both the person and the role, so an evaluation can be
// filed from "Dana Whitfield, Regional Sales Manager, here is the text" without
// anybody looking up an id. Ambiguity throws rather than guessing.
//
// The stage defaults to WHERE THE CANDIDATE ACTUALLY IS on that offer. An
// evaluation is a verdict formed at a point in the pipeline, so inventing a
// stage would misfile it; if they hold no placement on the offer, that is an
// error worth surfacing rather than papering over.
//
// The POST response does not expand the stage or the reviewer, so the write is
// verified by reading it back — the same reason rc_send_inmail refuses to treat
// a Send click as proof.
//
// `kind: "rating"` is the plain thumbs-and-a-note card. Questionnaire scorecards
// carry per-question answers and are not implemented: the API documents
// interview_result_answers in responses but never in a request body.
// Recruitee's evaluation note is a plain-text field, but its UI renders that
// text as HTML — verified against the live product: a `<br>` produces a real
// line break while a newline collapses to a single space. So a note written
// with blank lines arrives as one run-on paragraph unless it is converted here.
//
// The API ignores rating_note_html and rating_note_json on both create and
// update, so this is the only way to get spacing across.
//
// ESCAPED FIRST. Because the field is rendered as HTML, a stray "<" in an
// interviewer's note would be swallowed or mangled — and anything worse than
// that would be rendered too. Escaping and then inserting our own <br> is what
// makes the conversion safe rather than a hole.
function toRecruiteeNote(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\r?\n/g, '<br>');
}

async function submitEvaluation({ candidate, offer, stage, rating, ratingNote }) {
  const off = await resolveOffer(offer);
  const cand = await resolveCandidate(candidate, { offerId: off.id });

  const placement = (cand.placements || []).find((p) => p.offerId === off.id);
  if (!placement) {
    throw new RecruiteeError(
      `${cand.name} is not on "${off.title || off.id}", so there is no pipeline position to file an evaluation against. ` +
      'Add them to the role first, or name the role they are actually on.'
    );
  }

  const stageId = stage
    ? (await resolveStage(off.id, stage)).id
    : placement.stageId;
  // Recruitee REQUIRES it — a submission without one 422s with "Stage id can't
  // be blank", which tells the caller nothing about what to do next.
  if (!stageId) {
    throw new RecruiteeError(
      `${cand.name} holds a placement on "${off.title || off.id}" with no stage, so there is nothing to file the evaluation against. ` +
      'Pass an explicit stage, or move them into one in Tellent.'
    );
  }

  const out = await api('POST', `/interview/candidates/${cand.id}/results`, {
    body: {
      interview_result: {
        kind: 'rating',
        offer_id: off.id,
        stage_id: stageId,
        rating,
        ...(ratingNote ? { rating_note: toRecruiteeNote(ratingNote) } : {}),
      },
    },
  });
  const r = out?.interview_result || out;
  const written = {
    id: r?.id ?? null,
    candidateId: cand.id,
    candidateName: cand.name,
    offerId: off.id,
    rating: r?.rating ?? null,
    createdAt: r?.created_at ?? null,
  };

  try {
    const back = await api('GET', `/interview/candidates/${cand.id}/results/aggregated`, {
      query: { offer_id: off.id },
    });
    const agg = back?.aggregated_results || {};
    const last = agg.summary?.last_evaluation || null;
    return {
      ...written,
      verified: (agg.evaluations_count || 0) > 0,
      evaluationsOnRecord: agg.evaluations_count ?? null,
      filedAs: (agg.summary?.reviewers || []).map((x) => x.name || x).join(', ') || null,
      stage: last?.stage?.name ?? null,
      scorePercent: agg.summary?.score?.average ?? null,
      adminUrl: cand.adminUrl || null,
    };
  } catch (e) {
    return {
      ...written,
      verified: false,
      verifyError: `The evaluation was accepted (id ${written.id}) but could not be read back: ${e.message}. Do not report it as confirmed.`,
    };
  }
}

// ── Resolution helpers ─────────────────────────────────────────────────────
// So a caller can say "Regional Sales Manager" and "Dana Whitfield" instead of
// hunting for ids. Ambiguity is REPORTED, never resolved by picking the first
// match — filing an evaluation on the wrong person is the failure that matters.

async function resolveOffer(offerTitleOrId) {
  if (/^\d+$/.test(String(offerTitleOrId))) return { id: Number(offerTitleOrId) };
  const wanted = String(offerTitleOrId).trim().toLowerCase();
  const offers = await listOffers({ limit: 100 });
  const exact = offers.filter((o) => o.title.toLowerCase() === wanted);
  const partial = offers.filter((o) => o.title.toLowerCase().includes(wanted));
  const hits = exact.length ? exact : partial;
  if (!hits.length) {
    throw new RecruiteeError(
      `No offer matches "${offerTitleOrId}". Open roles: ` +
      offers.filter((o) => o.status === 'published').map((o) => o.title).join(', ')
    );
  }
  if (hits.length > 1) {
    throw new RecruiteeError(
      `"${offerTitleOrId}" matches ${hits.length} offers: ` +
      hits.map((o) => `${o.title} (${o.id})`).join(', ') + '. Say which one.'
    );
  }
  return hits[0];
}

async function resolveCandidate(nameOrId, { offerId } = {}) {
  if (/^\d+$/.test(String(nameOrId))) return await getCandidate(Number(nameOrId));
  const hits = await searchCandidates({ query: String(nameOrId).trim(), limit: 25 });
  let pool = hits;
  if (offerId) {
    const onOffer = hits.filter((h) => (h.offerIds || []).includes(Number(offerId)));
    if (onOffer.length) pool = onOffer;
  }
  if (!pool.length) throw new RecruiteeError(`No candidate found matching "${nameOrId}".`);
  if (pool.length > 1) {
    throw new RecruiteeError(
      `"${nameOrId}" matches ${pool.length} candidates: ` +
      pool.map((h) => `${h.name} (${h.id}${h.emails?.[0] ? `, ${h.emails[0]}` : ''})`).join('; ') +
      '. Say which id.'
    );
  }
  return await getCandidate(pool[0].id);
}

// Stage name → id, on one offer. Case-insensitive, and lists the real stage
// names when it misses, because they are per-pipeline and not guessable.
async function resolveStage(offerId, stageNameOrId) {
  const { stages } = await getStages(offerId);
  if (/^\d+$/.test(String(stageNameOrId))) {
    const byId = stages.find((s) => s.id === Number(stageNameOrId));
    if (byId) return byId;
    throw new RecruiteeError(`Stage ${stageNameOrId} is not on offer ${offerId}.`);
  }
  const wanted = String(stageNameOrId).trim().toLowerCase();
  const hit = stages.find((s) => s.name.toLowerCase() === wanted)
    || stages.find((s) => s.name.toLowerCase().includes(wanted));
  if (!hit) {
    throw new RecruiteeError(
      `No stage called "${stageNameOrId}" on offer ${offerId}. Stages: ` +
      stages.map((s) => s.name).join(', ')
    );
  }
  return hit;
}

// ── Candidate creation ─────────────────────────────────────────────────────

// INTERNAL ONLY, and not exported as a tool. Creating someone on an offer always
// drops them in "Applied" — the create endpoint takes no stage — so a person you
// sourced would be filed among the applicants and inflate that count. This puts
// them where they belong immediately after creation. It is not a general
// stage-move capability: nothing outside createCandidate may call it, so the
// server still cannot advance or reject anybody.
async function placeInStage(placementId, stageId) {
  for (const body of [{ placement: { stage_id: Number(stageId) } }, { stage_id: Number(stageId) }]) {
    try {
      await api('PATCH', `/placements/${Number(placementId)}/change_stage`, { body });
      return true;
    } catch (e) {
      if (e.status && e.status >= 500) throw e;
    }
  }
  return false;
}

// Create straight onto the offer, then land them in the right stage.
// `stage` defaults to Sourced: everything this server creates came from
// somewhere we went looking, not from an application.
async function createCandidate({
  offerId, name, email, phone, sources, coverLetter, links, tags, stage = 'Sourced',
}) {
  const target = stage ? await resolveStage(offerId, stage).catch(() => null) : null;

  const candidate = {
    name,
    ...(email ? { emails: [email] } : {}),
    ...(phone ? { phones: [phone] } : {}),
    ...(coverLetter ? { cover_letter: coverLetter } : {}),
    ...(links && links.length ? { links } : {}),
    ...(tags && tags.length ? { tags } : {}),
    ...(sources && sources.length ? { sources } : {}),
  };
  const out = await api('POST', `/offers/${Number(offerId)}/candidates`, { body: { candidate } });
  const c = out?.candidate || out;
  const placement = (c?.placements || [])[0] || null;

  let landedIn = placement?.stage_id ?? null;
  let stageWarning = null;
  if (target && placement && placement.stage_id !== target.id) {
    const moved = await placeInStage(placement.id, target.id);
    if (moved) landedIn = target.id;
    else stageWarning = `Created, but could not be moved into "${target.name}" — they are sitting in the default stage. Move them by hand in Tellent.`;
  }

  return {
    id: c?.id ?? null,
    name: c?.name ?? null,
    adminUrl: c?.adminapp_url ?? null,
    placementId: placement?.id ?? null,
    offerId: Number(offerId),
    stageId: landedIn,
    stageName: target && landedIn === target.id ? target.name : null,
    ...(stageWarning ? { stageWarning } : {}),
  };
}

// ── Attachments ────────────────────────────────────────────────────────────

// Attach a local file (a CV, or a summary document worth having on the record).
//
// UNDOCUMENTED. The reference describes a JSON body carrying a server-side
// `path`, which is a handshake it never explains. A plain multipart POST with
// the field named `attachment[file]` works and returns 201 — found by probing.
// The field name matters: bare `file` 500s, and passing candidate_id only as a
// query parameter creates an ORPHAN attachment that is never linked to anyone.
async function uploadAttachment({ candidateId, filePath, asCv = false }) {
  const fsp = require('node:fs/promises');
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new RecruiteeError(`No file at ${filePath}.`);

  const token = readToken();
  if (!token) throw new RecruiteeError('No Recruitee API token.');
  const filename = path.basename(filePath);
  const bytes = await fsp.readFile(filePath);

  const form = new FormData();
  form.append('attachment[file]', new Blob([bytes]), filename);
  form.append('attachment[candidate_id]', String(Number(candidateId)));

  const res = await fetch(`${API_ROOT}/c/${companyId()}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new RecruiteeError(`Attachment upload failed (${res.status}): ${text.slice(0, 200)}`);
  const att = (() => { try { return JSON.parse(text).attachment; } catch { return null; } })();
  if (!att?.id) throw new RecruiteeError('Upload returned no attachment id.');

  // Verification differs by destination, because promoting a file to the CV
  // slot REPLACES the attachment with a new one under a new id and a new
  // filename — so looking for the id we just uploaded reports a false failure.
  let setAsCv = false;
  let confirmed = false;
  let landedAs = null;

  if (asCv) {
    await api('PATCH', `/candidates/${Number(candidateId)}/set_as_cv/${att.id}`);
    setAsCv = true;
    const back = await api('GET', `/candidates/${Number(candidateId)}`).catch(() => null);
    const cand = back?.candidate || {};
    confirmed = !!cand.cv_original_url;
    landedAs = confirmed ? String(cand.cv_original_url).split('?')[0].split('/').pop() : null;
  } else {
    const list = await api('GET', `/candidates/${Number(candidateId)}/attachments`).catch(() => null);
    const hit = (list?.attachments || []).find((a) => a.id === att.id);
    confirmed = !!hit;
    landedAs = hit?.filename || null;
  }

  return {
    attachmentId: att.id,
    uploadedAs: att.filename,
    sizeBytes: stat.size,
    setAsCv,
    verified: confirmed,
    storedAs: landedAs,
    ...(confirmed ? {} : {
      warning: asCv
        ? 'The upload was accepted but the candidate still has no CV on file. Do not report it as attached.'
        : 'The upload was accepted but is not listed on the candidate. Do not report it as attached.',
    }),
  };
}

// ── Notes ──────────────────────────────────────────────────────────────────

async function addNote({ candidateId, body, visibility = 'public' }) {
  const out = await api('POST', `/candidates/${Number(candidateId)}/notes`, {
    body: { note: { body, visibility: { level: visibility } } },
  });
  const n = out?.note || out;
  return { id: n?.id ?? null, body: n?.body ?? null, createdAt: n?.created_at ?? null };
}

async function getNotes(candidateId, { limit = 25 } = {}) {
  const out = await api('GET', `/candidates/${Number(candidateId)}/notes`, { query: { limit } });
  return (out?.notes || []).map((n) => ({
    id: n.id,
    body: n.body,
    admin: n.admin?.name || null,
    createdAt: n.created_at,
  }));
}

// Cheap identity probe: proves the token works and says who it is acting as.
async function whoami() {
  const out = await api('GET', '/admins', { query: { limit: 1 } });
  return {
    companyId: companyId(),
    admins: (out?.admins || []).length,
    ok: true,
  };
}

module.exports = {
  RecruiteeError,
  companyId, readToken, writeToken, readConfig, TOKEN_PATH,
  listOffers, getStages, offerCandidates, getCandidate, searchCandidates,
  getRatingScale, getEvaluations, submitEvaluation,
  createCandidate, addNote, getNotes, whoami, toRecruiteeNote,
  resolveOffer, resolveCandidate, resolveStage, uploadAttachment,
};

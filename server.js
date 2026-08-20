#!/usr/bin/env node
'use strict';
// Recruitee / Tellent MCP — local stdio server.
//
// AUTH is a personal API token, so there is no browser and no session to keep
// warm — just a fetch wrapper. The token acts as the person who generated it,
// which is why every install is one recruiter's own token. See client.js.
//
// WHAT IT DELIBERATELY CANNOT DO: disqualify, requalify, delete or anonymise.
// Those endpoints exist and this token has the permissions for all of them —
// which is the reason they are not implemented. Rejecting a candidate is a
// decision a person makes in the UI.
//
// Stage moves ARE implemented (rt_set_stage), because advancing somebody is
// bookkeeping rather than a judgement, and a pipeline that cannot be advanced
// from here drifts out of step with wherever else it is tracked. The line is
// drawn at disqualification, and rt_set_stage refuses a disqualified placement
// so a move can never requalify anyone by side effect.
//
// Modes:
//   node server.js --set-token <token> <company>   store the credentials (0600)
//   node server.js --check               prove the token and print the company
//   node server.js                       stdio MCP server
//
// stdout is the JSON-RPC channel. All logging goes to stderr.

const client = require('./client');

function log(...a) {
  process.stderr.write(`[recruitee-mcp] ${a.join(' ')}\n`);
}

async function runSetToken(token, company) {
  if (!token) {
    process.stderr.write('Usage: node server.js --set-token <token> <company>\n');
    process.exit(1);
  }
  // The company is required the first time and optional after, so rotating a
  // token is one argument rather than a chance to mistype the tenant.
  const known = client.readConfig().companyId;
  if (!company && !known) {
    process.stderr.write(
      'Usage: node server.js --set-token <token> <company>\n\n' +
      'The company is on the same screen as the token — Settings > Apps and plugins > API tokens,\n' +
      'in the "Current company details" panel. Either the numeric ID or the subdomain works.\n'
    );
    process.exit(1);
  }
  const where = client.writeToken(token.trim(), (company || '').trim());
  const now = client.readConfig();
  process.stdout.write(`Saved to ${where} (0600) — company ${now.companyId}.\nNow run: npm run check\n`);
}

async function runCheck() {
  if (!client.readToken()) {
    process.stdout.write(JSON.stringify({
      authenticated: false,
      fix: 'Generate a personal API token in Recruitee: Settings → Apps and plugins → API tokens → Personal API tokens → Add token. Copy your company ID from the "Current company details" panel on that same screen, then run `npm run set-token -- <token> <company>` inside the recruitee-mcp folder.',
    }, null, 2) + '\n');
    return;
  }
  try {
    const who = await client.whoami();
    const offers = await client.listOffers({ limit: 5 });
    process.stdout.write(JSON.stringify({
      authenticated: true,
      companyId: who.companyId,
      offersVisible: offers.length,
      sample: offers.slice(0, 5).map((o) => `${o.id} ${o.title} (${o.status})`),
    }, null, 2) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ authenticated: false, error: e.message }, null, 2) + '\n');
    process.exitCode = 1;
  }
}

async function runServer() {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

  const server = new Server({ name: 'recruitee', version: '0.1.0' }, { capabilities: { tools: {} } });

  const TOOLS = [
    {
      name: 'rt_list_offers',
      description:
        'List the roles (offers) in Recruitee/Tellent with their ids, status and candidate counts. ' +
        'Start here — every other tool is keyed on an offer id.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filter by title, e.g. "Customer Success".' },
          limit: { type: 'number', description: 'Max offers (default 50).' },
        },
      },
    },
    {
      name: 'rt_get_stages',
      description:
        'The pipeline stages of one offer, with their ids. Needed before writing an evaluation, ' +
        'because an evaluation is filed against a stage.',
      inputSchema: {
        type: 'object',
        properties: { offerId: { type: 'number', description: 'From rt_list_offers.' } },
        required: ['offerId'],
      },
    },
    {
      name: 'rt_offer_candidates',
      description:
        'Everyone on ONE offer, with their stage, disqualification state and ratings — genuinely ' +
        'scoped to that offer rather than the whole company database.',
      inputSchema: {
        type: 'object',
        properties: {
          offerId: { type: 'number', description: 'From rt_list_offers.' },
          limit: { type: 'number', description: 'Max candidates (default 100).' },
        },
        required: ['offerId'],
      },
    },
    {
      name: 'rt_get_candidate',
      description:
        'Full record for one candidate: contact details, tags, every placement with its stage, and ' +
        'their application answers. Salary answers live in groupedOpenQuestionAnswers and are ' +
        'PER OFFER — read the offer id on each, because someone who applied to several roles ' +
        'carries several answers and the flat list cannot tell them apart.',
      inputSchema: {
        type: 'object',
        properties: { candidateId: { type: 'number' } },
        required: ['candidateId'],
      },
    },
    {
      name: 'rt_search_candidates',
      description: 'Find candidates by name or keyword across the company.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'Default 25.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'rt_source_candidates',
      description:
        'SEARCH THE WHOLE CANDIDATE DATABASE — every person who ever applied or was added, ' +
        'not just one role. This is the sourcing tool: use it to find people already in the ATS ' +
        'before going out to LinkedIn, because someone who applied to a similar role last year is ' +
        'the cheapest good candidate there is.\n\n' +
        'IT SEARCHES CV TEXT, not just names and titles. `query` takes boolean operators exactly ' +
        'as the Recruitee search bar does: "renewals AND churn", "(SaaS OR B2B) AND expansion". ' +
        'Every result carries whyMatched — the actual sentences that matched — so a coincidental ' +
        'hit can be dismissed without opening the profile.\n\n' +
        'SEARCH FOR THE EVIDENCE, NOT THE JOB TITLE. Titles are inconsistent between companies; ' +
        'what someone DID is written in their CV. Prefer "quota AND renewals" over "Account ' +
        'Manager", and run several narrow searches rather than one broad one.\n\n' +
        'MOST OF THIS DATABASE WAS REJECTED ONCE. Every result lists each role the person sits ' +
        'on with its stage and, where they were turned down, the reason. Read it before you ' +
        'suggest anybody: "wrong location" two years ago may not apply now, "failed the ' +
        'assessment" still does. Never present someone as a fresh find without saying they have ' +
        'been through the process before, and for which role.\n\n' +
        'excludeOffer keeps people already on a role out of the results, which is what you want ' +
        'when topping one up. Combine filters freely — they AND together.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Full-text, boolean, across CV and profile. e.g. "renewals AND churn".' },
          offer: { type: 'string', description: 'Limit to people on this role (title or id).' },
          excludeOffer: { type: 'string', description: 'Exclude people already on this role (title or id).' },
          jobStatus: { type: 'string', description: 'published | archived — the status of the role they are on.' },
          stage: { type: 'string', description: 'Pipeline stage name, e.g. "Applied". A stage this company does not have returns nothing and lists the real ones.' },
          status: { type: 'string', description: 'qualified | disqualified | new | viewed | overdue.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag names. An unknown tag throws and lists the real ones.' },
          sources: { type: 'array', items: { type: 'string' }, description: 'Source names, e.g. "linkedin.com".' },
          limit: { type: 'number', description: 'Max 100, default 25.' },
          page: { type: 'number', description: 'For paging past the first set.' },
          sortBy: { type: 'string', description: 'relevance_desc (default) | created_at_desc | created_at_asc | last_activity_at_desc.' },
        },
      },
    },
    {
      name: 'rt_get_rating_scale',
      description:
        'The rating scale this company is configured for. Read it BEFORE writing an evaluation: ' +
        'the valid rating values differ per tenant (a 4-point thumbs scale has no "neutral", a ' +
        '5-point one does), and guessing files the wrong verdict on a real person.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'rt_get_evaluations',
      description:
        'Every evaluation on a candidate: rating, note, stage, reviewer and date, flattened into ' +
        'one list, newest last.\n\n' +
        'READ THIS BEFORE WRITING ONE, so you build on what other interviewers recorded instead of ' +
        'duplicating it.\n\n' +
        'IF YOU ARE COPYING THESE SOMEWHERE ELSE, carry the evaluation id across so a second sync ' +
        'updates the same row instead of duplicating it.\n\n' +
        'ATTRIBUTION IS UNRELIABLE COMING BACK. Recruitee files everything written through an API ' +
        'token under the token owner, so `reviewer` may be the token holder rather than whoever ran ' +
        'the interview. The note usually names the real one. Do not present the reviewer as fact ' +
        'when the note disagrees with it.',
      inputSchema: {
        type: 'object',
        properties: {
          candidateId: { type: 'number' },
          offerId: { type: 'number', description: 'Scope to one role. Recommended.' },
        },
        required: ['candidateId'],
      },
    },
    {
      name: 'rt_get_notes',
      description: 'Notes already on a candidate, newest first.',
      inputSchema: {
        type: 'object',
        properties: { candidateId: { type: 'number' }, limit: { type: 'number' } },
        required: ['candidateId'],
      },
    },
    {
      name: 'rt_create_candidate',
      description:
        'Create a candidate in Recruitee/Tellent AND place them on a role, in one call. ' +
        'Works entirely from what you are told here — nothing has to exist anywhere else first.\n\n' +
        'WHAT YOU NEED. Required: the role (its title is enough, e.g. "VP of Customer Success") and ' +
        'the person\'s full name. Strongly recommended, because a record without them is close to ' +
        'useless to a recruiter: email, and either a LinkedIn URL or a CV file. Optional: phone, ' +
        'tags, a coverLetter block for their background and why they are worth a look, and where ' +
        'they came from. If the user has not given you the recommended fields, ASK for them before ' +
        'creating — the preview call lists exactly what is missing.\n\n' +
        'TWO-CALL GATE, ALWAYS. The first call (confirm omitted or false) returns what would be ' +
        'created, what is missing, and any existing candidates with the same name — and writes ' +
        'nothing. Show that to the user. Only call again with confirm true once they have approved ' +
        'THIS person for THIS role. One person per confirmation.\n\n' +
        'THIS CREATES A REAL RECORD FOR A REAL PERSON, visible to the whole hiring team and counted ' +
        'in reporting. The preview always runs a duplicate check; if it finds a match, resolve that ' +
        'with the user rather than creating a second record that splits their history.\n\n' +
        'DO NOT INVENT DETAILS. An empty field beats a guessed one.\n\n' +
        'STAGE. Defaults to "Sourced", which is right for anyone we went looking for. Pass ' +
        'stage: "Applied" only for someone who genuinely applied. Recruitee\'s create endpoint has ' +
        'no stage parameter, so this moves them immediately after creation and tells you if that ' +
        'did not take.',
      inputSchema: {
        type: 'object',
        properties: {
          offer: { type: 'string', description: 'Role title or offer id, e.g. "VP of Customer Success" or 2683651.' },
          name: { type: 'string', description: 'Full name.' },
          email: { type: 'string', description: 'Strongly recommended — without it nobody can contact them from the ATS.' },
          phone: { type: 'string' },
          links: { type: 'array', items: { type: 'string' }, description: 'Profile URLs, e.g. their LinkedIn.' },
          tags: { type: 'array', items: { type: 'string' } },
          coverLetter: { type: 'string', description: 'Free text: their background, and why they are worth looking at.' },
          sources: { type: 'array', items: { type: 'string' }, description: 'Where they came from, e.g. ["LinkedIn"].' },
          stage: { type: 'string', description: 'Stage name. Default "Sourced".' },
          attachFile: { type: 'string', description: 'Absolute path to a local file to attach — a CV, or a summary document.' },
          asCv: { type: 'boolean', description: 'Treat the attached file as their CV rather than a plain attachment. Default true when attachFile is a CV.' },
          confirm: { type: 'boolean', description: 'False/absent = preview only.' },
        },
        required: ['offer', 'name'],
      },
    },
    {
      name: 'rt_submit_evaluation',
      description:
        'Write an evaluation (a thumbs rating plus a note) onto a candidate for one role — the ' +
        '"Evaluation" tab of their profile.\n\n' +
        'WORKS BY NAME. Give the person\'s name and the role title and the text; ids are not needed. ' +
        'If a name matches more than one candidate it refuses and ' +
        'lists them rather than guessing — filing a verdict on the wrong person is the failure that ' +
        'matters here.\n\n' +
        'THE STAGE IS AUTOMATIC. It files against wherever the candidate actually sits on that role, ' +
        'which is what an evaluation means. Only pass stage to override that deliberately.\n\n' +
        'TWO-CALL GATE, ALWAYS. First call previews, second call with confirm true writes.\n\n' +
        'IT IS FILED IN THE TOKEN OWNER\'S NAME. Confirmed in practice: it appears in Tellent as ' +
        '"You evaluated", indistinguishable from one clicked by hand. So never write one as though ' +
        'it were another interviewer\'s verdict, and never write one for a conversation the token ' +
        'owner did not have or has not read. If the judgement came from someone else, say so in the ' +
        'note.\n\n' +
        'CALL rt_get_rating_scale IF UNSURE. Valid ratings depend on the configured scale. This ' +
        'company is on a 4-point thumbs scale: strong_no, no, yes, strong_yes ("yes" scores 4/5, ' +
        '75%). A value the scale does not have is rejected rather than rounded.\n\n' +
        'PUT THE REASONING IN ratingNote. A bare rating nobody can audit is not worth writing. ' +
        'Where the verdict came from a screen or interview, say which.\n\n' +
        'Structured questionnaire scorecards (per-question answers) are NOT supported — only the ' +
        'rating card. If a role uses a questionnaire template, say so rather than flattening a ' +
        'multi-question scorecard into a single rating.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate: { type: 'string', description: 'Full name, or a candidate id.' },
          offer: { type: 'string', description: 'Role title, or an offer id.' },
          rating: { type: 'string', description: 'strong_no | no | yes | strong_yes.' },
          ratingNote: { type: 'string', description: 'The reasoning, in the words that should stand on the record.' },
          stage: { type: 'string', description: 'Optional override. Defaults to where they actually are.' },
          confirm: { type: 'boolean', description: 'False/absent = preview only.' },
        },
        required: ['candidate', 'offer', 'rating'],
      },
    },
    {
      name: 'rt_set_stage',
      description:
        'Move an existing candidate into another pipeline stage on ONE of their roles — to advance ' +
        'them, or to mirror a move already made wherever your pipeline is tracked. Scoped to an offer ' +
        'because a candidate can sit on several pipelines at once.\n\n' +
        'Call rt_get_stages first if you do not know the offer\'s stage names; an unknown name is ' +
        'refused and the real ones are listed back. If you are mirroring a move from another system, ' +
        'do not assume the two name stages the same way — ask which stage is meant rather than ' +
        'picking the nearest word.\n\n' +
        'THIS IS NOT A REJECTION TOOL. It cannot disqualify anyone, and it refuses to move a ' +
        'candidate who has already been disqualified, because that would requalify them. Only move ' +
        'somebody because a person moved them or told you to — never because a meeting was booked, ' +
        'a score looked good, or the pipeline seemed stale.\n\n' +
        'Two-call gate: preview, then confirm. The move is verified by re-reading the candidate ' +
        'afterwards; if it did not land, that is reported rather than claimed as done.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate: { type: 'string', description: 'Full name, or a candidate id.' },
          offer: { type: 'string', description: 'Role title or offer id — which pipeline to move them along.' },
          stage: { type: 'string', description: 'Target stage name (or id) on that offer, e.g. "P&C Interview".' },
          confirm: { type: 'boolean' },
        },
        required: ['candidate', 'offer', 'stage'],
      },
    },
    {
      name: 'rt_attach_file',
      description:
        'Attach a local file to an existing candidate — a CV, or a summary document. ' +
        'Set asCv to make it their CV rather than a plain ' +
        'attachment; a record with no CV shows "No CV or resume yet" in Tellent.\n\n' +
        'Setting a file as the CV REPLACES any CV already on file, demoting theirs to a plain ' +
        'attachment — so that is refused unless you pass replaceCv.\n\n' +
        'Only ever attach a file the user named. Never go looking for one, and never substitute a ' +
        'different file if the named one is missing. Two-call gate: preview, then confirm.\n\n' +
        'The upload is verified against the candidate afterwards; if it comes back unlinked, say so ' +
        'rather than reporting it as attached.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate: { type: 'string', description: 'Full name, or a candidate id.' },
          filePath: { type: 'string', description: 'Absolute path to the local file.' },
          asCv: { type: 'boolean', description: 'Make it the candidate\'s CV. Default false.' },
          replaceCv: { type: 'boolean', description: 'Allow replacing a CV already on file. Default false — setting a CV REPLACES the existing one and demotes it to a plain attachment, so that needs saying out loud.' },
          confirm: { type: 'boolean' },
        },
        required: ['candidate', 'filePath'],
      },
    },
    {
      name: 'rt_add_note',
      description:
        'Add a note to a candidate. Use for context that is not a verdict — an assessment summary, ' +
        'sourcing rationale, or a call recap. Accepts a name or an id. Two-call gate.\n\n' +
        'Visibility "public" means anyone with access to the candidate can read it, which is usually ' +
        'what you want for a shared hiring record.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate: { type: 'string', description: 'Full name, or a candidate id.' },
          body: { type: 'string' },
          visibility: { type: 'string', enum: ['public', 'private'], description: 'Default public.' },
          confirm: { type: 'boolean' },
        },
        required: ['candidate', 'body'],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const fail = (message) => ({
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  });

  // Every write goes through the same shape: describe it, stop, and only act on
  // a second call. One implementation so no tool can quietly skip the gate.
  const staged = (what, preview) => ok({
    status: 'staged',
    wouldWrite: what,
    preview,
    note:
      `NOTHING HAS BEEN WRITTEN. Show this to the user in full. Call again with confirm: true ` +
      `only after they have approved this exact ${what}.`,
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      if (name === 'rt_list_offers') {
        return ok({ offers: await client.listOffers({ query: args.query, limit: args.limit }) });
      }

      if (name === 'rt_get_stages') {
        if (!args.offerId) return fail('offerId is required.');
        return ok(await client.getStages(args.offerId));
      }

      if (name === 'rt_offer_candidates') {
        if (!args.offerId) return fail('offerId is required.');
        const candidates = await client.offerCandidates(args.offerId, { limit: args.limit });
        return ok({ offerId: args.offerId, count: candidates.length, candidates });
      }

      if (name === 'rt_get_candidate') {
        if (!args.candidateId) return fail('candidateId is required.');
        return ok(await client.getCandidate(args.candidateId));
      }

      if (name === 'rt_search_candidates') {
        if (!args.query) return fail('query is required.');
        const results = await client.searchCandidates({ query: args.query, limit: args.limit });
        return ok({ query: args.query, count: results.length, results });
      }

      if (name === 'rt_source_candidates') {
        return ok(await client.sourceCandidates({
          query: args.query, offer: args.offer, excludeOffer: args.excludeOffer,
          jobStatus: args.jobStatus, stage: args.stage, status: args.status,
          tags: args.tags, sources: args.sources,
          limit: args.limit, page: args.page, sortBy: args.sortBy,
        }));
      }

      if (name === 'rt_get_rating_scale') {
        return ok(await client.getRatingScale());
      }

      if (name === 'rt_get_evaluations') {
        if (!args.candidateId) return fail('candidateId is required.');
        return ok(await client.getEvaluations(args.candidateId, { offerId: args.offerId }));
      }

      if (name === 'rt_get_notes') {
        if (!args.candidateId) return fail('candidateId is required.');
        const notes = await client.getNotes(args.candidateId, { limit: args.limit });
        return ok({ candidateId: args.candidateId, count: notes.length, notes });
      }

      if (name === 'rt_create_candidate') {
        if (!String(args.offer || '').trim() || !String(args.name || '').trim()) {
          return fail('offer and name are required.');
        }
        const off = await client.resolveOffer(args.offer);
        const stage = args.stage || 'Sourced';

        // Say what is thin BEFORE anything is written, so the user is asked once
        // rather than left with a record nobody can act on.
        const missing = [];
        if (!args.email) missing.push('email — nobody can contact them from the ATS without it');
        if (!(args.links || []).length && !args.attachFile) missing.push('a LinkedIn URL or a CV file — otherwise there is nothing to read');
        if (!args.coverLetter) missing.push('coverLetter — their background and why they are worth a look');

        if (args.confirm !== true) {
          const existing = await client.searchCandidates({ query: args.name, limit: 5 }).catch(() => []);
          return staged('candidate', {
            offer: `${off.title || off.id} (${off.id})`,
            stage,
            name: args.name,
            email: args.email || null,
            phone: args.phone || null,
            links: args.links || [],
            tags: args.tags || [],
            sources: args.sources || [],
            coverLetter: args.coverLetter || null,
            attachFile: args.attachFile || null,
            missing: missing.length ? missing : null,
            askUserFor: missing.length
              ? 'Ask the user for the items in `missing` before confirming. If they do not have them, say so explicitly and create the record anyway on their say-so.'
              : null,
            possibleDuplicates: existing,
            duplicateWarning: existing.length
              ? `${existing.length} existing candidate(s) already match this name. Resolve that before creating a second record.`
              : 'No existing candidate matches this name.',
          });
        }

        const created = await client.createCandidate({
          offerId: off.id,
          name: args.name,
          email: args.email,
          phone: args.phone,
          links: args.links,
          tags: args.tags,
          sources: args.sources,
          coverLetter: args.coverLetter,
          stage,
        });

        let attachment = null;
        if (args.attachFile) {
          try {
            attachment = await client.uploadAttachment({
              candidateId: created.id, filePath: args.attachFile, asCv: args.asCv !== false,
            });
          } catch (e) {
            attachment = { error: e.message, note: 'The candidate WAS created; only the file failed.' };
          }
        }

        return ok({
          status: 'created',
          candidate: created,
          attachment,
          note:
            `${created.name} created on ${off.title || off.id}` +
            (created.stageName ? ` in "${created.stageName}"` : '') +
            `. ${created.adminUrl || ''}` +
            (created.stageWarning ? `\n\nWARNING: ${created.stageWarning}` : ''),
        });
      }

      if (name === 'rt_submit_evaluation') {
        for (const f of ['candidate', 'offer', 'rating']) {
          if (!String(args[f] ?? '').trim()) return fail(`${f} is required.`);
        }
        if (args.confirm !== true) {
          // Resolve during the preview so the user approves a named person on a
          // named role, not a string that might match two people.
          const off = await client.resolveOffer(args.offer);
          const cand = await client.resolveCandidate(args.candidate, { offerId: off.id });
          const placement = (cand.placements || []).find((p) => p.offerId === off.id);
          const stageName = args.stage
            ? (await client.resolveStage(off.id, args.stage)).name
            : (placement ? (await client.getStages(off.id)).stages.find((x) => x.id === placement.stageId)?.name : null);
          return staged('evaluation', {
            candidate: `${cand.name} (${cand.id})`,
            offer: `${off.title || off.id} (${off.id})`,
            stage: stageName || null,
            onThisRole: !!placement,
            rating: args.rating,
            ratingNote: args.ratingNote || null,
            attribution: 'Files in the API token owner\'s name, exactly as if clicked in Tellent.',
            ...(placement ? {} : { blocker: `${cand.name} holds no placement on this role, so there is nothing to evaluate against.` }),
          });
        }
        const result = await client.submitEvaluation({
          candidate: args.candidate, offer: args.offer, stage: args.stage,
          rating: args.rating, ratingNote: args.ratingNote,
        });
        return ok({ status: result.verified ? 'written' : 'written_unverified', evaluation: result });
      }

      if (name === 'rt_set_stage') {
        if (!String(args.candidate || '').trim() || !String(args.offer || '').trim() || !String(args.stage || '').trim()) {
          return fail('candidate, offer and stage are all required.');
        }
        if (args.confirm !== true) {
          const cand = await client.resolveCandidate(args.candidate);
          const off = await client.resolveOffer(args.offer);
          const full = await client.getCandidate(cand.id);
          const placement = (full.placements || []).find((p) => p.offerId === off.id);
          const { stages } = await client.getStages(off.id);
          const from = placement ? stages.find((x) => x.id === placement.stageId)?.name ?? null : null;
          // Resolved in the preview so a bad stage name is caught before the
          // user is asked to approve a move that would only fail on confirm.
          let target = null, stageError = null;
          try { target = (await client.resolveStage(off.id, args.stage)).name; }
          catch (e) { stageError = e.message; }
          return staged('stage move', {
            candidate: `${full.name} (${full.id})`,
            offer: `${off.title} (${off.id})`,
            from,
            to: target,
            stages: stages.map((x) => x.name),
            ...(stageError ? { blocker: stageError } : {}),
            ...(placement ? {} : { blocker: `${full.name} holds no placement on "${off.title}", so there is no pipeline to move them along.` }),
            ...(placement?.disqualifiedAt ? { blocker: `${full.name} was disqualified on this role${placement.disqualifyReason ? ` (${placement.disqualifyReason})` : ''}. Moving them would requalify them — do that in Tellent, deliberately.` } : {}),
            ...(target && from === target ? { note: `Already in "${target}" — confirming would change nothing.` } : {}),
          });
        }
        const res = await client.moveStage({ candidate: args.candidate, offer: args.offer, stage: args.stage });
        return ok({ status: res.unchanged ? 'unchanged' : (res.verified ? 'moved' : 'move_unverified'), ...res });
      }

      if (name === 'rt_attach_file') {
        if (!String(args.candidate || '').trim() || !String(args.filePath || '').trim()) {
          return fail('candidate and filePath are required.');
        }
        const cand = await client.resolveCandidate(args.candidate);
        if (args.confirm !== true) {
          const fs = require('node:fs');
          const exists = fs.existsSync(args.filePath);
          // Re-read in full: resolveCandidate returns a search hit for a NAME,
          // which carries no cv field, so the CV warning would silently vanish
          // on exactly the lookups people actually use.
          const full = await client.getCandidate(cand.id);
          return staged('attachment', {
            candidate: `${full.name} (${full.id})`,
            filePath: args.filePath,
            fileExists: exists,
            sizeBytes: exists ? fs.statSync(args.filePath).size : null,
            asCv: args.asCv === true,
            ...(args.asCv === true && full.cvFilename && args.replaceCv !== true
              ? { blocker: `${full.name} already has a CV on file (${full.cvFilename}). Setting this as their CV would replace it. Use asCv false to attach alongside, or replaceCv true only if the user says so.` }
              : {}),
            ...(args.asCv === true && full.cvFilename && args.replaceCv === true
              ? { warning: `This REPLACES their existing CV (${full.cvFilename}), which becomes a plain attachment.` }
              : {}),
            ...(exists ? {} : { blocker: 'That file does not exist. Do not substitute another one.' }),
          });
        }
        const res = await client.uploadAttachment({
          candidateId: cand.id, filePath: args.filePath, asCv: args.asCv === true, replaceCv: args.replaceCv === true,
        });
        return ok({ status: res.verified ? 'attached' : 'upload_unverified', candidate: cand.name, attachment: res });
      }

      if (name === 'rt_attach_file') {
        if (!String(args.candidate || '').trim() || !String(args.filePath || '').trim()) {
          return fail('candidate and filePath are required.');
        }
        const cand = await client.resolveCandidate(args.candidate);
        if (args.confirm !== true) {
          const fs = require('node:fs');
          const exists = fs.existsSync(args.filePath);
          return staged('attachment', {
            candidate: `${cand.name} (${cand.id})`,
            filePath: args.filePath,
            fileExists: exists,
            sizeBytes: exists ? fs.statSync(args.filePath).size : null,
            asCv: args.asCv === true,
            ...(exists ? {} : { blocker: 'That file does not exist. Do not substitute another one.' }),
          });
        }
        const res = await client.uploadAttachment({
          candidateId: cand.id, filePath: args.filePath, asCv: args.asCv === true,
        });
        return ok({ status: res.verified ? 'attached' : 'upload_unverified', candidate: cand.name, attachment: res });
      }

      if (name === 'rt_add_note') {
        if (!String(args.candidate || '').trim() || !String(args.body || '').trim()) {
          return fail('candidate and body are required.');
        }
        const cand = await client.resolveCandidate(args.candidate);
        if (args.confirm !== true) {
          return staged('note', {
            candidate: `${cand.name} (${cand.id})`,
            visibility: args.visibility || 'public',
            body: args.body,
          });
        }
        const note = await client.addNote({
          candidateId: cand.id, body: args.body, visibility: args.visibility || 'public',
        });
        return ok({ status: 'written', candidate: cand.name, note });
      }

      return fail(`Unknown tool: ${name}`);
    } catch (e) {
      return fail(e.message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('ready (stdio)');
}

const mode = process.argv[2];
if (mode === '--set-token') runSetToken(process.argv[3], process.argv[4]).catch((e) => { log(e.message); process.exit(1); });
else if (mode === '--check') runCheck().catch((e) => { log('check failed:', e.message); process.exit(1); });
else runServer().catch((e) => { log('fatal:', e.stack || e.message); process.exit(1); });

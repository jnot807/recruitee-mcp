# Recruitee MCP

Work your Recruitee / Tellent pipeline from inside Claude. Look up a role,
read a candidate and everything already recorded about them, add someone you
sourced, and write your interview evaluation — without leaving the
conversation.

It runs on your own machine under your own Recruitee API token, so everything
it writes is filed in your name, exactly as if you had clicked it yourself.

---

## What it can do

Fourteen tools. Nine read, five write, and every write shows you exactly what it
is about to do before it does it.

### Reading

| Tool | What you get |
| --- | --- |
| `rt_list_offers` | Your roles with their ids, status and candidate counts. Optionally filtered by title. |
| `rt_get_stages` | One role's pipeline stages, with a live count in each. |
| `rt_offer_candidates` | Everyone on one role — their stage, whether they were disqualified, and any ratings. Genuinely scoped to that role, not the whole company. |
| `rt_get_candidate` | A full record: contact details, tags, every role they sit on, and their application answers. |
| `rt_search_candidates` | Find one person by name. |
| `rt_source_candidates` | Search your whole database, CV text included — see below. |
| `rt_get_rating_scale` | The rating scale your account is configured for, so a verdict is never guessed at. |
| `rt_get_evaluations` | Every evaluation on a candidate — rating, note, stage, reviewer and date — flattened into one list. |
| `rt_get_notes` | Notes already on a candidate, newest first. |

Application answers are worth a word: salary expectations and the like are
returned **per role**, because someone who applied to three jobs answered the
question three times, and a flat list cannot tell those answers apart.

### Writing

| Tool | What it does |
| --- | --- |
| `rt_create_candidate` | Creates a person and places them on a role in one step. Takes email, phone, links, tags, a cover-letter block, where they came from, and a file to attach. Lands them in **Sourced** by default. |
| `rt_submit_evaluation` | Writes the thumbs rating and your reasoning onto a candidate for one role — the Evaluation tab of their profile. |
| `rt_set_stage` | Moves a candidate to another stage on one of their offers. Refuses a disqualified placement, so it cannot requalify anybody. |
| `rt_attach_file` | Attaches a local file to an existing candidate, optionally making it their CV. |
| `rt_add_note` | Adds a note, public or private. For context that is not a verdict — a call recap, sourcing rationale, a summary. |

### How the writes behave

**They take names, not ids.** "Dana Whitfield", "Regional Sales Manager". If a
name matches two people it stops and lists them rather than picking one —
filing a verdict on the wrong person is the failure that actually matters here.

**Every one previews first.** The first call returns exactly what would be
written and writes nothing. Only after you approve does anything land. For a
new candidate the preview also runs a duplicate check and tells you which
details are missing, so you find out before the record exists rather than after.

**Evaluations file against the candidate's real current stage**, which is what
an evaluation means. You can override it deliberately, but you never have to
work it out.

**Your paragraphs survive.** Recruitee's note field takes plain text but its
interface renders that text as HTML, so a note written in paragraphs would
otherwise arrive as one run-on block. The line breaks are converted on the way
across, and the text is escaped first so a stray `<` in your writing cannot be
swallowed or rendered.

**Ratings are checked, not rounded.** Valid values depend on your configured
scale — a 4-point thumbs scale has no "neutral", a 5-point one does. A value
the scale does not have is rejected rather than quietly turned into a
neighbour.

---

## Sourcing from your own database

`rt_source_candidates` runs the same search the Candidates screen runs, which is a
different thing from `rt_search_candidates`: that one matches names, this one
matches **everything, CV text included**, with boolean operators.

```
query: "renewals AND churn"
query: "(SaaS OR B2B) AND \"net revenue retention\" NOT \"vice president\""
```

That matters because job titles are inconsistent between companies, and what
somebody actually did is written in their CV. Searching for the evidence beats
searching for the title.

Filters combine: `offer`, `excludeOffer`, `jobStatus`, `stage`, `status`, `tags`,
`sources`. `excludeOffer` is the one that makes it a sourcing tool rather than a
search box — it keeps the people already on a role out of the results when you are
topping it up.

Every result carries **why it matched** — the actual sentences, with the HTML
stripped — and **every role the person is already on**, with the stage and, where
they were turned down, the reason. That last part is not decoration: most of an
established ATS was rejected once. "Wrong location" two years ago may not apply
today; "failed the assessment" still does. Nobody should be presented as a fresh
find without it.

### Why the filter building looks paranoid

`/search/new/candidates` silently ignores anything it does not recognise and
returns an unfiltered result rather than an error. Four ways to get a plausible,
badly wrong answer, all confirmed against a live account:

| Mistake | What the API does |
| --- | --- |
| Unknown entity name | returns the entire database |
| `nin` instead of `not_in` | returns the entire database |
| Unknown sort | silently falls back to relevance |
| Two filter objects for the same entity | the second **replaces** the first |

That last one is the nastiest: a role plus a job status sent as two objects returns
everyone with that job status, and nothing anywhere says the role filter was
dropped. So every constraint on an entity is merged into a single object, and no
caller-supplied key ever reaches the API — names are mapped onto a vocabulary
verified against the live API, and anything outside it throws.

A wrong *value* is safe by contrast: it returns zero, which is obviously wrong to
whoever reads it. A zero result also comes back with your real stage names
attached, so a mistyped stage is distinguishable from an empty one.

`node sourcing-test.js` checks all of it, including that the client refuses each of
the four mistakes above.

## Setup

Five minutes, once. You need **Node 18 or newer** (`node -v` to check) and
**Claude Code** or the **Claude desktop app**.

### 1. Get the code and install

```bash
git clone https://github.com/jnot807/recruitee-mcp.git
cd recruitee-mcp
npm install
```

Every command from here runs from inside that folder.

### 2. Create your own API token

In Recruitee: **Settings → Apps and plugins → API tokens**, stay on the
**Personal API tokens** tab, and click **+ Add token**. It asks for your
password, then shows the value once.

While you are on that screen, note your company from the **Current company
details** panel at the top. Either the numeric **ID** or the **subdomain**
works.

This has to be *your* token, not a shared one. A Recruitee token acts as the
person who created it, so an evaluation written with your token shows up as
yours — which is the point. Never paste it into a chat, an email or a ticket.

### 3. Store it

```bash
npm run set-token -- <paste-your-token-here> <your-company>
```

Rotating a token later is just `npm run set-token -- <new-token>` — the company
is remembered.

It is written to `session/token.json`, readable only by you, and gitignored.
`RECRUITEE_API_TOKEN` in the environment overrides the file if you would rather
keep it in a password manager.

### 4. Prove it works

```bash
npm run check
```

You want `authenticated: true` and a few of your roles.

### 5. Connect it to Claude

Run this from inside this folder, then restart Claude:

```bash
claude mcp add recruitee -- node "$PWD/server.js"
```

Using the Claude desktop app instead? Open **Settings → Developer → Edit
Config** and add this, with your real absolute path (`pwd` prints it):

```json
{
  "mcpServers": {
    "recruitee": {
      "command": "node",
      "args": ["/absolute/path/to/recruitee-mcp/server.js"]
    }
  }
}
```

Then ask Claude: *"list the open roles in Recruitee"*.

---

## What it looks like in use

> **You:** Who's in the pipeline for Regional Sales Manager?
>
> **You:** Pull up Dana Whitfield — what did she put for salary, and what
> evaluations are already on her?
>
> **You:** Write an evaluation for her on that role. A yes: strong on renewals
> and expansion, ran a team of nine, no PLG experience.
>
> **Claude** shows you the rating, the note, the role and the stage, and writes
> nothing.
>
> **You:** Yes, send it.

---

## What it deliberately cannot do

A Recruitee API token carries **exactly** the permissions of the person who
generated it — the documentation is explicit that it can "perform the same
actions as in the web or mobile application in the name of that user". There is
no read-only token to issue.

So the restraint lives in this code instead. Disqualifying, requalifying,
deleting, concealing and anonymising are all real, documented endpoints that
this server **does not implement**. Not hidden behind a flag, not commented out
— absent, so no instruction, prompt or bug can reach them. Rejecting a candidate
stays a decision you make in the UI.

**Stage moves are the one thing that is allowed.** `rt_set_stage` advances a
candidate along one offer's pipeline, because that is bookkeeping rather than a
judgement, and a pipeline you cannot advance from here drifts out of step with
wherever else you track it. The line is drawn at disqualification and it is
enforced, not just documented: the move **refuses a placement that has already
been disqualified**, since changing its stage would requalify the person —
reversing somebody's rejection as a side effect of a bookkeeping call.

`npm run smoke` asserts these properties on every run: that no destructive tool
is exposed, that the stage mover refuses a disqualified placement and is scoped
to one offer, and that every write advertises its confirm gate. That last check
derives writes from the tool schemas rather than from a list of name patterns —
the earlier version silently stopped covering new tools, and waved `rt_set_stage`
through without testing it at all.

---

## Things worth knowing

**New candidates land in "Sourced".** Recruitee's create endpoint always drops
people in "Applied", which would file everyone you sourced among the genuine
applicants, so they are moved immediately after creation and you are told if
that did not take. Pass `stage` to override it — `"Applied"` for somebody who
genuinely applied, or any later stage for someone already in process. To move
them afterwards, use `rt_set_stage`.

**Setting a CV replaces the one already there.** Recruitee's `set_as_cv` does
not add a CV, it swaps the slot and demotes the previous file to a plain
attachment. `rt_attach_file` therefore refuses to set a CV on a candidate who
already has one unless you pass `replaceCv` — a CV on file is somebody's
decision, and the only trace of overwriting it is an extra row in the
attachments list.

**Evaluations are filed under you.** They appear as "You evaluated",
indistinguishable from one clicked by hand. Never write one for a conversation
you did not have or have not read, and if the judgement came from a colleague,
say so in the note.

**Attribution is unreliable coming back.** Anything written through *any* API
token is attributed to that token's owner, so the reviewer on an evaluation
someone synced may be whoever synced it rather than whoever ran the interview.
The note usually names the real one.

**Questionnaire scorecards are not supported.** Only the plain rating card. The
API documents the per-question answers in every response but never in a request
body, so the write shape would have to be observed from a real submission
first. It may not matter for your account either: if `/results/scorecards` comes back
empty for people who have been through interview stages, plain rating cards are
what is in use and there is nothing missing. Worth checking before anyone
invests in the questionnaire path.

---

## Where this works

This is a **local stdio MCP server** — Claude launches it as a process on your
machine, and your token never leaves it.

- Claude Code (terminal, desktop app, IDE extensions) ✅
- Claude desktop app ✅
- claude.ai in a browser ❌ — that connects only to *remote* MCP servers reachable
  over HTTPS, which would mean hosting this and storing everyone's Recruitee
  tokens on that host.

---

## Configuration

| Variable | Purpose |
| --- | --- |
| `RECRUITEE_API_TOKEN` | Use a token from the environment instead of the stored one |
| `RECRUITEE_COMPANY_ID` | Use a company from the environment instead of the stored one |

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "No Recruitee API token" | Step 3 did not run, or ran in a different folder. `cd` back here and try `npm run check`. |
| `"authenticated": false` | The token was mistyped or revoked. Generate a new one and redo step 3. |
| Claude does not see the tools | Restart Claude properly — quit, don't just close the window. Check step 5 ran from inside this folder. |
| "That name matches two candidates" | Working as intended. Open the person in Recruitee and give Claude the number from the end of the URL. |
| Anything else | `npm run smoke`, and send whatever it prints. |

## Development

```bash
npm run smoke     # self-check: tool list, no destructive tools, confirm gates, one live read
npm run sourcing  # 20 checks on the search filters, including the four silent-failure modes
npm run check     # prove the token
npm start         # run the server directly (it speaks JSON-RPC on stdin/stdout)
```

Two implementation notes, both found by probing rather than from the docs:

- **File upload is undocumented.** The reference describes a JSON body carrying
  a server-side `path` it never explains how to obtain. A plain multipart POST
  works, with the file part named `attachment[file]` — a bare `file` returns
  500, and passing the candidate id as a query parameter creates an attachment
  linked to nobody. Promoting a file to the CV slot *replaces* it with a new id
  and a generated filename, so uploads are verified against the candidate's CV
  URL rather than the id that was just uploaded.
- **`/search/new/candidates` ignores its own query parameter** and returns every
  record in the company, so name search goes through `/candidates?query=`
  instead. Pipeline stages come from `/offers/{id}/placements`, grouped by
  stage, not from `/offers/{id}/pipeline_templates`, which lists templates
  available to a role without their stages.

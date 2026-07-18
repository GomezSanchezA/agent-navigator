# Library collaborative editing: local Agent Navigator runbook

This harness exercises the current Library editor and live-delivery workflow
through Agent Navigator's CDP client. It covers the
`library-content-editor-v5` contract, paragraph-scoped Markdown editing,
typed component fields, reviewed static artifacts, independent Admin review,
the immutable artifact correction loop, dynamic activation, public projections,
Ada's delivery receipt, retry and append-only rollback.

The harness is a browser client only. It never starts, seeds, migrates, stops or
deploys the Library, Admin, Ada or Supabase stack. The operator remains
responsible for creating an isolated local stack and disposable data before
running any stateful command.

## Non-negotiable safety boundary

Never run this workflow against production or a shared database.
`navigator-e2e.mjs` rejects every Library, Admin and Ada origin unless it is
plain HTTP on the exact host `127.0.0.1`, `localhost` or `[::1]`, with no
credentials, path, query or fragment. This is a second guard, not permission to
point a local frontend at production Supabase.

Several commands intentionally mutate data:

- `contributor-stage` creates a draft and an artifact review request;
- the review commands change proposal and artifact workflow state, including
  creating a changes-requested parent that can only be superseded by a child;
- `admin-activate` creates an immutable activation and queues delivery;
- `retry-delivery` changes a failed local job;
- `rollback` publishes a new append-only activation.

Use a disposable local database snapshot, unique users and a dedicated canary
article. Do not put passwords, JWTs, cookies, anon keys or service-role keys on
the command line or in the evidence directory.

## Required local stack

The parent test run must start and record the processes for:

- Library at `http://127.0.0.1:3010`;
- Admin at `http://127.0.0.1:3002`;
- Ada at `http://127.0.0.1:3020`;
- the isolated local Supabase/Postgres services used by all three.

Use one hostname consistently. Host-scoped Supabase SSR cookies do not cross
between `localhost` and `127.0.0.1`.

Apply the current migrations before browser work. The canary must be registered
and editable, have contribution terms configured, and expose:

- at least one Markdown paragraph;
- at least one typed component field;
- at least one safe static-artifact insertion coordinate;
- a current `liveDeliveryBase` receipt;
- the live renderer, public-delivery worker and Admin review lanes.

The contributor needs the current editing role. The artifact and proposal
reviewer must be a different administrator account: Working Team access is
enough for some review actions, but final live activation is administrator-only.
Self-review is tested separately and must remain denied.

Ada must be configured to read the local Library origin. The Admin convergence
check requires Ada's verified endpoint to have exactly the supplied local Ada
origin; a production URL or an unimplemented local integration fails instead of
being silently accepted.

### Intentional unified-flow gate

The acceptance case is one proposal containing Markdown, a plain-text typed
component field and a newly reviewed artifact, followed by live activation. Do
not split this into a non-live artifact canary and a live text-only canary: that
would not prove that artifacts can be edited and delivered on live articles.

`contributor-stage` requires the pair
`liveDeliveryBase + staticArtifactsEnabled`. A full run is valid only when the
application and migration support that unified contract, the role-protected
preview uses the supplied local Library origin, and the newly approved artifact
reaches the live HTML/Markdown projections. A missing capability remains a
product blocker and must not be weakened or skipped in the harness.

## Prepare one run

Use Node `22.13.x` and unique values for every run:

```powershell
nvm use 22.13.0
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$summary = "Agent Navigator QA $stamp"
$probe = "navigator-$stamp-live-probe"
$artifactReviewNote = "Please add the reviewed correction marker and clarify the artifact fallback ($stamp)."
$evidence = "$HOME\.lovelace\qa-evidence\library-editing-$stamp"
$signedOutProfile = "$HOME\.lovelace\qa-browser\library-signed-out-$stamp"
$contributorProfile = "$HOME\.lovelace\qa-browser\library-contributor-$stamp"
$reviewerProfile = "$HOME\.lovelace\qa-browser\library-reviewer-$stamp"

$common = @(
  '--library', 'http://127.0.0.1:3010',
  '--admin', 'http://127.0.0.1:3002',
  '--ada', 'http://127.0.0.1:3020',
  '--slug', 'lovelaces-square/what-is-lovelace',
  '--summary', $summary,
  '--probe', $probe,
  '--artifact-review-note', $artifactReviewNote,
  '--live-reason', "Isolated Agent Navigator QA $stamp",
  '--evidence', $evidence
)
```

The summary identifies one exact proposal across commands. The probe is inserted
into edited content and is later required in public HTML, Markdown, search and
LLM projections. Do not change either value halfway through a run.

Run the offline contract and origin checks before opening a browser:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs self-test @common
```

This command does not connect to a browser or application. It also exercises
the correction-lineage contract with synthetic receipts, including rejection
of changed parent IDs, reused version IDs, lock drift, coordinate drift, source
hash drift and unexpected request fields. Both `changes_requested` and
`rejected` are recognized as correctable parent states.

## Private Brave profiles

Never use `agent-navigator/automation-profile`. Launch a fresh signed-out
profile on port `9333`:

```powershell
& .\qa\library-collaborative-editing\start-private-brave.ps1 `
  -Port 9333 -ProfileDirectory $signedOutProfile -EvidenceDirectory $evidence

node .\qa\library-collaborative-editing\navigator-e2e.mjs preflight `
  --port 9333 @common
```

`preflight` validates Agent Navigator's CDP primitives and the current v5
receipt contract. It does not mutate application data.

Close only that disposable browser when changing profiles:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs close-browser `
  --port 9333 @common
```

Keep the contributor on `9333` and the independent reviewer on `9334` for
the stateful flow. A profile is reusable only within its one disposable run so
its local cookies survive application restarts.

## 1. Signed-out boundary

With the fresh signed-out profile:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs signed-out `
  --port 9333 @common
```

This requires the top-right `Sign in with Google` affordance, verifies that
edit and artifact controls are absent, and requires the edit-manifest API to
return `401/sign_in_required`.

## 2. Authenticate disposable local users

The harness can use Admin's localhost-only `Use local tester` route. Configure
Admin's server environment for one disposable account at a time; credentials
remain server-side.

Launch the contributor profile on `9333`, configure Admin for that account,
then run:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs local-login `
  --port 9333 --profile-label contributor @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs editor-auth-smoke `
  --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs security-boundaries `
  --port 9333 @common
```

`editor-auth-smoke` opens and closes a real block editor without saving.
`security-boundaries` requires the worker endpoint to reject an unauthorised
browser request, requires hostile script/frame artifact HTML to fail validation,
and verifies that the payload never reaches an executable DOM sink.

Launch the reviewer profile on `9334`, reconfigure Admin for the distinct
reviewer account, and run:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs local-login `
  --port 9334 --profile-label reviewer @common
```

The default local-login destination is the protected
`/review/library-edits` route. Absolute, protocol-relative, backslash,
control-character and oversized destinations are rejected before browser work.

## 3. Current v5 contribution and artifact correction flow

Run these commands in order:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs contributor-stage `
  --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs artifact-request-changes `
  --port 9334 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs contributor-revise-artifact `
  --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs artifact-approve-child `
  --port 9334 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs contributor-submit-corrected `
  --port 9333 @common
```

`contributor-stage` starts only when there is no open proposal. It:

- validates the complete signed v5 manifest and exact base receipt;
- edits one Markdown paragraph and requires `**probe**` to autorender;
- edits a typed component field through its typed editor;
- saves exactly those two operations as a draft;
- rejects executable artifact input;
- validates a safe static artifact in a sandbox with no referrer;
- submits that artifact for independent review and binds it to the draft.

`artifact-request-changes` searches the submitted-only Admin queue for the
exact run title and version 1. It requires an independent reviewer, inspects
the escaped private source and independently sanitized empty-sandbox preview,
submits the exact `--artifact-review-note`, and requires the parent to leave the
submitted queue.

`contributor-revise-artifact` requires that exact note and
`changes_requested` state in both the signed contributor response and the UI.
It clicks `Revise`, then proves the dialog reloaded the reviewed HTML, title,
language, rights/provenance fields, accessibility fallback and review flags.
The command changes safe HTML plus contributor metadata, revalidates the
empty-sandbox preview, reconfirms rights and terms, and captures the browser's
actual artifact POST. It fails unless the POST contains the exact reviewed
parent version, artifact lock, placement coordinate, optional replacement
receipt and proposal/base CAS receipts.

After persistence, the same command requires exactly one active submitted
child. Its artifact ID is unchanged; its version and artifact lock advance by
one; its version ID and placement-request ID are new; `parentVersionId` is the
reviewed version; source SHA-256/bytes match the edited HTML; metadata matches
the browser POST; and the two saved article operations are untouched. The
reviewed parent must not remain active at the coordinate.

`artifact-approve-child` requires that the only matching submitted queue item
is version 2, reruns the independent source/sanitizer/sandbox checks, and
approves that exact child. `contributor-submit-corrected` refreshes the receipt
and refuses combined submission unless the approved version remains a child
with the corrected source and metadata receipts. It then submits the two text
operations plus that approved child under the current terms.

The original straight-through commands remain available for a smaller
non-correction smoke case:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs artifact-approve `
  --port 9334 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs contributor-submit `
  --port 9333 @common
```

Run those directly after `contributor-stage`; do not mix them into the
correction sequence. They preserve backward compatibility but do not prove the
review-feedback/child-lineage acceptance case.

If a prior run stopped with this exact summary in draft state, withdraw only
that draft before restarting:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs withdraw-open-draft `
  --port 9333 @common
```

The recovery command refuses a draft whose summary differs from this run.

## 4. Independent proposal review and concurrency

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs admin-self-review `
  --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs admin-request-changes `
  --port 9334 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs contributor-feedback `
  --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs stale-concurrency `
  --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs contributor-resubmit `
  --port 9333 @common
```

The contributor's Admin session must see the proposal but cannot review it.
The independent reviewer checks the current v5 dossier and immutable hashes,
adds one idempotent QA comment, and requests changes. The contributor then sees
the exact feedback and restored metadata.

`stale-concurrency` opens two tabs with the same contributor cookie jar. Tab A
wins a versioned save; tab B must receive the explicit stale-workflow error and
must not overwrite A. `contributor-resubmit` reloads the winning draft,
reaccepts the current terms and submits it.

## 5. Activate and verify live delivery

The independent reviewer performs the activation:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs admin-activate `
  --port 9334 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs public-convergence `
  --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs admin-convergence `
  --port 9334 @common
```

`admin-activate` requires the exact trusted render payload, role-protected
preview, reviewed text and approved artifact before creating the immutable
activation.

`public-convergence` polls the dynamic content-delivery endpoint and then
requires the same activation/generation/content receipts across public article
HTML, public Markdown, catalog, search, LLM outputs, sitemap, JSON-LD and the
delivery manifest. It also requires the edited probe and approved artifact to
be visible.

`admin-convergence` independently requires Admin to mark the job
`Published` and all ten surfaces `Verified`:

1. cache invalidation;
2. article HTML;
3. article Markdown;
4. catalog;
5. search;
6. LLM corpus;
7. sitemap;
8. JSON-LD;
9. delivery manifest;
10. Ada.

The Ada row must identify the configured local Ada origin. This is the
cross-pillar acceptance check; no frontend rebuild or deployment is part of the
flow.

Optional responsive checks:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs mobile `
  --surface library --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs mobile `
  --surface admin --port 9334 @common
```

## 6. Retry a failed local delivery

The harness does not manufacture a failure. In the disposable stack, use the
project's explicit local fault-injection mechanism to leave the exact current
delivery job in `failed` or `retry_wait`. Do not simulate this against a
shared service.

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs retry-delivery `
  --port 9334 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs public-convergence `
  --port 9333 @common
node .\qa\library-collaborative-editing\navigator-e2e.mjs admin-convergence `
  --port 9334 @common
```

The retry command fails if Admin does not expose an enabled retry action. The
two convergence checks prove that a queued acknowledgement alone is
insufficient.

## 7. Append-only rollback

Run rollback only after the activated canary has converged and the stack retains
an eligible prior activation:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs rollback `
  --port 9334 @common
```

The command requires a new, higher publication generation and then verifies
that the QA probe and artifact disappeared from public HTML. Historical rows
remain immutable; rollback is a new activation, not an update or delete.

## Negative authorization and manifest cases

Use a separate disposable ordinary-member profile to prove authenticated role
denial:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs role-denied `
  --port 9333 --profile-label member @common
```

For a deliberately prepared local stack, the generic manifest boundary can
check unregistered, disabled or revision-mismatched articles:

```powershell
node .\qa\library-collaborative-editing\navigator-e2e.mjs expect-manifest-error `
  --port 9333 --slug lovelaces-square/ada/what-is-ada `
  --status 404 --code article_not_registered @common

node .\qa\library-collaborative-editing\navigator-e2e.mjs expect-manifest-error `
  --port 9333 --status 409 --code release_revision_mismatch @common
```

An article outside the editing allowlist should return
`403/article_not_enabled`. Restore the canary's current registration before
continuing a stateful run.

## Evidence and teardown

Every successful browser command writes a non-secret JSON result receipt and,
where useful, a screenshot below the private evidence directory. Failures exit
non-zero. Preserve the receipts with local server/worker logs.

At the end:

- close ports `9333` and `9334` with `close-browser`;
- let the parent run stop only the local processes it recorded;
- discard the disposable database and browser profiles;
- confirm that no key, token, password, cookie, profile or evidence file is
  staged in any application repository;
- record each command's pass/fail result, including any unsupported Ada or
  fault-injection prerequisite.

Passing this run demonstrates the isolated local workflow. It does not authorize
a production deployment.

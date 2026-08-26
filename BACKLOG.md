# Backlog

Durable near-term items identified during active engineering work but deliberately not built in the sprint that surfaced them. Each entry should say what to build, why, and where the investigation that produced it lives.

Organized by how soon each item should be picked up, not by when it was written down. Explicit dependencies between items are called out inline — respect them; don't promote a dependent item ahead of what it depends on.

The current commercial path stays the anchor for prioritization — canonical terminology per Product Cohesion V1 (banked, see "Recently completed" below): **Business Signal (evidence) → Reason to Reach Out (grounded commercial interpretation) → Priority (which Reasons deserve Dashboard attention now) → Prepare for Call / rep action → Outreach → Outcome → Learning**. Larger strategic bets (LATER) exist to eventually extend this path — e.g. a future Proactive Account Plays would add grounded activation intelligence inside this same loop — never to introduce a second, competing terminology model alongside it.

---

## Recently completed (banked — not open work)

Noted here only so these are never rediscovered as gaps. No action needed.

### Notification & Outcome Loop V1 — COMPLETED / BANKED (2026-08-16)

Merged to `main` at `03bd7ee9679a5b37345dadeaa98d09b200eb4073` (merge commit, `feature/notification-outcome-loop-v1` → `main`), founder-approved after full Preview QA including a real live scheduler invocation matching its read-only preflight exactly (`notDue`/`emptyDigest`, zero unintended sends). Activation remains fail-closed — see the Production cutover note below.

**Banked capability:**
- Independent notification transport (`api/notification-scheduler.js`), structurally separate from the legacy Monday Brief (`api/weekly-scan.js`) — not a second implementation layered onto it.
- Daily / Weekly / In-app-only user preference, backed by `ha_users.notification_preference` and exposed in Settings (`settings.html`).
- No empty emails — `selectDigestContent()`'s `hasContent` gate means a digest with nothing new/eligible is never sent and never logged.
- Only a positively-confirmed transport success (a real, non-empty provider message id) ever advances the notification watermark or writes `status:'success'` — a skipped/ambiguous/failed send never does, and is logged honestly as `status:'failed'` with a real reason.
- Proactive "New Intelligence" content obeys the same centralized `classifyMonitoringSignalEligibility()`/`classifyLegacySignalActionability()` priority/secondary/hidden doctrine the dashboard and legacy digest already use — never a second, looser eligibility notion.
- Unresolved-outreach prompts begin around 5 days after `outreach_made`/`opportunity_outreach_made` (`INITIAL_PROMPT_DAYS`).
- `no_response_yet` is itself a real report, remains "still open," and becomes re-eligible for another automatic prompt roughly 7 days later (`NO_RESPONSE_RECHECK_DAYS`) — it is never silent absence of a report.
- `engaged`, `progressed`, and `went_nowhere` are terminal for *automatic* prompting only.
- `outcome_reported` is an append-only child of the specific `outreach_made`/`opportunity_outreach_made` event it reports on (via `parent_event_id`) — never deduped, multiple later updates are valid real history.
- The latest reported outcome is visible back on the account, next to the existing outreach state (`api/signal-events.js` read-back → the Prepare for Call outreach row), not just consumed and hidden.
- One-click dashboard outcome capture (the unresolved-outreach panel) with an explicit, persistent confirmation the rep must actively close — no auto-dismiss timer, no modal, no forced note.
- Contextual outreach deep link: a notification's "Tell us how it went →" link carries `?outreach=<outreachEventId>` and lands the rep on that exact dashboard row, scrolled into view with a strengthened, visually unmistakable highlight (colored border + ring + pulse) — proven distinguishable from otherwise-identical sibling rows. Reuses the existing `next=`-preserving auth-redirect flow; no new auth/session logic. The per-signal "View opportunity →" half was investigated and intentionally not built this sprint — see "Notification Deep Links / Actionable Re-entry" below.
- Intentional Gmail subject line (concise, count-based: "N accounts worth a look [+ M follow-ups]") and hidden preheader (dynamic per signal/follow-up counts), plus a CTA hierarchy where the contextual outreach action visually wins over the generic dashboard link whenever one exists.
- Established users are not blocked by first-time onboarding when re-entering via a notification on a new browser/device/origin — the automatic Beta-welcome popup now fires only once the server has confirmed a genuinely empty workspace, never merely because a session exists.
- Durable delivery history (`ha_notification_deliveries`) and fail-safe transport semantics (an isolated per-user Resend failure never blocks other users' sends; an unknown/failed send is logged, not silently dropped, and never advances the watermark).
- Activation was fail-closed at banking time — both `NOTIFICATION_ENABLED_ORGANIZATION_IDS` and `QUEUE_MANAGED_ORGANIZATION_IDS` were empty/unset in Production as of this merge. Both are now populated — see "Full Beta Monitoring + Notification Cutover" immediately below for the completed Production activation.

**Important limitation — preserve, do not overstate (updated 2026-08-17):** House Accounts captures durable behavioral evidence today (`ha_signal_events`: feedback, selections, outreach, approach notes, and now outcome reports). As of 2026-08-17, dashboard recommendation ranking consumes a first, bounded slice of this evidence — see "Behavioral Learning V1 — Dashboard Foundation" below. Notification ordering, account prioritization eligibility, and rep/org behavioral profiles still do not consume it. Do not claim broader behavioral learning than what is actually banked — see that entry for the precise shipped/not-shipped boundary.

- **Notification preferences UX** (Part A4): a simple Daily / Weekly / In-app only control lives in Settings, backed by `POST /api/settings` `action:'update-notification-preference'` and the existing `ha_users.notification_preference` field. No new settings architecture — reused the existing preference field/API pattern verbatim.
- **Notification deep link — unresolved outreach** (Part A3, CTA hierarchy strengthened in later live-QA rounds): see the banked capability list above for full detail.

### Full Beta Monitoring + Notification Cutover — COMPLETED / BANKED (2026-08-16)

Merged to `main` at `8bb8f3469fbf85bdf1d83808f16e895b7a9df593`, founder-approved after live Production proof of the full autonomous chain (not just Preview QA). Retires the legacy Monday-cron/Monday-Brief architecture entirely — `api/weekly-scan.js` and its weekly-scan-only tests/dev tooling are deleted from `main`; `vercel.json`'s single Monday cron is replaced by `/api/monitoring-scheduler` (`*/5 * * * *`) and `/api/notification-scheduler` (`0 12 * * *`). No parallel/fallback weekly architecture is retained.

**Production activation allowlist (both `QUEUE_MANAGED_ORGANIZATION_IDS` and `NOTIFICATION_ENABLED_ORGANIZATION_IDS`):** Keegan Test, GMG, PromoCentric, Sweet Grass Farm — the complete set of organizations with legitimate active monitored usage at cutover time. Phase1test (founder/internal test infra) and `audra.pafford@gmail.com` (retired legacy demo usage, no organization) were deliberately excluded; both keep their historical data untouched.

**Also banked in this cutover:** migration 23 (`supabase-schema-migration-23-monitoring-coverage-classification-restore.sql`), restoring `ha_monitoring_attempts.coverage_classification` persistence in `complete_ha_monitoring_attempt()` — a regression migration 20 silently introduced when it added `p_cooldown_hours` (copied the pre-migration-17 INSERT shape). Applied to and independently read-verified in Production; every migration-20 cooldown behavior is unchanged.

**Live autonomous Production proof (not manually invoked):** Vercel Cron's first natural `GET /api/monitoring-scheduler` firing (2026-08-16 23:20:41 UTC) published the one naturally-due target (Timberland, Sweet Grass Farm) — `dueActiveCount:13, queueManagedDueCount:1, publishedCount:1`. The Queue consumer autonomously claimed, researched, and completed it (`coverage:'complete'`, 2 signals discovered and persisted, ~$0.0247, capacity acquired/released normally, `queueAction:'ack'`). Two subsequent natural cron firings (~23:25, ~23:31 UTC) correctly found and published zero work. No Production runtime errors. This proves the complete chain end to end: Vercel Cron (GET) → monitoring scheduler → due-only/allowlist-gated selection → Queue publish → bounded worker → research → validated signal persistence → cadence advancement → Queue ack. The independent notification scheduler was separately proven in Production (empty-digest preflight matched exactly, zero unintended sends).

**Founder determination — do not reopen or further optimize this infrastructure absent a confirmed Production failure or meaningful scale evidence.** Queue monitoring + independent notification is the canonical Production architecture going forward; the legacy weekly architecture is not retained as a fallback. Continue tracking monitoring cost/coverage as real usage accumulates (see "Monitoring Economics founder telemetry" below), but do not tune anything off this initial single-target sample.

**Behavioral Learning V1's dashboard foundation is now shipped** (2026-08-17) — see "Behavioral Learning V1 — Dashboard Foundation" below for the precise, bounded scope. Notification-learning wiring and richer learning are deliberately deferred until real Beta usage accumulates.

### Behavioral Learning V1 — Dashboard Foundation — COMPLETED / BANKED (2026-08-17)

Merged to `main` at `4b62e3308028832ae4779843a4c82092f5a21cd5` (merge commit, `feature/behavioral-learning-v1-phase1` → `main`), founder-approved after live Preview QA (deployment `dpl_9oatWvhP5Lva4JYmXxYWv7JLPwDq`, matching commit `34b7ce0`) and a code/privacy review. Deterministic suite: 157/157 passing before and after merge.

**Two-layer doctrine (preserve):** House Accounts gets better at understanding signals globally, while the way a specific team sells becomes private intelligence for that organization. This ships the **private organization layer only** (Layer B). The global cross-customer layer (Layer A) remains future work and is not implemented — see `api/lib/org-preference-learning.js`'s own header comment for the exact boundary rules.

**Shipped:**
- Private, organization-scoped behavioral preference learning (`api/lib/org-preference-learning.js`), structurally isolated per organization — one org's evidence can never influence another's adjustment.
- Three canonical evidence families: `FOLLOW_UP`, `REPEAT_PATTERN`, `BUSINESS_ACTIVITY` (any signal-type business activity, pooled — not the ~25 raw signal-type labels).
- Two evidence streams: direct `useful`/`not_useful` quality feedback, and conservative outcome evidence (`outcome_reported` status `engaged`/`progressed` only — `no_response_yet`/`went_nowhere` never count as evidence).
- Latest-opinion and latest-outcome dedup semantics — a changed rep judgment or a sequential outcome update on the same outreach counts once, not as multiple independent votes.
- N=5 minimum evidence floor per family before any adjustment applies; 90-day evidence recency window.
- Bounded ±8 additive ranking adjustment — one term added to the existing dashboard score, never a rewrite of baseline scoring weights.
- Dashboard "This Week's Priorities" ranking consumes the learned adjustment (`api/get-dashboard.js` computes it once per request server-side; `dashboard/index.html`'s `calculateOpportunityScore()` applies it).
- Insufficient evidence (the real state for every current Beta org as of banking) leaves ranking byte-identical to baseline — proven both by deterministic tests and by live Preview QA.
- Truth/identity/actionability gates (`classifyMonitoringSignalEligibility()`/`classifyLegacySignalActionability()`) remain entirely upstream and untouched — learning only reorders already-eligible candidates, never changes what's eligible.
- Fail-closed: any preference fetch/compute failure falls back to baseline dashboard ranking and logs the failure — never a dashboard error.

**Not shipped — do not overstate:**
- Notification ranking does not consume Behavioral Learning yet.
- No rep-level personalization (organization-level only).
- No manager-learning dashboard.
- No richer event-type/industry/contact dimensions beyond the three families above.
- No global cross-customer learning implementation (Layer A remains future work).
- Current Beta organizations do not yet have enough accumulated evidence to produce any active (non-zero) adjustment in Production.

**Founder sequencing decision (2026-08-17) — do not begin notification-learning wiring next.** Deliberately let real users accumulate genuine behavioral evidence first. Do not tune N=5, ±8, the 90-day window, or evidence weights, and do not add new dimensions, based on fixtures or this founder QA round. Revisit after meaningful Beta usage accumulates, and decide from real data whether thresholds/weights are sensible, preferences are emerging, ranking changes look commercially correct, notification ordering should consume the same learning primitive, and richer dimensions are warranted.

### Account Expansion / Whitespace Intelligence — Buying Center × Offering Matrix — COMPLETED / BANKED / LIVE IN PRODUCTION (build started 2026-08-18; two founder correction rounds, 2026-08-19; merged and verified live 2026-08-19)

**Status: BANKED.** Fast-forward merged to `main` at `da777c6`, founder-confirmed live in Production via independent Vercel verification (deployment `dpl_45RcJrZQ45yQK5fjkoV3hssoeWvS`, READY). A follow-up documentation-only commit (`508c6a4`) is also confirmed live (deployment `dpl_9EUb5N94KPUm8BFWVyWdu5Xp9NFE`, READY). Merged-`main` suite: 160/160. This closes both founder correction rounds (durable persistence; the V1 Covered truth rule requiring real source semantics or explicit rep confirmation, never inference) — see those rounds' detail above, preserved as the record of what was corrected and why.

**Visibility correction (2026-08-19, via Account Intelligence V1 — see its own entry below).** "Deployed" above is not the same claim as "visible to a signed-in rep." A pre-existing `.ha-mvp` CSS rule (predating this feature) unintentionally hid the account-intelligence rendering surface this matrix lives inside on every authenticated page load, so the matrix was live in Production but not actually reachable in the real product until Account Intelligence V1 corrected that rule. The evidence/persistence/truth-rule work documented in this entry was correct throughout — only product-surface visibility was affected, not the underlying logic.

**Product reframe this sprint (founder/Vantage review):** "Expansion" was being used for two different sales motions that must not be conflated. **Account Expansion / Growth Map** — how much of an *existing* customer do we currently own, and where is the whitespace (departments, product/program categories) — is the near-term priority below. **Find More Like Them / Lookalike Expansion** — net-new companies resembling accounts we already win with — is a separate, later capability; see its own entry under LATER.

**Design evolution this sprint:** started as a two-list (departments/categories) chip view, then reframed to a two-axis matrix (rows = buying centers, columns = offerings) after founder review of ARPEDIO/DemandFarm-style whitespace tooling. A real, read-only Supabase production query (not assumption) found contact department/title fields at ~0% population across every real Beta org's uploaded order history — this shaped both the cell-linkage discipline below and the mapping-prompt fallback.

**Founder correction round 1 (2026-08-19), after independent Production verification of the initial ship (`99b9fa1`):** approved the overall UX direction but held back banking on two trust/architecture issues:
1. **Persistence.** The buying-center mapping prompt's confirmation was client-local (localStorage) — organization/account intelligence, not a browser preference. Promoted to a durable, organization-scoped, cross-device Supabase table (see "Durable persistence" below).
2. **"Covered" truth standard, first pass.** Corrected same-row co-occurrence (too permissive — a repeated static contact would falsely "cover" every category an account ever bought) to a per-contact category-discrimination standard (a contact's own evidenced rows must span exactly one category to back a cell). **This first-pass correction was itself found still insufficient in round 2 below — see the current standard there, not this one.**
Also fixed while auditing: the matrix's responsive behavior now scrolls horizontally with the Buying Center column sticky, rather than risking shrunk/illegible cells at ordinary laptop widths.

**Founder correction round 2 (2026-08-19), after independent Preview verification of round 1 (`ba34cf5`):** round 1's persistence architecture was approved as correct for V1. Two things still required correction before founder approval:
1. **"Covered" truth standard, corrected again.** Per-contact category discrimination (round 1) still only proved correlation within data HA already had, never that a specific buying center purchased a specific offering. Worked example: a generic HR contact repeated on every row, account happens to have purchased only Apparel — even though HR is the only contact and Apparel the only category (so the round-1 rule would call it "genuinely discriminating"), this still doesn't prove "HR bought Apparel." **Current, standing V1 truth rule** (see the doctrine bullet below): a cell may render Covered only when (1) source data explicitly proves the specific buying-center-to-offering linkage, or (2) a rep explicitly confirms they sell that offering into that buying center. Neither exists today, so `computeAccountWhitespaceMatrix()` never assigns `covered` from real data — every cell is whitespace, every real purchased category renders in the unattributed panel. This is an accepted, honest V1 result, not a bug or a regression.
2. **Persistence identity caveat.** Founder asked to record explicitly that `(organization_id, normalized_company_name)` is a V1 account-resolution key, not an immutable account identifier, and to verify rename/re-upload doesn't silently corrupt data. Verified: there is no rename UI in the product today (`saveAccountMetadataEdit()` explicitly cannot rename an account); only a CSV re-upload with a differently-normalizing account name could shift the key, and when it does, old confirmations go inert (never deleted, never leaked to the renamed account) while the account safely falls back to the mapping prompt — the same state as never-confirmed, never stale/wrong data. This mirrors `ha_monitoring_targets`' own accepted, already-documented exposure to the identical failure mode (migration 15's identity doctrine) — not a new risk this table introduces. Smallest safe mitigation identified and applied: explicitly documented in the migration/API/BACKLOG (this entry) and deliberately did **not** add fuzzy/best-effort relinking of orphaned rows to a same-named new account, since that risks silently misattributing one company's confirmations to an unrelated company that happens to share a name. A real fix needs a stable, cross-upload account identity — a larger Canonical Account Identity project, out of V1 scope.

**Doctrine (governs every future slice, not just this one):**
- **Absence of evidence is never confirmed absence.** A cell with no evidence is "whitespace," never a claim of certainty either way.
- **V1 Covered truth rule (current, standing — round 2, 2026-08-19, supersedes round 1's per-contact-discrimination rule above).** A cell may render Covered only when (1) source data explicitly proves a specific buying center purchased a specific offering, or (2) a rep explicitly confirms they sell that offering into that buying center. Co-occurrence, uniqueness, repetition patterns, and single-category discrimination are all explicitly insufficient — none of them prove the intersection, only two independent facts (a known buying-center relationship; an account-wide observed purchase). Neither condition exists in this codebase today: no CSV field carries per-offering buying-center-purchase semantics, and today's durable rep confirmation is buying-center-level only, never offering-specific. Result: zero automatic Covered intersections is the correct, accepted current state — not a defect to work around.
- **Known-relationship context is row-level metadata, not a cell state.** Knowing a contact in a buying center describes that row's label (e.g. "Jane Doe · known contact"), never paints every cell in that row — and a buying-center-level rep confirmation is exactly the same: row-level only, never implies coverage of any specific offering cell.
- **Whitespace is not automatically an opportunity.** A recommended Active Expansion Play (not built yet) will require grounded commercial rationale (a real signal, a recurring/program pattern, an introduction path as supporting evidence only) in addition to a whitespace cell existing — an industry template alone remains insufficient.
- **Only real-evidence states render in Production.** Covered, Not-Applicable, and Active-Expansion-Play have reserved markup/CSS (explicit "✓"/"N/A"/"EXPAND", no mystery icons) but are never assigned without a real per-offering source field, a real cell-level rep confirmation (now built — see Cell-Level Buying Center × Offering Confirmation / Correction V1, folded into "Relationship Footprint + Multi-Contact / Contact Durability V1" below), or grounded expansion-play logic — no synthetic/demo cells in a real account.
- **Unattributed purchases are never a fake buying-center row.** Every real category purchase renders in a separate "Account-wide purchases not yet attributed" panel, outside the organizational grid, since no automatic attribution exists under the current truth rule.
- **`(organization_id, normalized_company_name)` is a V1 account-resolution key, not an immutable account identifier.** See round 2's persistence-identity finding above for the full rename/re-upload safety analysis.

**Shipped:**
- Explicit department taxonomy (7 buying centers, reusing `departmentFromText()`'s vocabulary) and category taxonomy (11 offerings, reusing `inferPromoCategory()`'s vocabulary) — unchanged, no new classification scheme.
- `computeAccountWhitespaceMatrix(account, confirmedCenters)` — pure function producing the real matrix under the current V1 Covered truth rule above (always whitespace today), per-row known-contact metadata, and the unattributed-category list.
- The "🗺️ Whitespace Intelligence" matrix UI (labeled "Account Whitespace" at initial ship; renamed for product-name consistency as part of Account Intelligence V1, see below) on the existing per-account expandable card (Manage Customer Accounts) — clean horizontal wrapped column headers (no rotated all-caps), no legend, CSS-grid tiles rather than a raw table. Fixed-width columns, horizontally scrollable, with the Buying Center row-label column and header corner `position:sticky` — ordinary laptop widths no longer clip or shrink right-side offerings.
- **Lightweight buying-center mapping prompt** for the current real-world common case (zero classifiable buying centers): "Help House Accounts map this customer" + clickable buying-center chips, matching the doctrine that HA builds the map wherever it has evidence and the rep supplies only small corrections — never per-cell manual data entry.
- **Durable persistence:** `ha_whitespace_confirmations` (migration 24) — keyed by `(organization_id, normalizeCompanyName(account_name), buying_center)`, reusing `ha_monitoring_targets`'s identity convention deliberately without a hard FK to that table's row (different lifecycle; not every account has a matching monitoring target). `api/whitespace-map.js` — Bearer-token-authenticated, server-derived `organization_id` only; `GET` with no `accountName` returns the whole org's confirmations in one batched map (`{confirmations:{normalizedName:[...]}}`, one bounded request per render, matching the `org-preference-learning.js` fetch doctrine), `GET ?accountName=` returns one account's array for callers that only need one, `POST {accountName, buyingCenter}` toggles (insert/delete, existence-then-write, concurrent-insert races on the unique constraint treated as success not error). Confirmations are cross-device and visible to every authorized org member, not a per-browser preference.
- Fixed a real, narrow gap this work depended on: `normalizeSavedAccount()` never restored `allRecords` from `rawData.records` after a save/reload, so a previously-saved (not just freshly-uploaded) account would have silently shown empty per-row evidence. Purely additive.
- **Explicitly not built yet:** grounded Active Expansion Play generation, any change to Relationship Expansion opportunity-generation logic. (Cell-level confirm/correct — the second condition of the V1 Covered truth rule above — was not yet built at the time of this entry; it has since shipped and is banked separately, see "Relationship Footprint + Multi-Contact / Contact Durability V1" below.) Full suite: 160/160.
- **Ingestion recon finding (2026-08-18, real production query):** widening CSV department/title column aliases has low expected yield — commonsku/Facilis/Antera/generic-Excel order-history exports generally don't contain these fields at all; the real levers are future integration contact APIs (Antera's confirmed schema already exposes per-contact title data) and the rep-confirm loop this entry ships.

### Account Intelligence V1 — COMPLETED / BANKED / LIVE IN PRODUCTION (2026-08-19)

**Status: BANKED.** Fast-forward merged to `main` at `f21dedd` (from a fresh branch off `main`, not the prior in-progress feature branch), founder-confirmed live in Production via independent Vercel verification (deployment `dpl_7Bweh5VHQf5NM1sSASrqk528kd33`, READY). Merged-`main` suite: 161/161. Founder personally click-tested the deployed Preview against real account data before merge (V1 journey, Manage Customer Accounts entry points, multi-word account names, back link, browser Back/Forward, refresh-on-hash, old sections staying hidden) — automated coverage was prerequisite evidence, not the approval itself.

**What this is:** Account Intelligence as a first-class, bookmarkable per-account destination (`#account=<name>`), reached via `Dashboard → Manage Customer Accounts → View Account → Account Intelligence`. Same content every account already had (account summary, Reasons to Reach Out, Whitespace Intelligence, historical purchase/order evidence, pipeline where available, business signals/Research Account, contacts) — this shipped navigation and a real destination on top of existing content, not new panels or a CRM expansion.

**Root cause behind five earlier Preview QA rounds:** every prior test/screenshot fixture stubbed `site-header.js` to avoid mocking its auth/DOM dependencies, so `.ha-mvp` (applied unconditionally at `site-header.js:33`) was never actually present in any reproduction. A pre-existing CSS rule (predating this feature, Sprint 4.3A) hid `.opportunities-section.account-intelligence-section` — the exact container this work lived in — under `.ha-mvp`, on every real authenticated page load. Every earlier "verified in a real browser" claim was accurate for the code but never representative of the real product, because the one script that both replaces the header chrome and sets that hidden state was always excluded. A read-only audit traced this mechanism, confirmed no git-branch divergence existed, and produced a founder-approved Phase 2 plan.

**Architecture:** explicit `#dashboardView` / `#accountIntelligenceView` sibling containers under one persistent shell, toggled by a single function off the `#account=<key>` hash — not the `.ha-account-focus` body-class + CSS-hide-list approach an earlier round had implemented (rejected on review, so new Dashboard sections stay excluded from Account Intelligence mode by construction, not by remembering to add a hide-rule each time). The stale `.ha-mvp` selector was corrected to stop hiding Account Intelligence while leaving `.workflow-switcher`, `.sales-dashboard`, and `#customerMonitoringWorkspace` hidden exactly as before (still Bucket C — not revived). `#accountManagerModal` stays a sibling of both containers, never trapped by the boundary. V1 has no general Accounts list on the Dashboard; back link reads "← Dashboard," not "← All Accounts."

**Regression coverage:** `scripts/test-account-intelligence-live-navigation.js` (new) serves the real `dashboard/index.html` and the real, unstubbed `site-header.js` over an actual HTTP server (not `file://`, not a fragment) and proves `.ha-mvp` application, real header rendering, old sections staying hidden, default/account-hash mode switching in both directions, multi-word route-identity round-tripping, browser Back/Forward, direct refresh on an account hash, and the invalid-hash not-found state — the specific gap the earlier stubbed-`site-header.js` fixtures left uncovered.

**Terminology:** the per-account "Account Whitespace" section label was renamed to "Whitespace Intelligence" in the same merge (copy-only; subtitle unchanged) — see the Whitespace Intelligence entry above.

**Explicitly not built / not started:** cell-level Buying Center × Offering confirm/correct, Active Expansion Plays, Prospecting, broader legacy-markup cleanup beyond what this change required.

### Relationship Footprint + Multi-Contact / Contact Durability V1 — COMPLETED / BANKED / LIVE IN PRODUCTION (2026-08-19)

**Status: BANKED.** Fast-forward merged to `main` at `0bee156` (built on `7f27c88`, which itself banks the Cell-Level Buying Center × Offering Confirmation / Correction V1 slice — see the fold-in note below), founder-confirmed live in Production via independent Vercel verification (deployment `dpl_EeEAw9q9WNvbA56R2khCsxNkJEKg`, READY). Merged-`main` suite: 165/165. Founder personally click-tested the real deployed Preview (Add Contact from a Buying Center; correct Buying Center preselection; save succeeds; new contact appears in both the relationship footprint and the Contacts section; multiple contacts supported; per-contact editing works; state survives normal navigation/refresh) before approval — automated coverage was prerequisite evidence, not the approval itself.

**Folds in a prior un-banked slice:** Cell-Level Buying Center × Offering Confirmation / Correction V1 (migration 25, `api/whitespace-cell-answers.js`) shipped and was founder-approved at `7f27c88` but was never separately recorded in this file — banked now, retroactively. It is the second condition of the V1 Covered truth rule (see the Whitespace Intelligence entry above): a cell can now render Covered via a real cell-level rep answer, not only a future per-offering source field. This corrects the "not built" / "currently in scoping" language for cell-level confirm/correct that had gone stale elsewhere in this file (see the Growth Map entry under NEXT).

**Shipped, this entry:**
- Durable multiple contacts per account (`account.contacts[]`) — already existed as a data shape; now the actual UI surface, replacing the old single bottom-of-account "Contact: ..." line.
- Durable per-contact `id` and a machine-safe `origin` (`upload` | `manual`), backfilled automatically for contacts saved before this field existed.
- Conservative re-upload reconciliation (`reconcileImportedContacts()`): matches an incoming CSV row to an existing contact by exact email, or by an unambiguous normalized name only — a genuinely ambiguous same-name match is refused rather than guessed at (a false duplicate is an accepted cost; incorrectly merging two real people is not).
- Manually added and manually edited contacts survive a later CSV re-upload untouched, even when that upload no longer mentions the person.
- Buying Center relationship footprint, with correctable explicit team confirmations — a rep can undo a misclick without erasing any other legitimate evidence for that row.
- Relationship-detail popover ("who do I know here, and why does HA think so") listing every legitimate evidence source in plain language, never internal evidence-model phrasing.
- Multiple contacts per Buying Center, each independently editable.
- Context-aware Add Contact (Buying Center preselected from the row the rep opened it from) and per-contact editing — one shared modal, bounded to name/title/Buying Center/email/phone.
- Strict non-CRM boundary held throughout: no activity timeline, notes, call logs, tasks, reminders, email history, or custom fields.

**Non-blocking performance observation (2026-08-19, founder Preview click-test):** one manual contact save took roughly 10 seconds before completing successfully. Every account edit in this app, including this one, goes through `saveCurrentUpload()` → `/api/save-upload` → `replace_ha_accounts_snapshot()`, which rewrites the full account snapshot for the upload inside a `pg_advisory_xact_lock(hashtext(upload_id))`-serialized transaction — pre-existing shared architecture, not introduced by this work. Two plausible causes follow directly from that, no measurement performed: a full-snapshot rewrite proportional to account-list size, and/or serialization behind a concurrent operation holding the same per-upload lock. **Do not investigate further absent repeated real-user evidence of material latency.**

**Explicitly not built:** contact deletion, any CRM feature (activity/notes/call logs/tasks/reminders/email history/custom fields), Active Expansion Plays, Prospecting.

### Active Expansion Plays V1 — COMPLETED / BANKED / LIVE IN PRODUCTION (2026-08-19)

**Status: BANKED.** Merged (`--no-ff`) to `main` at `9580cb21c588061bed4fd482f437256f21c0222f`, founder-confirmed live in Production via independent Vercel verification (deployment `dpl_HsNojehvGaATVPXgnsuJkhTc46LK`, READY). Merged-`main` suite: 167/167. Founder personally click-tested the real deployed Preview across three rounds, including a real-account trace against Warner Bros. Discovery data, before approval.

**Doctrine (concise, governs this feature going forward):**
- **Matrix = where whitespace is.** **Relationship = where we have access.** **Repeat evidence = why now.** **Active Expansion Play = what is worth working.**
- **V1 eligibility requires all three, together, per Buying Center × Offering cell:** (1) explicit confirmed whitespace in the exact cell (`answer === 'whitespace'`, never blank/inferred); (2) legitimate relationship access in that Buying Center (an explicit team confirmation, or a known mapped contact — cell-mapping evidence is deliberately excluded from this condition, see below); (3) a genuine category-matched Repeat/Pattern trigger (`findRepeatPatternGroups()`'s own real evidence bar, category matching the cell's offering exactly).
- **Business signals do not activate a specific whitespace cell in V1** — today's signal-derived department/category classification isn't reliably linkable to one exact cell; a verified business signal is never a valid trigger.
- **Blank cells never qualify** — only an explicit `'whitespace'` answer does.
- **Whitespace/N/A cells do not imply relationship access; Covered can** — a covered cell proves real business exists in that Buying Center, which is legitimate relationship evidence; a whitespace or not-applicable answer proves nothing about access. (Corrected 2026-08-19, real-account trace: a row with only whitespace/N/A-answered cells had been falsely showing "Known relationship.")
- **`active_play` is a derived attention state, never persisted as a cell answer.** The durable answer stays one of `covered | whitespace | not_applicable`; `active_play` is computed fresh at render time from a real `whitespace` answer plus the other two eligibility conditions.
- **Lifecycle: `Whitespace → EXPAND → Covered ✓`.** The orange EXPAND cell stays fully clickable and opens the same cell-answer popover as any other cell, pre-selected on the real underlying whitespace answer. Selecting Covered or N/A persists that real answer and the play disappears immediately because the underlying cell is no longer whitespace — never because a separate "play completion" state was tracked.
- **No dismiss/snooze/task-management lifecycle exists in V1** — completion is simply the rep updating the real cell truth.
- **Repeat/Pattern visible copy reflects the actual historical category, not cross-sell suggestion text.** (Corrected 2026-08-19: `getRepFriendlyWhy()`/`buyingConversationLabel()` previously keyword-matched cross-sell suggestion lists (`commonPromoCategories`/`suggestedProducts`) and a cosmetic `buyingCategory` field, which could name a category that never actually repeated — e.g. a real Print/Stationery pattern displaying "Past apparel buying..." A real production trace against Warner Bros. Discovery proved this. Both functions now use the real `opp.category` directly for Repeat/Pattern Signal opportunities, falling back to the old keyword-matching only for legacy data persisted before `opp.category` existed on this signal layer.)
- **Multiple qualifying Buying Centers sharing one trigger are never ranked or suppressed** — every one is a real, separate play, grouped under shared "why now" text only to avoid stuttering identical copy.
- **Copy states facts, never overstates causality** — the repeat-pattern trigger is real account-wide purchase history, never claimed to be "from" the specific Buying Center; "what to explore" is phrased as a restrained question, never an assertion of need.

**Known future freshness note (not a current defect):** Repeat/Pattern eligibility itself is stable over time — it is derived entirely from fixed historical purchase dates. Only downstream wording (e.g. `reorderWindowStatus()`'s "approaching/current/overdue" language) can age as real time passes, since Active Expansion recomputes that timing language live on every render while some persisted Reasons-to-Reach-Out wording elsewhere may not. Revisit as part of a future Product Cohesion/freshness pass — not a defect to fix now.

**Shipped:**
- `computeActiveExpansionPlays(account, matrixRows)` — the deterministic three-condition eligibility gate above.
- The `active_play` matrix cell state, wired to real eligibility (previously reserved/unreachable markup).
- A compact Active Expansion Plays panel in Account Intelligence, grouped by shared trigger, following the copy doctrine above.
- The row-level relationship-semantics correction and Repeat/Pattern copy-truthfulness correction described above, both surfaced by a founder real-account trace against Production data (Warner Bros. Discovery) mid-QA, before final approval.
- The clickable EXPAND-cell interaction described above, reusing the existing cell-answer popover/persistence path with no new endpoint, no new table, and no new completion-state concept.

**Explicitly not built:** Prepare for Call deep-link from an Active Expansion Play (evaluated, did not fit cleanly within V1 scope, deliberately deferred); dismiss/snooze/task-management lifecycle; new signal scoring; industry templates as a trigger; Prospecting.

### Product Cohesion V1 — COMPLETED / BANKED / LIVE IN PRODUCTION (2026-08-19)

**Status: BANKED.** Started from the founder's own real-product-usage hypothesis (2026-08-19, after using Relationship Footprint/Contact Durability — see the retired "Product Cohesion / canonical Account Intelligence workspace" hypothesis entry this replaces) and delivered across a recon/audit pass plus two implementation rounds, each independently founder-approved on real Preview click-testing. Merged (`--no-ff`) to `main` at `8d31edd590945ad3c5e22f3d298c95509d10afea` (from branch `claude/cohesion-simplification-v1`, approved tip `120ab8583d0009ccd5d925edf3386041642af05b`), founder-confirmed live in Production via independent Vercel verification (deployment `dpl_4zDKsdS1StoUZEYq8dBcrZeuevnq`, READY). Merged-`main` suite: 170/170. Founder personally click-tested the real deployed Preview across multiple rounds, including a real-Preview repro of a confirmed post-approval blocker (the "View signal(s) →" toast CTA), before final approval: "Product Cohesion V1 is approved."

**Key outcomes (doctrine — preserve, do not re-litigate or re-audit without a new, specific reason):**
- Dashboard is the canonical place to decide where to spend attention.
- Account Intelligence is the canonical destination for understanding and working one customer.
- Research is a capability/process attached to an account, not a separate conceptual destination.
- Account-name links are the canonical entry into Account Intelligence from both Manage Customer Accounts and Dashboard priority cards.
- Business Signal = evidence.
- Reason to Reach Out = grounded commercial interpretation.
- Priority = which Reasons deserve Dashboard attention now.
- `Opportunity` has been reduced/retired where redundant in the approved scope (a bounded vocabulary correction, never a mechanical sweep of the word).
- Relationship terminology was disambiguated without removing underlying ranking/persistence logic.
- Active Expansion Plays remain distinct from Reasons to Reach Out.
- Week / Month / Quarter / Year are now one consistent Priorities mental model ("This [Week/Month/Quarter/Year]'s Priorities").
- Returning-user empty-state copy now reflects autonomous monitoring, not a re-upload/refresh prompt.
- Research-completion CTAs route into Account Intelligence → Business Signals (`deepLinkToAccountResearch()`), never a separate results view or a Prepare-for-Call/Verified-Opportunity handoff implying a play that may not exist.
- Lower-confidence / secondary research evidence can remain visible without manufacturing a Reason to Reach Out.

**Shipped, round by round:**
- **Round 3 (simplification slice):** retired the duplicate "View Account" button (the account-name link is the sole entry point); "View Research" deep-links into Account Intelligence's own Business Signal evidence instead of a separate results view; Active Expansion Plays got its own distinct icon (no collision with Reasons to Reach Out); the Whitespace Intelligence section gained a "Relationships" heading; the return-visit monitoring empty state no longer tells a rep to re-upload/refresh; "Relationship Expansion" badge label renamed to "Category Expansion" (display-only, classification identity untouched).
- **Round 4 (final cohesion corrections):** account-name links get real link affordance (brand teal/green color, pointer cursor, hover underline, keyboard focus) in both Manage Customer Accounts and Dashboard priority cards; Dashboard priority-card company names link into Account Intelligence while Useful/Not Useful/Prepare for Call stay independent card actions (never a card-wide link); all four timebox headings normalized; `feedSummary()`'s two adjacent nouns corrected ("business signals"/"repeat buying patterns"); the research-completion "View signal(s) →" CTA fixed at both call sites.
- **Round 4 follow-up (confirmed blocker):** root-caused via real-browser reproduction — the toast's own fixed 8s auto-dismiss timer could remove the CTA button from the DOM before a rep finished reading and decided to click a deliberate navigation decision (not a quick "Undo"). Fixed: `showToast()` now pauses its dismiss timer on hover/keyboard-focus and resumes the remaining time on mouseleave/blur; both research-completion toasts also get a longer base window (15s, was 8s). Also found and fixed a second, silent breakage along the way: `researchAccountFromCard()` (the Research button directly on a Dashboard/Account Intelligence card, as opposed to the Manage Customer Accounts modal's own row button) called a `showToast` that was out of its scope entirely (declared inside the modal's private IIFE) — `typeof` on an out-of-scope identifier silently returns `'undefined'` rather than throwing, so that toast never rendered at all for that entry point. Now reaches the one real implementation via `window.HouseAccountManager.showToast`.

**Explicitly not built — preserve as distinct future items, do not fold back into a re-audit:**
- **Whitespace Intelligence first-use/guided education** — moved to "Account Expansion / Whitespace Intelligence / Growth Map — remaining work" below.
- **Slice 3 — stricter Category Expansion / relationship-expansion generation logic** — already tracked under "Account Expansion / Whitespace Intelligence / Growth Map — remaining work" below; unaffected by this cohesion work.
- **Find More Like Them / Lookalike Expansion** — tracked under LATER below.
- **Proactive Account Plays / Signal-to-Activation Intelligence** — tracked under LATER below.
- **Integrations** — tracked under SOON below.
- **Broader onboarding/demo infrastructure** — tracked under "Onboarding/upload polish" (SOON) and "Demo Booking + Guided Customer Activation" (LATER) below.

**Founder determination — do not reopen or start another cohesion audit absent a confirmed, specific blocker.** The next step is a full founder release-candidate smoke test of the live product, not further cohesion/UX work.

### Release-Candidate Remediation Slice — COMPLETED / FOUNDER-PASSED / LIVE IN PRODUCTION (2026-08-20)

**Status: BANKED.** Follows directly from the founder's own real-Production smoke test (new account, incognito, real customer data) called for at the end of Product Cohesion V1 above. That smoke test's read-only triage (`RC-1`–`RC-6`, all 41 field notes plus `H5`–`H7`) found **nothing that prevented active founder-led selling** — every confirmed issue was narrow, well-understood, low blast-radius. Founder approved the exact 7-item remediation slice; implemented, tested, and shipped on branch `claude/rc-remediation-slice-v1`, plus one scope-locked Help-menu amendment surfaced during founder QA of the deployed Preview. Fast-forward merged to `main` at `3380610f363ac04b5b916d8c19c63c0f54d5a22d`, founder-confirmed live in Production via independent Vercel verification (deployment `dpl_4TS8yAQ8NRxYA5afhLK99dsYqtXn`, READY). Merged-`main` suite: 173/173. Founder PASS: *"House Accounts is now cleared for active selling."*

**Shipped corrections:**
- Recently Researched's CTA routes to the canonical Account Intelligence / Business Signals evidence deep-link (`deepLinkToAccountResearch()`) instead of auto-launching Prepare for Call off a House-Accounts-ranked opportunity — the same "Atlas Precision" terminology/routing fix Product Cohesion V1 already applied at its other two call sites, missed at this third one.
- An in-session "I reached out" save now refreshes the Dashboard's unresolved-outreach panel immediately (`initUnresolvedOutreachPanel()` re-fires after a successful save) — closes a pure client-side refresh gap; server-side `isStillOpen` semantics (`api/lib/outcome-prompts.js`) were already correct and immediate.
- FAQ's stale "one active list per work email" claim corrected to describe real multi-list support (`faq.html`) — the one confirmed-stale FAQ claim; the broader FAQ/content overhaul (see below) remains separate, deferred backlog work.
- Legacy Trial UI (Settings) hidden for accounts with no real trial history, preserved for any account that has genuine trial history (active, lapsed, or paid-active/hidden) — presentation/state correctness only, no pricing/entitlement change.
- Empty Priorities terminology aligned to Product Cohesion V1's canonical vocabulary (no more "opportunities"/"business triggers" in the empty-timebox state).
- False "No signals found" in Manage Customer Accounts corrected using authoritative signal truth — `accountListRow()` now carries a real, bounded per-page `ha_signals` count from the server, merged via `Math.max()` with the existing client cache so the count can never be under-reported; confidence-tier semantics (secondary evidence ≠ automatic Reason to Reach Out) are unchanged.
- The first-upload guided-tour/Manage-Customer-Accounts-modal collision is resolved — the tour defers spotlighting Dashboard elements while the modal owns the rep's foreground (bounded poll on the modal's own `isOpen()`), and resumes automatically once it closes.
- FAQ added to the authenticated Help dropdown (→ `faq.html`) — founder QA amendment, surfaced when independently verifying the deployed Preview: FAQ existed but had no discoverable entry point.
- Redundant Help-dropdown entries ("Export Help", "Upload Troubleshooting" — both anchors into the same `/export-guides/` page the top-level "Upload Guides" nav link already opens) removed — same amendment. The authenticated app footer's own separate "Upload Troubleshooting" link, and the top-level "Upload Guides" nav link, were explicitly untouched.

**Confirmed non-defects — no action taken, preserve so these are never rediscovered as gaps:**
- **RC-5 (repeated-research incremental evidence):** the Eastern Propane case (three manual research runs, more evidence found each time) traces to genuine live-search-index variance (Serper/Google returning different results for an identical, fully deterministic query set over time), not insufficient first-pass depth or a coverage bug. The existing autonomous weekly monitoring cadence already re-researches accounts on a recurring cycle, substantially covering this. Worth remembering: each manual re-research is a real research spend, not free.
- **RC-6 (public Security/Data Security page claims):** reviewed and confirmed already accurate and appropriately conservative — explicitly disclaims SOC 2/HIPAA/enterprise certifications rather than overclaiming; verified against the real codebase (zero service-role/secret keys in client-served files; auth is proxied server-side). One minor, non-urgent nuance: "request deletion of your data" is only partially automated today (single-account/list self-serve delete works; full account/PII erasure likely still needs the listed support email) — normal for an early-stage product, not misleading as currently worded.

**Founder determination (2026-08-20) — House Accounts is cleared for active selling.** Product development continues in parallel with real customer evidence driving prioritization, not as a precondition. Do not reopen this remediation slice or re-run another full smoke-test triage absent a new, specific, confirmed issue.

**Founder smoke-test B/C-classified observations — preserved as backlog/polish, not implemented in this slice (documentation only; do not build any of this without separate founder scoping):**
- **Beta positioning / messaging coherence** — **SHIPPED, do not reopen.** Delivered by the New-Customer Readiness / Beta Language pass (see "Recently completed" above): Beta banner removed, welcome modal rewritten, Settings/Feedback & Support/What's New copy corrected, feedback email subject fixed.
- **Broader FAQ content overhaul** (audience framing beyond the one corrected multi-list claim; "why House Accounts vs. ChatGPT/Claude" framing — ties to "Website / positioning / commercialization" above; documenting notification settings in FAQ) — explicitly deferred per the founder's own PASS note: *"The broader FAQ/content overhaul remains deferred backlog work."*
- **Reduce AI-ish em-dash/prose cadence in copy** — a real prose-quality note, not yet scoped.
- **Feedback/Support footer and support instructions read as overly technical** for a non-technical rep — small, safe copy-level fix, not yet scoped.
- **Request-a-Demo/calendar-link CTA placement** on Pricing/public site — placement assessment only; ties to "Demo Booking + Guided Customer Activation" (LATER), which already forbids building scheduling infrastructure now.
- **Stronger "Why House Accounts" / founder story** on public and authenticated nav, and legitimate customer-success proof placement — **SHIPPED, do not reopen.** Delivered by Commercial Credibility V1 (see "Recently completed" above): a dedicated Why House Accounts page in permanent top-level nav, and Real-World Results as the canonical proof destination carrying three confirmed-real, anonymized founder field results. See the updated "Customer proof / stories" (LATER) for the continuing distinction between these founder field results and future independent customer case studies.
- **My View vs. Team View unclear to a newly signed-up owner** — real Day-1 confusion point; smallest fix framed by the founder as a label/tooltip, not a redesign, if picked up.
- **What's New page reads stale** — visible staleness reads as product neglect to a paying customer; update-vs-hide is a judgment call, not yet scoped.
- **First-use empty "This Week" can hide meaningful Month/Quarter/Year intelligence** — an activation-quality insight to investigate subtly, not a confirmed defect; explicitly excluded from this slice (no first-value timebox highlighting work was done here).
- **Overall score + Revenue/Recency bars unclear/not obviously actionable** — reasonable UX candidate; needs verification that presentation-only removal/rework is safe before any change; explicitly excluded from this slice (no score/revenue/recency changes were made).
- **Contextual education for Account Intelligence/Dashboard/Whitespace** — already substantially covered by "Onboarding/upload polish"'s general contextual-education principle and the Whitespace guided-education item under "Account Expansion / Whitespace Intelligence / Growth Map — remaining work" (both already recorded); this reinforces rather than duplicates.
- **Manual research queueing** (multiple accounts without babysitting) — already recorded under "Manual research queue" (DEFER); reinforced, not new.
- **List-hygiene assistance** after multiple similar CSV uploads — new backlog-worthy insight; explicitly no autonomous deletion of a rep's lists if ever picked up.
- **In-workflow domain add/correction** (explain why a missing company domain matters; let a rep add/correct it directly from the account workflow, not just at upload) — ties to "Company Website" (NOW); the in-workflow-correction angle is a genuinely new nuance on top of that existing entry.
- **Category Expansion cards feel repetitive, don't explain why the relationship is ripe now** — ties to the existing Slice 3 stricter-generation-logic item under "Account Expansion / Whitespace Intelligence / Growth Map — remaining work" (NEXT); reconcile there rather than a template patch.
- **Repeat Buying Pattern reasoning/copy trails Business Signal intelligence quality** — new product-intelligence-quality backlog insight, not yet scoped.
- **Hypothesis: let a rep manually promote secondary/lower-confidence evidence to a rep-initiated Prepare for Call**, without House Accounts itself upgrading it to a verified Reason to Reach Out — doctrine-adjacent; would need careful framing to preserve the Signal ≠ Reason-to-Reach-Out boundary. Explicitly excluded from this slice.
- **Implementation-facing copy** ("Account-wide purchases not fully attributed...") reads more like internal engineering language than rep-facing copy — small future copy fix.
- **Allow assigning existing unassigned/uncategorized contacts to a Buying Center relationship** — real, scoped enhancement to Relationship Footprint; loosely adjacent to "Contact intelligence" (SOON).
- **Newly Detected / Saved Signals summary metrics invite click-through** that doesn't currently exist — UX enhancement backlog; explicitly excluded from this slice (no Dashboard metric click-through work was done here).
- **Show the date/time an outreach was recorded** — a real enhancement distinct from RC-2's refresh-gap fix above; explicitly flagged as separate during that fix's own investigation, preserved here rather than folded in.
- **Prepare for Call readability; whether Account History and Account Context sections are duplicative** — worth investigating structure later, not scoped or approved work yet; explicitly excluded from this slice (no Prepare for Call redesign was done here).

Doctrine-confirmation notes from the same smoke test (Active Expansion V1 eligibility causing confusion during the test; existing-account evidence vs. broader future-prospecting context; the Monitor & Grow → Find More Like Them → Prospecting long-term sequencing) reaffirmed existing, already-banked doctrine with no changes needed — not repeated here, no BACKLOG action required.

### New-Customer Readiness / Beta Language — COMPLETED / FOUNDER-PASSED / LIVE IN PRODUCTION (2026-08-21)

**Status: BANKED.** A narrow New-Customer Readiness lane, established after House Accounts began active selling to prospects and customers, deliberately kept separate from general backlog development. Implemented and founder-approved on Preview, merged to `main`, and independently verified live in Production. Main commit `588c530b1d3364e8c3d6d3798758610e35f74677`. Production deployment `dpl_9mh38kpiwZhEr2Ro4Zx5okzQ29Da` (READY). Merged-`main` suite: 174/174.

**Shipped:**
- Beta banner removed from customer-facing surfaces.
- Welcome modal copy rewritten for new customers rather than beta testers.
- Settings, Feedback & Support, and What's New copy corrected to match commercial (non-beta) positioning.
- Feedback email subject line corrected.
- Hall of Accounts testimonial addressed under an explicit provenance-verification instruction (use only if genuine, anonymized; remove rather than imply customer proof otherwise) — Hall of Accounts was subsequently retired entirely by Commercial Credibility V1 below.

**Resolves, cross-referenced above:** "Beta positioning / messaging coherence" under the Release-Candidate Remediation Slice's B/C-classified observations (now marked SHIPPED there).

### Commercial Credibility V1 — COMPLETED / FOUNDER-PASSED / LIVE IN PRODUCTION (2026-08-21)

**Status: BANKED.** Founder-approved commercial site-credibility slice, implemented and click-tested on Preview (9-point founder QA pass), merged to `main`, and independently verified live in Production. Main commit `e4f362068bc3660d1ff8aa190810ac432b6c691c`. Production deployment `dpl_8jd943hRjQfyydXkvz3u5GpT6bRN` (READY). Merged-`main` suite: 176/176. Founder Preview QA: PASS.

**Shipped:**
- New Why House Accounts page (`why-house-accounts.html`) is live — a practitioner/founder story: firsthand experience building and managing a promotional-products book → learning which account-management behaviors actually matter → those behaviors becoming difficult to sustain manually across an entire book, and harder still across a team → House Accounts built to make that level of account awareness repeatable. (Public positioning as amended by Founder Narrative Correction V1 — see amendment note below.)
- Site remains product-first; the homepage received only a compact Why + proof bridge, not a rewrite.
- Real-World Results (`real-world-results.html`, renamed from `success-stories.html`) is now the canonical proof destination.
- Three confirmed-real, anonymized founder field results are represented: Timing Confirmed — Regional Manufacturing Company / seasonal buying pattern; Meeting Scheduled — Regional Automotive Dealership / community-event signal; Order Won — Regional Healthcare Practice / milestone anniversary / $1,000 order.
- These are explicitly presented as field results, not falsely presented as three independent House Accounts customer case studies — see the updated "Customer proof / stories" (LATER) for the preserved distinction from future, genuinely independent customer case studies.
- Hall of Accounts concept/name retired; the old URLs (`/hall-of-accounts.html` and `/hall-of-accounts`) redirect to Real-World Results (`vercel.json`).
- Permanent top-level commercial navigation: Why House Accounts, Real-World Results, Pricing — a single shared `COMMERCIAL_LINKS` list in `site-header.js`, spread into both signed-out and signed-in nav ("pages have a home and they stay there" doctrine).
- Signed-out header simplified: FAQ, Security, and Feedback moved to secondary/footer locations.
- Upload Guides moved from authenticated primary nav into Help.
- Product Tour updated to teach the new permanent Upload Guides location via Help (spotlights `#haHelpToggle` rather than programmatically opening the dropdown).

**Explicitly not built / do not overstate:**
- Dashboard/product shell was not redesigned.
- The three shipped Real-World Results stories are founder field results, not independent customer case studies — do not present them as customer testimonials.
- The "vs. ChatGPT / Claude" comparative positioning and the Behavioral-Learning-gated stronger messaging claim remain open — see "Website / positioning / commercialization" (LATER).

**Resolves, cross-referenced above:** "Stronger 'Why House Accounts' / founder story... and legitimate customer-success proof placement" under the Release-Candidate Remediation Slice's B/C-classified observations (now marked SHIPPED there).

**Amendment — Founder Narrative Correction V1 — FOUNDER-PASSED / LIVE IN PRODUCTION (2026-08-21).** The Why House Accounts page's original launch copy used the founder's personal $0→$1M sales-book milestone ("entered the industry with no prior experience and grew a book of business from roughly $0 to $1M") as the public positioning centerpiece. Founder determination: that framing is factually true but risks narrowing House Accounts into "software based on how one rep got to $1M" — not the intended story. Corrected on Preview (deployment `dpl_8HAL2vft4Q1PMJjpNC4dQD4v3Ary`, READY), founder-approved, merged to `main` at `fa71043e2e39a5afbaaa1fdf66c91b008ebf50fe` (Production deployment `dpl_V3Gu8JbuGoeeCPg6y1kcgobw9RVq`, READY; merged-`main` suite 176/176). The subsequent documentation-only commit `460b0e76e7c80aaf38c38685ba28540783eca25b` deployed to Production as `dpl_46i8tNnCwzqugVrvkMLX1pNBECHN`, READY. The public story is now: firsthand experience → learning which account-management behaviors actually matter → those behaviors not scaling manually across an entire book or team → House Accounts built to make that level of account awareness repeatable — reflected in the Shipped bullet above, superseding the original wording (this record, not the earlier commit description, is authoritative going forward). Also corrected: "One rep can do this. A team can't — not consistently." overstated what a single rep can realistically sustain; replaced with "Great reps can do this. They just can't do it for every account," making clear a rep can sustain that awareness for a handful of important accounts, not an entire book. **The $0→$1M milestone remains a true historical fact, preserved here and usable in direct founder-led sales conversations, interviews/podcasts, and internal documentation — it must not be reintroduced as public website positioning without a new, separate founder decision.**

**Founder determination — product-development operating state (2026-08-21).** House Accounts is now commercially presentable and cleared for active selling. We are intentionally not selecting another proactive backlog sprint. Near-term founder priority is: sales outreach → demos → onboarding → usage observation → customer feedback → evidence-driven product decisions. Product work should resume when driven by: confirmed production defects; meaningful activation/trust friction; repeated customer evidence; revenue/deal blockers; clear market pull. BACKLOG remains a warehouse of hypotheses/future work, not an active to-do queue.

---

### Signal-Grounding Trust Correction: Social-Source Identity Rule (Eliot Veterinary Hospital / HARTPETS) — COMPLETED / FOUNDER-PASSED / LIVE IN PRODUCTION (2026-08-22)

**Status: BANKED.** Founder QA: PASS (Preview `dpl_DDkKurYGrUbVFmM2ENTTDeYKqmK6`, independently verified READY). Merged to `main` at `86062aa9200d8f63f74bdd95b5663858022f5999`. Production deployment `dpl_3jTo5RXSYLMMkaoMR3yeQojQ5wZ2` (READY, independently verified). Merged-`main` suite: 176/176.

**Surfaced by:** the Firecrawl `/search` shadow-evaluation run above — Path A output surfaced a signal for account "Eliot Veterinary Hospital" sourced from `facebook.com/HartPets`, independently verified by the founder to be Hartz's own official Facebook presence (a pet-products brand) — a **confirmed wrong-entity acceptance**, not a namesake/franchise-confusion edge case. The founder rejected relying on downstream dashboard `secondary` visibility as sufficient mitigation: the evidence itself was not valid evidence about the target account, so the correction had to be made at the identity-grounding layer, not the display layer.

**Root cause:** `verifyCandidateCompanyGrounding()` (`api/signal-intelligence.js`) grants `'unconfirmed'` (a visible, persisted Business Signal) to any multi-word bare company-name match with zero independent corroboration, provided there is no location contradiction — with no distinction for whether the source itself is a social profile/post. Unlike a news outlet or publisher, a social account carries no identity claim independent of the text it contains, so a bare name mention on an unrelated account was enough to pass.

**Correction (bounded, social-source-specific):** in the exact branch that previously returned `'unconfirmed'` for a multi-word bare-name match with no corroboration, a candidate sourced from a social URL (`isSocialUrl()`) is now rejected outright unless it carries at least one real identity anchor — reusing the same four-anchor set that already overrides the location-contradiction veto elsewhere in the same function: `domainCorroborated`, `knownSocialProfileMatch`, `selfDomainCorroborated`, `exactSocialHandleCorroborated`. No new identity-matching framework — the existing primitives (`isSocialUrl()`, `accountKnownSocialProfileMatch()`, `isExactSelfSocialHandleMatch()`, `socialProfileMatchesCompany()`) were already present and already wired in; only the missing branch check was added.

**Ordinary third-party news/local-publication behavior unchanged.** The correction fires only when the candidate's source URL is a social profile/post domain (`linkedin.com`, `facebook.com`, `instagram.com`, `x.com`/`twitter.com`) — a bare multi-word company mention on an ordinary news or local-publication page still grades `'unconfirmed'` exactly as before.

**Regression coverage added** (`scripts/test-signal-account-evidence-grounding.js`): (1) an unrelated Facebook/Hartz-style account + bare mention of "Eliot Veterinary Hospital" → rejected, never visible — the actual reproduced defect; (2) the account's own exact compacted Facebook handle, and separately a known official profile on file, both posting about themselves → remain eligible, confirmed; (3) a legitimate third-party local-news article with a multi-word company mention → unchanged, still `'unconfirmed'`; (4) the existing namesake/location-contradiction safeguard (an unrelated same-name business in a genuinely different city, sourced from an ordinary non-social page) → still rejects exactly as before, unaffected by this correction. One pre-existing test (the Dover Honda ambiguous-social-handle case) was updated from its prior `'unconfirmed'` expectation to `'rejected'` — it was the identical failure shape now fixed, not a new scenario.

**Companion recon findings from the same run, resolved separately:** Avidia Bank's single-location-model grounding false-negative — see "Signal-grounding trust correction: single-location account model can reject legitimate multi-location coverage (Avidia Bank)" under LATER — banked as a known architectural limitation, explicitly not implemented (no guard loosening, no multi-location architecture added from one case).

---

## NOW — Activation & launch quality

Bounded, near-term work that directly completes or polishes what's already live. Ship before or alongside Production monitoring/notification activation.

### Notification Deep Links / Actionable Re-entry (remainder)

**Priority: High — near-term.**

**Status:** partially built. The outreach-prompt half ("Tell us how it went →" → the specific unresolved outreach) shipped in Notification & Outcome Loop V1, Part A3 (2026-08-16) — see "Recently completed" above.

**Remaining scope:** the intelligence-item half — clicking a specific "New Intelligence" line in an email should land the rep on that exact signal/opportunity (e.g. auto-opening its Prepare for Call), not just the general dashboard.

**Why not built yet:** investigated in the same sprint. The outreach panel is one small, self-contained fetch-then-render function, which is what made its deep link safely bounded. The priorities feed a signal-level deep link needs to target is a much larger, async, collapsing/deduping render pipeline (`renderWeeklyPrioritiesFeed()` and its supporting dedup/collapse logic) where the exact same signal may no longer render as a distinct card by the time a rep opens an email days later (superseded, marked useful/not-useful, collapsed into a duplicate group, etc.). Building this safely needs real handling for "target no longer exists" plus a wait-for-async-render mechanism — genuinely new client-side logic, not a small reuse of an existing mechanism like the outreach case was.

**What to build when picked up:** a stable per-signal identifier (`eventFingerprint` + `accountName`, the same composite key `/api/signal-events` read-back already uses) passed as a query param; on dashboard load, once the priorities feed has rendered, locate the matching card and either scroll to it or open Prepare for Call directly; gracefully do nothing (land on a normal working dashboard) if the target can't be found. Preserve the existing `next=/dashboard/...` auth-return flow for logged-out clicks — do not invent new auth/session handling.

### Company Website — strongly recommended CSV/onboarding field

**Surfaced by:** Monitoring Identity V1 (Phase 2C grounding-policy investigation, 2026-08-15). Reconciled against the founder's 2026-08-16 backlog inventory — same item, no material change to scope.

**Problem:** `api/save-upload.js` has no website/domain column mapping at all today. Of the accounts monitored in production, only one has an uploaded website; the rest either have no usable identity anchor or fall back to a contact-email business domain, which is a weaker, less direct signal (see `api/lib/monitoring-identity.js`'s resolution order). Company website/domain is not merely optional metadata — it is the strongest automatic anchor for `resolveTargetIdentity()`, and better identity input directly improves signal quality (more monitoring targets reach `derived` status, more grounded signals reach `priority` instead of sitting in `secondary`/Research Details), and reduces namesake-company identity mistakes.

**What to build:**
- Support a standard `Website` / `Company Website` CSV column in the upload/import mapping (`api/save-upload.js`) if that mapping does not already exist.
- Label it **Strongly recommended**, not required — never block upload when it's missing.
- Explain the product benefit in plain language at the point of collection. Suggested copy:

  > **Company Website — strongly recommended**
  > Including a company website helps House Accounts identify the correct business online and deliver more accurate, higher-confidence signals.

- Consider including the field prominently in the recommended CSV template/example.

**Product framing:**
- Best case: customer supplies a website → strongest automatic identity anchor (`identity_domain_source = 'uploaded-website'`).
- Fallback: no website → House Accounts derives identity from a unique non-free-mail business-domain contact email when safely possible (`'contact-derived'`).
- Still unresolved: House Accounts continues researching, but uncertain results remain `secondary` (visible to the rep, framed as uncertain) rather than being promoted to `priority`.

**Scope note:** UI/onboarding work only — no backend identity-resolution logic changes needed; `resolveTargetIdentity()` already prioritizes an uploaded website over contact-derived domains and will pick this up automatically once the field exists.

### Repeated unresolved outreach grouping

**Surfaced by:** live Preview QA of Notification & Outcome Loop V1 (2026-08-16) — the "Albany International" case: four genuinely distinct, real `outreach_made` events (confirmed via direct Supabase read, not a rendering bug) produced four separate near-identical rows in the dashboard's unresolved-outreach panel and would produce four separate email prompts.

**Not a bug:** each row is a real, distinct outreach attempt; the "Save outreach" flow already has proper double-submit protection, so this reflects genuinely repeated manual logging, not a defect.

**Idea for later, not built:** group several open outreach attempts to the *same account* into one line in both the dashboard panel and the notification digest, e.g. `4 open outreach attempts to Albany International`, rather than repeating the "how did it go?" prompt once per attempt. Do not erase or collapse the underlying event history — `ha_signal_events` stays append-only; this is presentation-only grouping.

### Monitoring Economics founder telemetry

**Surfaced by:** founder backlog reconciliation (2026-08-16), consolidating cost-guardrail context that has accumulated across the Phase 2D (concurrency/vendor-rate safety) and Production activation recon work.

**What to build:** a small founder/admin-only view exposing:
- scans attempted vs. successful;
- average/median research cost per account;
- 7-day and 30-day monitoring COGS;
- projected monthly cost;
- outcome breakdown (complete / degraded / insufficient);
- runtime;
- provider usage;
- Research COGS ÷ subscription revenue.

**Guardrails to keep documented alongside this view (do not silently drop these numbers when building it):**
- historic baseline approximately 1.645¢ per attempted account;
- ≤1.5¢ is good for production;
- ~1.0–1.2¢ is excellent at scale;
- investigate any sustained period above 2¢;
- pricing concern begins around ~3¢+;
- Research COGS under 10% of subscription revenue is healthy; 5–8% is preferred.

**Do not optimize from tiny samples** — this view is for trend visibility, not a trigger for reactive tuning off small statistical noise.

---

## NEXT — Compounding product intelligence

Work that makes House Accounts' recommendations get better over time, not just visible. Build in this order — the second item explicitly depends on the first.

**Current priority framing (updated 2026-08-18 after the Account Expansion / Find More Like Them product reframe):** 1) real Beta usage / selling; 2) adoption-critical integrations where demand is proven; 3) Account Expansion / Whitespace Intelligence remaining work (Slice 1 shipped — see Recently completed above) — reuses the existing account/order/contact foundation, no Behavioral Learning dependency; 4) selected seller-UX correctness fixes driven by observed friction; 5) Behavioral Learning V1 remaining work (notification-learning wiring, richer dimensions), once meaningful Beta usage has accumulated; 6) Manager Intelligence / team reporting, once enough behavior/outcome data exists; 7) Find More Like Them / Lookalike Expansion (see LATER), sequenced behind Account Expansion. Not a permanent frozen order. Older cleanup/hardening ideas still do not displace real Beta usage/selling unless they represent a genuine sell-the-product blocker.

### Account Expansion / Whitespace Intelligence / Growth Map — remaining work

**Priority: near-term.** The Buying Center × Offering matrix, cell-level confirm/correct, and the Relationship Footprint / multi-contact layer are all banked and live in Production — see "Account Expansion / Whitespace Intelligence — Buying Center × Offering Matrix" and "Relationship Footprint + Multi-Contact / Contact Durability V1" under Recently completed above. Slice 3 (below) is the active next workstream. No Behavioral Learning dependency — this track reuses the existing contact/order/category foundation directly.

**CRM boundary (standing constraint on all future slices):** House Accounts answers "where can I grow this account," never "what happened and when." No activity/call logging, deal/pipeline stages, task/reminder management, email history/sync, or custom-field CRM configuration. The whitespace grid must stay a derived, evidence-backed inference with rep correction — never a form a rep is expected to keep up to date from memory.

**Shipped, no longer remaining:** cell-level confirm/correct (Covered / Whitespace / Not applicable) — the second, real condition of the V1 Covered truth rule — shipped and is banked; see "Relationship Footprint + Multi-Contact / Contact Durability V1" under Recently completed above. A cell can now render Covered in Production via a genuine rep answer, not only a future per-offering source field. **Active Expansion Plays V1 is also now shipped and banked** (see its own entry under Recently completed above) — a real, grounded, three-condition-gated expansion recommendation now exists in Production, as a new dedicated `computeActiveExpansionPlays()` panel alongside the matrix.

**Remaining scope, sequenced:**
- **Slice 3 — rework Relationship Expansion opportunity generation.** Still open, distinct from Active Expansion Plays V1 above — that shipped as a new, separate, strictly-gated panel; it did not touch or rework `generateFutureOpportunities()`'s existing industry-template gate (`if(industry === 'Automotive...') if(cats.has('Apparel'))...`), which still stands as a standalone trigger for the pre-existing Relationship Expansion opportunity type. Today's `generateFutureOpportunities()` industry-template gate must stop being a standalone trigger. A recommended expansion play requires an evidence-backed whitespace cell (non-confirmed-absent) PLUS at least one grounded commercial trigger — a real public signal, a detected recurring/program pattern (`findRepeatPatternGroups()`), or a rep-supplied introduction path (`suggestedIntroductionPath()`). An industry template alone becomes necessary-but-not-sufficient, never sufficient by itself. This touches live, revenue-relevant opportunity-generation logic with existing test dependencies — the highest-risk slice, do carefully with a full regression pass.
- **Location/subsidiary/division whitespace** — explicitly deferred. Current data (a flat city/state string) cannot support this dimension truthfully; would need richer CSV input or a live integration (see Integrations) before it's worth building.
- **Whitespace Intelligence first-use / guided education** — surfaced by founder observation (2026-08-19), after Active Expansion Plays V1 banked; preserved here (moved from the now-banked Product Cohesion V1 entry under Recently completed) rather than implemented. Many users may never have used a formal whitespace/account-mapping document before. The product may be functionally correct while still leaving a new user asking "what am I supposed to do with this grid?" Direction to evaluate when this is picked up: a lightweight contextual explanation of what Whitespace Intelligence is for (first-use guidance, not a documentation burden); explain the simple workflow — *map who you know → mark what you sell → identify gaps → House Accounts watches for the right time to expand*; potentially contextual "How this works" affordances, empty-state guidance, or onboarding cues; the demo/setup-call flow (see "Demo Booking + Guided Customer Activation" under LATER) should also teach this workflow. **Do not implement now.**
- Rep confirmations should eventually feed the existing private org-scoped Behavioral Learning event foundation's *pattern* (not necessarily its literal table) — a confirm/correct action is structurally similar to the quality-feedback events `org-preference-learning.js` already consumes.

### Behavioral Learning V1 — remaining work (notification wiring, richer dimensions)

**Priority: deliberately paused, not high.** The dashboard-ranking foundation is shipped and banked — see "Behavioral Learning V1 — Dashboard Foundation" under Recently completed above for exactly what exists today. **Founder sequencing decision (2026-08-17): do not begin notification-learning wiring or any of the items below until real Beta usage has accumulated meaningful evidence.** This is an explicit pause, not a forgotten dependency — do not resume it absent that evidence or a specific founder decision to do so.

**Two distinct kinds of evidence this system keeps separate, not collapsed into one signal** — already encoded in the shipped dashboard foundation and equally applicable to any future notification wiring: direct signal-quality feedback (`signal_useful`/`signal_not_useful`, a rep's judgment on the *signal itself*) vs. outcome evidence (`outreach_made`/`opportunity_outreach_made` → `outcome_reported`, what happened *after a rep acted*). A signal can be good and never acted on; a rep can act on a good signal and get no response. Do not blend these into one score — see `api/lib/org-preference-learning.js` for the live implementation of this separation.

**Organization-level learning before rep-level personalization** — the shipped foundation models how an *organization* wins, not individual reps. Rep-level personalization remains a later refinement, not assumed as the next step, unless a future reconciliation says otherwise.

**Remaining scope, once resumed (do not build ahead of the founder sequencing decision above):**
- **Notification-learning wiring** — have `api/notification-scheduler.js`'s digest ordering consume the same `computeOrgSignalPreferences()` primitive the dashboard already uses, rather than inventing a second ranking notion.
- **Richer learning dimensions** — beyond the three current families (`FOLLOW_UP`/`REPEAT_PATTERN`/`BUSINESS_ACTIVITY`), once real usage shows the pooled `BUSINESS_ACTIVITY` bucket is too coarse to be commercially useful.
- **Rep-level personalization**, once the organization-level foundation has real signal to build on.
- **Manager-learning views** — see "Manager intelligence / organizational insights" below, which depends on this.
- **Global cross-customer learning (Layer A)** — a separate module from the private org layer; not started, not scoped yet. See the two-layer doctrine note under the Dashboard Foundation entry above.

Do not build a parallel opportunity-scoring system alongside any of this — it belongs inside this same data model and weighting design, not a separate scoring project.

### Manager intelligence / organizational insights

**Depends on:** Behavioral Learning V1's remaining work above (richer dimensions, real accumulated evidence) — do not build as a separate analytics feature ahead of or instead of that foundation. Also sequenced behind real Beta usage and adoption-critical integrations (see the current priority framing above) — the dashboard-ranking foundation shipping does not itself unblock this; meaningful behavioral data actually needs to accumulate first.

**Surfaced by:** founder backlog reconciliation (2026-08-16); reconciled again (2026-08-16) against older printed roadmap notes describing rep activity/follow-up visibility, opportunities being worked, meetings, quotes, wins, revenue, adoption by rep, ignored/aging opportunities, team-level ROI, and executive summaries — folded into this single entry rather than becoming a separate project.

**Eventual scope:** once Behavioral Learning V1 exists, allow managers to see patterns such as: which signal types reps actually act on; which signals lead to real engagement/progress; what top-performing reps do differently; team opportunity coverage; account risk/neglect (accounts nobody is reaching out to); rep activity and follow-up visibility; opportunities currently being worked; adoption by rep; ignored/aging opportunities; team-level ROI and executive-summary views. This should be a natural view built on top of Behavioral Learning's data model, not a bespoke analytics feature built in parallel to it.

**Explicitly not a CRM:** House Accounts is not becoming a full CRM (no generic meeting/quote/win/revenue tracking system of its own) — any of the above that requires data House Accounts doesn't already capture stays out of scope until there's a specific, evidence-backed reason to capture it.

**Permission role vs. selling role stay separate** — see "Manager/team workflow" under SOON below, which already establishes this distinction; do not conflate the two here either.

---

## SOON — Adoption & workflow

Work that grows and organizes who uses House Accounts and how, once the core intelligence loop is solid. Not blocking near-term activation.

### Account identity / duplicate hygiene

Keep distinct from Monitoring Identity V1, which is already banked (`a5abea8`) — do not reopen that classifier absent a confirmed real-user failure. These are the remaining, explicitly out-of-scope-for-V1 hygiene items.

**Architectural lesson to preserve:** account name alone is not globally safe identity in an aggregate, multi-upload workspace — Monitoring Identity V1 has already hardened target-side identity resolution substantially (domain-based anchors, corroborator tiers); the items below are the remaining name-only/aggregate-matching paths that lesson doesn't yet cover, not a reason to redo the work already banked.

**Related, unverified — public-article duplication under Additional Opportunities:** an older note claimed related public articles could still duplicate under the "Additional Opportunities" surface (`additionalOpportunitiesFor()`, `dashboard/index.html`). Substantial same-account/clean-persisted-opportunity dedup work already exists in that code path (see its own inline comments), and the general "duplicate primary/additional opportunity bug" is already banked — but this narrower related-public-article case hasn't been specifically re-verified against current code. **NEEDS EVIDENCE** — reproduce against a real account with multiple related public articles before treating as a live bug; do not let this become a roadmap driver either way.

**Cross-target identity diagnostic (data-quality signal, not a policy change)**

*Surfaced by:* Monitoring Identity V1 backfill audit (2026-08-15) — the "Insurcomm Restoration Group" / "Rytech Resoration" case.

*Finding:* Of 32 real (non-fixture) contact-derived identities in the production backfill, exactly one collided: two distinctly-named monitoring targets for the same user — "Insurcomm Restoration Group" and "Rytech Resoration" — both derived `insurcomm.com` because both accounts' only contact on file is the same person (`awelsh@insurcomm.com`), most likely a shared account manager/channel contact rather than each company's own domain. The derived domain has no lexical relationship to "Rytech" at all, unlike every other case in the dataset. This is the only target in 88 that trips either flag below.

*Decision (2026-08-15):* contact-derived business domain remains a Strong corroborator under the existing safeguards (free-mail exclusion, per-target uniqueness). This single edge case does not justify adding new restrictions — do not build a policy change from it.

*Idea for later, not built:* a read-only diagnostic (not an auto-demotion) that flags, for a rep's/founder's attention:
- the same derived domain attached to two or more distinctly-named monitoring targets for the same user, and/or
- a derived domain with no lexical relationship to the account's own name.

Either condition alone would have caught the Insurcomm/Rytech case; neither is close to tripping on any other current target. Cheap to add later if this pattern recurs; not worth building against a single occurrence today.

**Duplicate monitoring target: "L.L. Bean" vs "L.L.Bean"**

*Surfaced by:* Monitoring Identity V1 backfill audit (2026-08-15).

*Finding:* Two separate `ha_monitoring_targets` rows exist for what is almost certainly the same real company, from two different uploads: "L.L. Bean" (with a space; has an explicit uploaded website, `identity_domain_source = 'uploaded-website'` → `llbean.com`) and "L.L.Bean" (no space; no website, no usable contact domain, `unresolved`). This is a canonical-identity/account-hygiene issue — normalized-company-name matching (`normalizeCompanyName()`) doesn't currently collapse "L.L. Bean" and "L.L.Bean" into the same target.

*Explicitly out of scope for Monitoring Identity V1* — this is account-level deduplication/canonical-identity work, not target-identity resolution. Logged here, not touched. Do not merge or delete either row without deliberate, separate account-hygiene work.

**Broader hygiene work (not yet started, added 2026-08-16 reconciliation):**
- Canonical, durable account identity across re-uploads and naming variants, longer-term — the general case the L.L. Bean pair is one instance of.
- Duplicate-account reconciliation more broadly (beyond the one known pair above).
- Exact-name duplicate defenses where appropriate, at upload/import time.
- Normalized-name collisions should remain cautious/visible rather than silently auto-unified — a false merge is worse than a visible duplicate.
- Rep-confirmed identity, eventually — letting a rep explicitly assert "these are the same company" as a strong signal, rather than only inferring it automatically.

### Integrations

**Adoption-critical, based on real Beta feedback (near-term within this tier):** Commonsku, Facilis, Antera. Older guidance to "wait for more demand" before prioritizing specific integrations is now stale for these three specifically — current Beta usage has made them adoption-critical, not merely requested.

**Longer-term / broader, no proven demand yet:** Salesforce, HubSpot, Essent, Pipedrive, and others — revisit if customer demand changes.

**Desired long-term model:** continuous synchronization with the source system, not repeated manual CSV exports — the eventual integration shape to design toward, not a one-time import connector.

CSV remains the current Beta path and should stay fully supported — do not turn the first sale of any single integration into a hard requirement for adoption generally.

### Opportunity lifecycle / snoozing / repetition control

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16 against current event/outcome semantics.

**Already shipped — do not reopen:** "mark contacted"/outreach logging, outcome/result states (`engaged`/`progressed`/`went_nowhere`/`no_response_yet`), and unresolved-follow-up tracking are all live via Notification & Outcome Loop V1 (`ha_signal_events`, the unresolved-outreach panel, `api/lib/outcome-prompts.js`).

**Genuinely still missing, merged into this one entry rather than a mini-CRM of separate features:**
- Snooze an opportunity/signal until a chosen date.
- Dismiss with a reason, or mark "no longer relevant" (distinct from an outcome report — this is a rep saying the item itself isn't worth surfacing again, not reporting what happened after outreach).
- Resurfacing rules for a snoozed/dismissed item.
- Suppressing repetitive resurfacing of essentially the same actionable item (e.g. a reorder/follow-up opportunity) after a rep has already acted on, dismissed, or resolved it — the current terminal-outcome logic stops the *automatic outcome-prompt nag* for a specific outreach, but does not confirm whether the underlying signal/opportunity itself is prevented from re-entering the priorities feed or a future notification digest as if it were new. **Needs verification against current dedup/eligibility logic before scoping further** — if it turns out already handled, drop this bullet.

Reconciles the older, now-architecturally-obsolete "reorder opportunities may repeat in multiple weekly digests" note (the weekly-digest architecture it referred to no longer exists) into the same real, still-open question above: can essentially the same opportunity repeatedly re-enter *any* current proactive surface (priorities feed or notification digest) after a rep has already acted on it.

**Explicitly do not build a full opportunity-management CRM layer** — this is bounded lifecycle/resurfacing control on top of the existing priority/secondary eligibility policy, not a parallel task-management system.

### Contact intelligence

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16.

**Classification: DEFER / NEEDS EVIDENCE.** Do not elevate to a near-term build absent Beta feedback specifically showing "who do I contact?" is a bigger obstacle than "why should I contact them?" — the current product's core value is squarely the latter.

**Already partially covered — do not duplicate:** deterministic department/contact suggestion (`suggestedContact`/`recommendedBuyingTeam`/`likelyBuyers`) already flows into recommendations and Prepare for Call today, and uploaded contacts already reach the research prompt (`knownContacts`).

**Genuinely new, if this ever gets picked up:** inferring a likely decision-maker when no contact was uploaded at all; contact-role confidence scoring; relationship history (who the rep has contacted before, whether that person replied); identifying internal champions; signal-specific contact suggestions (which contact fits *this particular* signal, not just the account generally).

### Truthful research-result states — remaining correctness gaps

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16 against current code.

**Already shipped — do not reopen:** "View Research" only renders when `signalCount > 0` (the Manage Customer Accounts panel already gates on this — see its own "Beta correction" comment); a genuinely empty research result is already distinguished from "not yet researched" in the places this was checked.

**Doctrine to hold going forward (already banked elsewhere, restated here as the standard this item measures against):** distinguish, everywhere a research result is shown — actionable priority opportunity found; valid secondary/non-priority signals found (still real, still worth showing in Research Details — a signal doesn't need a priority opportunity to be legitimate); nothing found (an honest true negative); research failed/retrying. CTA and copy must match the actual state, never imply more or less than what's true.

**Unverified — narrow, possibly-still-open gaps, not confirmed either way:**
- "Recently Researched"'s compact summary count going stale relative to what the underlying research modal actually shows once opened.
- Account-level research-failure/retry messaging clarity.
- List-level OpenAI-timeout messaging being generic/vague rather than a clear, actionable message.

Bounded correctness audit if picked up — verify each bullet against current code before building anything; several research-result-state gaps in this general area have already been fixed (see above), so re-confirm before assuming these three are still open.

### Dashboard card density / information hierarchy

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16.

**Preserve the principle, not stale literal guidance:** a compact priority card should quickly communicate Why Now, current status/timing, the Play, best ideas, a recommended contact, a concise approach, and a Prepare for Call CTA — deeper explanation belongs in Prepare for Call/detail surfaces, not the compact card.

**Do not act on the old literal instruction to remove "Why It Could Grow"** — that field still exists in the current dashboard (`dashboard/index.html`) and there is no current Beta evidence it's causing density problems. Treat this whole entry as Beta-driven UX backlog: revisit if/when real usage shows the compact card is too dense, not as a standing polish sprint.

### Prepare for Call — best-next-question principle

**Surfaced by:** mentor-derived insight, reconciled 2026-08-19. A quality/content principle to hold for Prepare for Call and rep-preparation surfaces generally — not necessarily a standalone feature, and not scoped or approved work.

**Principle to preserve:** House Accounts should help the rep identify the best next question to learn or confirm what actually matters, rather than supplying long scripted talk tracks. "How to Approach" (the suggested-opener line) and Prepare for Call's other content should be judged against this bar going forward — a good approach surfaces the sharpest question to ask, not a script to recite.

**Do not build anything from this now** — hold as a design principle to apply the next time Prepare for Call's content/copy is revisited, not a trigger for new work today.

### Manual research queue

**Classification: DEFER.** Separate from the banked background monitoring Queue (Queue monitoring architecture, Full Beta Cutover) — this is about the *interactive* single/warm-account research flow.

**Current behavior:** requesting research while another run is active for the same uploaded list fails outright ("Another research run is currently active for this uploaded list. Please wait for it to finish." — `dashboard/index.html`, `api/monitoring-lists.js`, `api/save-upload.js`), rather than queuing.

**Desired eventual UX, only if Beta behavior proves this is a real friction point:** requesting research for account A, then B, then C while A is still running queues B and C instead of failing. Must preserve the existing authoritative run lock, the Stop control, bounded execution, and truthful progress reporting — this is additive queuing on top of the existing lock, not a redesign of it.

**Do not build this from the old note alone** — defer until real concurrent-research friction is actually observed in Beta usage.

**Also preserve (2026-08-19 reconciliation) — progress visibility during a single research call, a distinct low/medium-priority UX item from queuing above:** longer-running account research (from Manage Customer Accounts, and from Dashboard/Account Intelligence research actions) should communicate that real work is actually happening rather than leaving the rep with an ambiguous spinner. **Do not implement now** — the release-candidate smoke test and real Beta usage may provide stronger evidence about whether this is actually a friction point worth prioritizing.

### Account Intelligence / account search

**Long-standing product direction:** House Accounts should become the place reps live during outbound and the first stop for researching an existing customer — not just a weekly digest source.

**Eventual scope:** search an existing customer and get a fast Account Brief: what changed; existing customer context; relevant contacts/context where available; reasons to reach out; current sales plays; existing generated intelligence; optional refresh-research action.

**Scope discipline:** start with accounts already present in uploaded customer data. Universal any-company research (research on a company that isn't an existing customer at all) is a separate, later capability — see "Longer-term / older parked ideas" under LATER; do not conflate the two.

### Manager/team workflow

**Principle to preserve:** permission role and selling role are orthogonal. The current app roles (owner/admin/member) are access-control roles, not the eventual selling-role model, and must not be conflated with it.

**Future concepts (not built):** rep / manager / both, as a selling-role concept distinct from the permission role. Manager-only users should eventually receive team intelligence views, not the same giant individual-rep digest a selling rep gets. Outcome prompts belong to the outreach actor (the rep who logged the outreach) — a manager should never be prompted to report an outcome they didn't personally own.

**Explicitly do not build this role model until usage justifies it** — this is a real architectural decision, not a quick add.

### Onboarding/upload polish

Ongoing, not a single deliverable. Keep improving: import clarity; upload troubleshooting; clear CSV language; Company Website guidance (see the NOW entry above); empty-state behavior; first-use experience; Import Guides.

Keep onboarding centered on existing customers, not cold prospecting — matches the current product's own doctrine (see the top of this file).

**General guiding principle (2026-08-19 reconciliation, mentor-derived insight) — reconciles with the Whitespace Intelligence guided-education item under "Account Expansion / Whitespace Intelligence / Growth Map — remaining work" (NEXT), which stays the concrete first case, not a duplicate:** add lightweight contextual education only where real users demonstrate a concept is genuinely unfamiliar or confusing — not speculatively. Prefer progressive/contextual explanation (in-context "how this works" affordances, empty-state guidance) over a broad, upfront product tour.

---

## LATER — Larger systems & strategic bets

Real, worth preserving, but should not outrank NOW/NEXT/SOON for attention. Several of these explicitly depend on Behavioral Learning V1 landing first — do not promote them ahead of that dependency.

### Find More Like Them / Lookalike Expansion — "Companies like the customers you already win with"

**Major strategic wedge — not generic prospecting. Distinct from Account Expansion / Whitespace Intelligence (see NEXT) — that track grows existing accounts; this one finds net-new companies resembling them.** Do not conflate the two names or the two capabilities.

**Sequenced behind Account Expansion / Whitespace Intelligence** (see NEXT) — not because it structurally requires it, but because Account Expansion reuses far more of the existing foundation and directly serves the existing-customer core loop first. Recon (2026-08-17) found the public-signal research/grounding/actionability engine this needs already exists (`research-batch.js`'s `prospect-intelligence` mode, currently feature-flagged off via `MVP_FEATURES.prospectIntelligence`) — the genuinely missing piece is candidate-company discovery, a bounded task, not a rebuild.

**No longer hard-gated on mature Behavioral Learning (corrected 2026-08-17):** Behavioral Learning should make this smarter about *how* an organization wins, as an optional future weighting input — it does not need to be the prerequisite that makes this possible at all. A conservative V1 can seed candidates from existing customer/order/account evidence already in hand (revenue, frequency, recency, category diversity — the same fields `getRelationshipStrength()` already computes) without waiting on Behavioral Learning evidence to clear its threshold.

**Eventual scope:** identify characteristics of successful existing accounts from real order/account data; generate lookalike candidates from that profile (never from an open, rep-uploaded target list — that is Prospecting, stays separate); require every candidate to clear the same identity-grounding gate (`verifyCandidateCompanyGrounding()`) and carry a real, timely, dated reason to engage before ever surfacing — never similarity alone. Deeper research capability belongs here specifically, not in current Core: Hussey-style deep-research depth, business-model mapping, dealer/channel network mapping, campaign/program-level research, multi-signal synthesis across a prospect, and bespoke concept generation.

**Economic discipline:** keep this research economically separate from monitored-customer capacity. The existing `monitoring-capacity.js` guardrail bounds global worker concurrency, not per-org spend — it does not by itself provide economic separation. Customer monitoring subscription tiers must not silently make unlimited large-scale lookalike research free; define a separate research allowance/economic model when this scales (see "Monitoring Economics founder telemetry" under NOW).

**Explicitly separate from and does not unblock Prospecting** (universal any-company research, not customer-similarity-driven) — see "Longer-term / older parked ideas" below. Candidate sourcing here must stay system-generated from the winning-customer profile, never an open rep-uploaded list, or this quietly reopens the door to generic prospecting the product has deliberately stayed closed to.

### Website / positioning / commercialization — "Why House Accounts vs. ChatGPT / Claude?"

**Partially shipped (2026-08-21) — do not reopen the shipped portion.** Commercial Credibility V1 shipped a dedicated Why House Accounts page (practitioner/founder narrative: firsthand experience building and managing a promotional-products book → learning which account-management behaviors actually matter → those behaviors not scaling manually across a book or team → House Accounts built to make that level of account awareness repeatable, per Founder Narrative Correction V1) and permanent top-level commercial navigation (Why House Accounts, Real-World Results, Pricing) — see "Recently completed" above. The founder's personal $0→$1M sales milestone is a true historical fact but is deliberately not the public positioning; do not reintroduce it as website copy. What remains open here is narrower than before: the direct "vs. ChatGPT / Claude" comparative positioning below, and the stronger Behavioral-Learning-driven claim below. Do not re-litigate the shipped founder-story page.

**Depends on:** Behavioral Learning V1 for its strongest claim.

**Future messaging direction:** general assistants wait for prompts; House Accounts is persistent, proactive, account-aware, workflow-native, organization-specific, continuously watching the customer book, and remembers what happened.

**Explicit constraint:** once Behavioral Learning is truly wired, add the stronger claim that House Accounts improves based on how the organization actually wins. **Do not claim behavioral learning publicly before it exists** — this messaging must trail the real capability, never lead it.

**Internal positioning language to preserve (2026-08-19 reconciliation, mentor-derived insight) — working internal language, not necessarily final website copy:** *"House Accounts watches your customers, finds reasons worth reaching out, and helps your reps know where to focus and how to grow the relationship — without trying to do the selling for them."*

### Demo Booking + Guided Customer Activation (future, not built)

**Surfaced by:** founder direction (2026-08-19).

**Direction:**
- Support "Book a Demo" for prospects who want help before purchasing.
- Do not make a demo mandatory for someone ready to self-serve signup/checkout.
- After signup/purchase, strongly prompt "Book Your Setup Call" / onboarding.
- Early onboarding should be founder-led/high-touch so the team can watch customers activate and learn where they struggle.
- Eventual setup flow should help a customer: upload/connect their book; understand Priorities; open Account Intelligence; map relationships/contacts; understand Whitespace Intelligence; act on their first recommendation; understand what ongoing monitoring will do.

**Do not build scheduling/integration infrastructure now.**

**Commercial hypothesis to preserve (2026-08-19 reconciliation, mentor-derived insight) — enriches "founder-led/high-touch" above rather than replacing it:** founder-led onboarding/setup for early customers, using their real customer books, to get them to first value quickly; observe actual product usage and return behavior while doing so; treat the requests/use cases that surface during this hands-on activation as real evidence for future prioritization, not just anecdote. This is about accelerating adoption and learning from real usage — not about bypassing the actual product with manual work standing in for it.

### Proactive Account Plays / Signal-to-Activation Intelligence — future product hypothesis (not started)

**Surfaced by:** founder practitioner insight (2026-08-19), directly after Active Expansion Plays V1 banked. Preserve as a **distinct existing-account intelligence hypothesis** — not a sub-item of Whitespace Intelligence.

**Founder practitioner insight:** while managing a major existing account, one highly effective growth behavior was monitoring company news and immediately responding to meaningful customer events with proactive promotional ideas. Example: customer launches a new product → rep proactively develops a supporting merch/activation concept around the launch → brings the idea to the customer before being asked → demonstrates strategic-partner behavior even if the exact concept is not ultimately purchased.

**How this differs from Whitespace Intelligence:** Whitespace answers *"where inside this account can I grow?"* Proactive Account Plays would answer *"something meaningful just happened at this customer — what could I proactively bring them that helps them capitalize on it?"*

**Practitioner framing to preserve (2026-08-19 reconciliation, mentor-derived insight):** a strong rep doesn't merely notice that something happened at a customer — they ask *"What could I proactively bring this customer that helps them capitalize on it?"* That question, not just signal detection, is the behavior this hypothesis is trying to encode. Confirms rather than changes the chain and guardrail immediately below, which already captured this correctly.

**Conceptual chain to preserve:** verified signal → business objective/context → grounded promotional activation → rep action. Illustrative future examples: product launch → launch merchandise / dealer / influencer / sales-support activation; hiring growth → onboarding/recruiting activation; new location → opening/team/launch activation; event or sponsorship → attendee/on-site activation; company milestone → recognition/commemorative activation.

**Important doctrine:** do not regress into `signal → random product suggestion`. The activation must have a defensible relationship to what actually happened and the business objective it creates — consistent with existing product direction: `signal → opportunity`, never `signal → generated email`.

**Creative execution / mockups — preserve only as a later hypothesis, layered behind this one, not part of it yet.** Founder also raised the eventual possibility of turning a strong activation idea into actual creative concepts/mockups, potentially through a partner such as Penji or another design service. **Do not research or build a Penji integration now.** Preferred sequence to evaluate later: `Signal → Activation Intelligence → Creative Brief → optional concept/mockup execution`. First prove reps value the activation intelligence and creative brief; only then evaluate design-service integration, mockup quantity/usage limits, turnaround/SLA, pricing/markup, and revisions/quality control.

**Do not begin implementation** — this is a hypothesis to preserve, not scoped or approved work.

### Customer proof / stories

**Shipped, do not reopen (2026-08-21):** Real-World Results (`real-world-results.html`) is now live as the canonical proof destination, replacing the retired Hall of Accounts concept/name (old URL redirects there). It presents three confirmed-real, anonymized **founder field results** — Regional Manufacturing Company (Timing Confirmed), Regional Automotive Dealership (Meeting Scheduled), Regional Healthcare Practice (Order Won, $1,000 order) — see "Recently completed" above for full detail and provenance.

**Important distinction to preserve going forward:** the three shipped stories are the founder's own field results from using House-Accounts-style practices, explicitly presented as such — not independent customer case studies, and the page must not imply otherwise. The items below remain preserved as future, genuinely independent **customer** proof points (distinct from founder field results), for whenever real customer usage produces them — not yet built, not promoted to NOW/NEXT:
- Dover Honda holiday parade public signal → real outbound reply.
- Route 236 field outreach, where specific signals/opportunity ideas produced real contacts/conversations.

Do not add either of these (or any other example) to Real-World Results without the same provenance/anonymity discipline used for the three shipped stories.

### Real-sales reasoning evaluation set — commercial-reasoning quality benchmark (not started)

**Surfaced by:** mentor-derived insight, reconciled 2026-08-19. An intelligence-quality / evaluation backlog item, not current product development — do not begin implementation.

**Distinct from "Customer proof / stories" immediately above, not a duplicate:** that entry preserves the Route 236 field-outreach example as future sales/customer-story proof. This entry preserves the same real-world class of example for a different purpose — a future evaluation benchmark for judging House Accounts' own commercial-reasoning quality. Reuse the existing Route 236 material when this is picked up rather than re-collecting it.

**Evaluation concept to preserve:** use successful real-world selling examples as a quality benchmark for House Accounts' commercial reasoning. Evaluation question: given the evidence House Accounts could reasonably know, can it independently reach a commercially useful interpretation/action approximately as useful as the one a strong rep identified in the field?

**Canonical example to preserve — Northern Pool & Spa's 50th anniversary ("50 Summers"):**
- a real anniversary signal;
- a commercially useful campaign interpretation;
- relevant merchandise/activation possibilities;
- possible account-expansion implications;
- a useful discovery question about where merchandise purchasing currently lives.

### Later notification/channel expansion

Explicitly backlog, do not build now: SMS; Slack; instant notifications; custom delivery times; sophisticated manager/team digests; advanced per-signal notification toggles.

House Accounts remains the canonical state; notification channels are transport only, never a second source of truth. See the Notification & Outcome Loop V1 architecture doctrine this constraint comes from.

### Historical Business Activity reinterpretation (conditional — verify before building)

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16.

**Candidate bounded enrichment:** re-run current commercial interpretation logic only against already-grounded, already-persisted signal evidence created under older reasoning generations — no new web searches, no Firecrawl, no rediscovery, no identity mutation, and never a silent bulk rewrite.

**Only worth doing if a real gap is confirmed:** this is worth building only if old-generation persisted intelligence can still materially surface to current users today and degrade their experience relative to what current reasoning would produce for the same evidence. Verify that before scoping further — do not build speculatively.

**If retained, frame correctly:** a founder-approved, explicit one-time enrichment operation with a clear before/after evidence trail — never an ongoing background reinterpretation system.

### Firecrawl `/search` shadow evaluation — COMPLETED EVALUATION, do not replace Serper (evaluated 2026-08-22)

**Surfaced by:** founder-directed read-only capability review of Firecrawl's July 2026 `/search` relevance/excerpt upgrade, Firecrawl Monitor, and Firecrawl MCP (2026-08-22).

**Current-state finding (verified against code, still true):** House Accounts does not call Firecrawl `/search` anywhere today. Every Firecrawl call site (`api/research-batch.js` and `api/research-account.js`, both `firecrawlScrape()`) hits `/v2/scrape` only, on candidate URLs Serper has already discovered and House Accounts' own scoring/dedup/grounding pipeline has already filtered. Discovery itself is 100% Serper's job.

**Evaluation run and concluded (2026-08-22):** a disposable local harness (`scripts/dev-tools/firecrawl-search-shadow-eval.mjs`, throwaway branch `claude/firecrawl-search-shadow-eval-v1`, not merged) ran a bounded, three-path side-by-side (A: current Serper + filtered Firecrawl scrape; B: Firecrawl `/search` excerpt-only; C: Firecrawl `/search` + scrape) across six fixture accounts via a one-shot Preview-build live execution, frozen query set, and real cost/latency accounting.

**Conclusion — none of the three alternative paths approved:**
- Serper is retained as the discovery provider.
- Firecrawl `/search` is **not approved** as a discovery replacement (Path B).
- Excerpt-only is **not approved** as a scrape replacement (Path B).
- Firecrawl `/search` + scrape is **not approved** (Path C).
- Key reasons: materially slower discovery, higher Firecrawl-credit usage, no downstream OpenAI-token reduction, and mixed evidence quality despite higher raw accepted-signal counts on the Firecrawl paths.

The current Serper → filtered Firecrawl scrape path remains the production path unchanged.

**One LATER hypothesis preserved from the run, still not implemented:** a narrow, conditional highlight-fallback — *Serper discovery → normal House Accounts enrichment → if a candidate's scrape is blocked/boilerplate/low-information, evaluate a query-relevant Firecrawl `/search` highlight as a fallback input for that specific candidate only* — rather than a general discovery or excerpt replacement. **Not scoped, not approved, no implementation.** Any future pursuit of this must re-verify against current code and re-run a bounded comparison before building anything, per the standing "no migration without demonstrated advantage" doctrine below.

**Also surfaced, not scoped:** the live run's Firecrawl-only paths showed date-inconsistency noise not present on the Serper path. Noted for awareness only — not a scoped item, no action taken.

**Read-only trust follow-up from this same run (2026-08-22):** the live run's Path A output surfaced two current-production identity-grounding questions, resolved separately — see "Signal-grounding trust correction: single-location account model can reject legitimate multi-location coverage (Avidia Bank)" below (banked as a known limitation, not implemented) and the Eliot Veterinary Hospital / HARTPETS social-source identity correction (implemented separately, see Recently completed once merged).

**No migration or Production implementation without demonstrated advantage.** Do not build speculatively from vendor capability alone — per the product-development operating-state doctrine above (2026-08-21), this is not evidence-driven work and does not meet the bar for NOW/NEXT.

### Signal-grounding trust correction: single-location account model can reject legitimate multi-location coverage (Avidia Bank) — known limitation, not implemented

**Surfaced by:** the Firecrawl shadow-evaluation run above (2026-08-22); reproduced and root-caused via read-only recon, not fixed.

**Distinct from — do not merge with — the "Location/subsidiary/division whitespace" item** under "Account Expansion / Whitespace Intelligence / Growth Map — remaining work" (NEXT). That item is about *growth mapping* (where can a rep sell more, broken out by location/division); this item is about *signal-grounding correctness* (whether a real, legitimate piece of evidence about the account gets accepted or falsely rejected as identity evidence). Different failure class, deliberately kept as a separate entry per founder direction.

**The failure, reproduced:** a legitimate third-party signal about "Avidia Bank's Westborough Branch Ribbon Cutting" was falsely rejected by `hasLocationContradiction()` / `verifyCandidateCompanyGrounding()`'s location-contradiction veto (`api/signal-intelligence.js`). House Accounts models an account's location as a single flat `account.location` string; a real bank (or any multi-branch business) can have legitimate coverage of a branch in a different city than the one on file, which the current contradiction check cannot distinguish from a genuinely different, same-name company in a different city. The override set that compensates for a location contradiction (`domainCorroborated`, `knownSocialProfileMatch`, `selfDomainCorroborated`, `exactSocialHandleCorroborated`) does not include a location-based override, by design — a third-party publisher merely being geo-matched to the account's town is deliberately weaker evidence than the account's own domain/profile speaking for itself (see `publisherGeoCorroborated`'s own contrast in the code). This is an architectural limitation of the single-location account model, not a bug in the veto logic itself.

**Do not implement now:** do not loosen the location-contradiction override set to admit legitimate branch-level coverage — that would reopen exactly the false-positive risk (a different, same-name company in a different city) the veto exists to catch. Do not add multi-location account architecture from this one case. Bank as a known false-negative until real usage/evidence justifies a scoped fix (e.g. a future richer account-location model with a list of known legitimate branches/subsidiaries, likely convergent with the deferred "Location/subsidiary/division whitespace" item's own eventual richer-location-data dependency, but not the same work).

### Selective company-owned-page change detection (conditional — not scoped, not approved)

**Surfaced by:** the same 2026-08-22 Firecrawl capability review, specifically the Firecrawl Monitor (`search/page/site monitor → diff/new result → optional judge → webhook`) architectural-overlap evaluation.

**Finding — do not pursue a Firecrawl Monitor migration.** House Accounts' existing `scheduler → due target → queue → bounded one-account worker → evidence → notification` architecture (Notification & Outcome Loop V1, Full Beta Monitoring Cutover — both banked above) is a mature, tested, production-proven state machine with its own capacity leasing, per-target DB lease, cooldowns, poison-delivery handling, and cadence advancement. Firecrawl Monitor's generic diff/webhook lifecycle would duplicate that, not replace it, and its URL-diff dedup is strictly weaker than House Accounts' existing event-fingerprint + entity-disambiguation dedup. **Do not add a generic "Firecrawl Monitor migration" item to this backlog.**

**The one narrow idea worth preserving, only if evidence later justifies it:** House Accounts already re-scrapes a company's own `site:domain` pages every monitoring cycle via the existing "owned" query, regardless of whether that page actually changed. Firecrawl Monitor (or an equivalent change-detection mechanism) could someday serve as a selective upstream optimization for known trusted company-owned pages specifically — reducing redundant full-page scrapes/token ingestion when nothing changed. **Not scoped, not approved, do not build now** — only worth evaluating if monitoring scale, cost, or noise later makes it a real, evidence-backed problem.

**Standing doctrine, applies to any future use of Firecrawl Monitor/judge output:** Firecrawl's monitor/judge output is candidate evidence only. It can never establish an HA Business Signal, Reason to Reach Out, or Priority by itself — any such output must still pass House Accounts' existing identity/source/evidence/grounding gates (`verifyCandidateCompanyGrounding()`, `classifyMonitoringSignalEligibility()`) exactly like a Serper-discovered candidate does today. This is not a proposal to replace House Accounts' existing scheduler/queue/worker/monitoring architecture.

**Firecrawl MCP — explicitly not a House Accounts roadmap item, do not add to this backlog.** The same review concluded MCP (a tool-discovery protocol built for interactive/agentic sessions) creates no Production advantage over House Accounts' existing direct, typed, timeout-bounded API call sites in its deterministic serverless pipeline. It may be useful as future developer/agent tooling for engineering investigation work (e.g. driving a live evaluation of the `/search` hypothesis above), but that is a tooling choice, not a product hypothesis, and is deliberately excluded from this backlog.

### Verified-email ownership / signup account squatting — security hardening, not implemented

**Surfaced by:** the 2026-08-24 signup-abuse security recon (automated spam signups, e.g. `salavat@ya.ru`), during the bounded remediation slice that added server-side signup validation and Cloudflare Turnstile (see Recently completed once merged). Corrected from that recon's original conclusion per founder direction: the incident itself remains ordinary public-form spam with no evidence of compromise, but tracing the exact signup path surfaced a separate, real weakness worth banking.

**The weakness:** `api/auth.js`'s signup branch creates the Supabase Auth user via the Admin API with `email_confirm:true`, which force-confirms the submitted email address at creation regardless of whether the registrant actually controls that inbox. A registrant can therefore create a live, fully-usable House Accounts account under an email address they do not own — account squatting on an arbitrary address, not merely a made-up one.

**No cross-org/data exposure was found from this** — organization membership resolves only from an existing `ha_users` row for the authenticated identity, never by matching org name/domain, so this does not let one signup access another account's data. It is an email-ownership gap, not an authorization gap.

**Do not solve now.** A future decision should evaluate proper Supabase email confirmation (or another ownership-verification gate — e.g. a confirmation-link click before the account is fully usable) against the real cost to onboarding conversion, since House Accounts' signup is explicitly positioned as frictionless/free-forever. Not scoped, not approved — pick up only via an explicit founder decision, and only implement it in service of this exact item, not folded into unrelated work.

### Longer-term / older parked ideas

Kept clearly lower priority unless current strategy explicitly promotes one of these — do not let them outrank the current commercial path (existing customer intelligence → reason to reach out → opportunity/play → Prepare for Call → rep action → outcome):

- CRM live sync / OAuth / scheduled imports
- Supplier intelligence
- Forecasting
- Advanced analytics (beyond Manager intelligence under NEXT, which is scoped and dependency-gated)
- AI-agent-like workflows
- Chrome/mobile experiences
- Public roadmap/voting
- Universal any-company research (research on companies that are not existing customers at all — distinct from Account Intelligence/account search under SOON, which stays scoped to existing customer data, and distinct from Find More Like Them above, which is customer-similarity-driven, not universal)
- More sophisticated enterprise permissions/admin

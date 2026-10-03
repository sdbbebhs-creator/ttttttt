# AGENTS.md

## Architecture

- React 19 + Vite SPA (`src/`). No Express server — the old `server.ts` was removed in favor of Netlify Functions.
- `netlify/functions/*.mts` — serverless endpoints using the Web `Request`/`Response` API with `export const config: Config = { path: '/api/...' }` for routing:
  - `lookup-item.mts` → `/api/ai/lookup-item` (Gemini-backed vocab/grammar autofill, offline fallback)
  - `optimize-fsrs.mts` → `/api/ai/optimize-fsrs` (Gemini-backed FSRS parameter tuning, offline fallback)
  - `context-practice.mts` → `/api/ai/context-practice` (Luyện Output 5 ngữ cảnh: `action` = `suggestContexts` | `sampleSentence` | `validate`, works for both vocab and grammar via `kind`). All Gemini calls use `responseMimeType: 'application/json'` + a `responseSchema`, try a small model fallback list, and return HTTP 429 `{ code: 'RATE_LIMITED' }` when every model is rate-limited.
  - `data.mts` → `/api/data` (alias `/api/sync` for old tabs). Authenticated GET (`kind=version|vocab|grammar|logs|settings`, incremental via `since`/`afterSeq`) and POST (incremental upserts/deletes/settings/logs) scoped to the verified user id.
- `db/schema.ts` — Drizzle schema (`vocab_items`, `grammar_items`, each row is `{ user_id, id, data: jsonb, updated_at }`, one JSONB blob per item so the full `VocabItem`/`GrammarItem` shape doesn't need to be hand-modeled in SQL).
- `db/index.ts` — Drizzle client via `drizzle-orm/netlify-db`.
- Migrations live in `netlify/database/migrations/`, generated with `npx drizzle-kit generate --name <slug>`. Never edit or apply migrations manually — Netlify applies them automatically at deploy time.
- `review_logs.seq` (migration `20261002084856_add_review_log_seq`) is already applied in Netlify DB and must stay in `db/schema.ts` and on disk; `/api/data?kind=logs&afterSeq=` pages review logs by it.
- Auth: Supabase (`src/utils/supabaseClient.ts`) is used **only** for identity (Email/Password sign-in/sign-up). It does not store app data. `data.mts` verifies the Supabase access token server-side via `supabase.auth.getUser(token)` and uses the resulting user id as the row key in Netlify DB — this is what makes cross-device sync work.
- Data sync (`src/utils/syncClient.ts`): Netlify DB is the source of truth. The device keeps a per-account hash snapshot (`vocabbank_sync_state_v1:<uid>`); pending changes = diff vs snapshot (survives offline/F5). `pullAndMerge` runs on login (also one-time migration from old Supabase tables, marked by setting key `__supabase_migrated_v1`), `pullRemoteChanges` polls every 15s / on visibility / on online. Local copy is owned by one account (`vocabbank_data_owner`); a different account clears it. Logout flushes, warns on pending changes, stashes them per-user (`vocabbank_pending_stash_v1:<uid>`) and clears the local copy. `SyncIndicator` (Navbar) shows “Đang chờ mạng” + pending count. Supabase is auth-only; `supabaseItems.ts`/`useSyncData.ts` were removed. New ids come from `src/utils/itemIds.ts`.
- Client persistence: `src/utils/storage.ts` manages IndexedDB/localStorage as the local cache.

- FSRS scheduler settings live in `src/utils/fsrs.ts` (`getFSRSSchedulerSettings`/`saveFSRSSchedulerSettings`, localStorage key `fsrs_scheduler_settings_v1`): custom weights, maximum interval, learning steps. Desired retention is clamped to 80–95%. `getFSRSRatingOutcomes` is the single source for button previews and `reviewCard`; learning steps only apply to new/in-step cards (`scheduled_days === 0`).
- FSRS settings are a single reactive store: `getFSRSSettings()` (cached snapshot of scheduler settings + `targetRetention`), `updateFSRSSettings(patch)`, `subscribeFSRSSettings()` in `src/utils/fsrs.ts`, exposed to React via `useFSRSSettings()` (`src/hooks/useFSRSSettings.ts`, `useSyncExternalStore`). Every write path (`saveFSRSSchedulerSettings`, `setActiveTargetRetention`, `saveUserFSRSConfig`) emits a change, and cross-tab `storage` events are forwarded. Review screens (`FlashcardTab`, `DailyReviewTab`, `ContextOutputModal`) must pass the hook's settings into `previewNextFSRSIntervals` so button labels re-render when settings change. `FSRSSettingsPanel` edits a draft owned by `FSRSOptimizerModal`; nothing applies until “Lưu cài đặt” (with Hoàn tác and an unsaved-changes confirm on close). `smartreview_fsrs_user_config_v2.targetRetention` is ignored on read; `fsrs_target_retention` is the only source of truth.
- Trợ Lý Đo Nhịp Trí Nhớ (`FSRSOptimizerModal.tsx`) is the only FSRS explainer surface — the old "Nguyên lý FSRS" tab was removed on purpose; don't re-add it. The recommended retention comes from `recommendRetention()` in `src/utils/memoryRhythm.ts` (pure, no browser APIs) which is imported by both the modal and `netlify/functions/optimize-fsrs.mts`; Gemini only writes the explanation and may nudge the number by at most ±0.02. `getMemoryLogsStats` measures retention only on logs with `prevScheduledDays > 0` and counts rating ≥ 2 as recalled. Don't add buttons that overwrite `smartreview_memory_logs_v2` with fake data — those logs feed the weights optimizer.
- `src/utils/fsrsOptimizer.ts` fits personal weights in the browser (replays review logs, minimizes log-loss, coordinate descent; min 400 reviews). UI: `src/components/FSRSSettingsPanel.tsx`, embedded in `FSRSOptimizerModal.tsx`.

## Conventions

- UI shell: `src/components/Sidebar.tsx` (desktop nav, md = icon rail, lg = full) + `src/components/Navbar.tsx` (contextual top bar; shows the active section title) + mobile bottom nav in `App.tsx`. All three read the same `navItems` array in `App.tsx` — add sections there, not in each nav.
- Design tokens live in the `@theme` block of `src/index.css`: the Tailwind `slate`/`emerald` scales, shadows and font weights are overridden there, so components keep using plain `slate-*`/`emerald-*` classes. Change the palette in one place instead of editing components.
- `animate-fade-in` / `animate-in` are opacity-only on purpose — a transform would make animated wrappers the containing block for `position: fixed` modals and full-screen games rendered inside tabs.

- Gemini keys stay server-side. The browser only talks to `/api/ai/*`; `src/utils/geminiPractice.ts` wraps the context-practice endpoint and owns the fallbacks (default tabs `DEFAULT_CONTEXTS`, offline scoring from `contextEngine.ts`). `ContextOutputModal.tsx` never calls Gemini directly.
- Gemini 1.5/2.0 Flash are retired and not available through Netlify AI Gateway; `gemini-2.5-flash` is the primary model. Check the `netlify-ai-gateway` skill's model list before changing models.

- Do not reintroduce automatic sample-data seeding. `getSampleData()` in `src/utils/storage.ts` exists only for the manual "Nạp mẫu"/"Nạp bộ thẻ mẫu" button (`BackupModal.tsx`, `handleLoadSampleData` in `App.tsx`) — new accounts must start empty.
- Netlify Functions in this repo use `.mts` and the Web API signature (`export default async (req: Request) => ...`), not the older Lambda-style handler signature.
- The Supabase URL and publishable anon key are safe to embed client-side; they're hardcoded as fallbacks in `src/utils/supabaseClient.ts` and `netlify/functions/data.mts`, overridable via `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (client) and `SUPABASE_URL`/`SUPABASE_ANON_KEY` (server) env vars.

## Rank & streak rules (`src/utils/rankSystem.ts`)

- A day counts (streak +1, rank kept) only when nothing is due **today** — App.tsx always uses `getTodayDate()` for rank bookkeeping, never the calendar's `selectedDate`. The full-day bonus is paid once per day.
- `checkDailyRankDecay(today, dueDates)` is idempotent via `streakSafeThrough`: a past day is only "missed" if some card's `reviewDate` is still on/before it (days with nothing due are free rest days). One shield per missed day; not enough shields → streak 0 and demote 1 tier. It runs on load and again when the tab becomes visible on a new day.
- Shields are only earned at `SHIELD_STREAK_MILESTONES` (max 3). There is intentionally no free "claim shield" button and no daily "rank protection" progress bar in `RankModal` — don't re-add them.
- Promotion progress everywhere uses `getRankProgress()` (weakest of streak / EXP / active days), not EXP alone.

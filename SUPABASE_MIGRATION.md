# Supabase migration notes

## Database
Run `supabase/migrations/20261003000000_vocabbank_primary_supabase.sql` in Supabase SQL Editor once.

Active cloud data tables:
- `vocab_items`: every vocabulary card + its FSRS state + examples/images/audio/context output.
- `grammar_items`: every grammar card + its FSRS state + examples/images/audio/context output.
- `user_settings`: synced FSRS settings, target retention, rank/streak data, game badges/stats/high scores.
- `review_logs`: append-only review history used by FSRS analytics/optimizer.

`study_data` from the older migration is legacy compatibility only; the current app does not depend on it.

## Gemini
The existing Gemini implementation remains server-side. On Vercel, `api/ai/*` adapters expose the existing Netlify function logic. Set `GEMINI_API_KEY` in Vercel Environment Variables. Never put the Gemini secret in `VITE_*`.

## Supabase client
Set:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

The publishable/anon key is intended for client use; RLS is mandatory and is included in the migration.

## Existing data
The app keeps its offline local copy. On first sync after this migration, local vocabulary/grammar/settings/review logs are pushed to Supabase.
Data that exists only in the old Netlify Database is not automatically readable from Vercel; export it from the old deployment before shutting it down if it is not present on the current browser.

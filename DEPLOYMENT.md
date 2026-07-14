# Deployment Policy

This project auto-deploys via Vercel on every push to `main`. Vercel project `baigtyres-services` is connected directly to this repo. No build step is required beyond a no-op (`vercel.json` sets `outputDirectory: "public"`; `package.json`'s `build` script is a no-op echo).

## Rule: every change is a commit

Every change to this repo -- whether made by a human or by Claude (via the connected GitHub/Zapier integration) -- must land as a real commit to `main`. This is a hard rule, not a preference:

- Do NOT bypass this with a direct Vercel deploy (`vercel deploy`, the Vercel dashboard's drag-and-drop upload, or any API-level file push that skips git). Those create drift between what's live and what's actually in this repo, and get silently overwritten the next time a real commit lands.
- The commit history in this repo is the single source of truth for what's live. If it isn't a commit, it isn't a real change.

## Known unresolved issue

Enquiry "durable capture" (`api/enquire.js`) currently writes a structured `ENQUIRY_BACKUP:<json>` line to Vercel runtime logs only -- not an auto-retry queue or real datastore. Recoverable by a human grepping logs, not automatic. If durability becomes a real requirement, replace the `enqueue()` function with a write to a real datastore (Vercel KV, Vercel Postgres, etc.).

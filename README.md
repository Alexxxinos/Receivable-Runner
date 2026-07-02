# Receivables Runner

Upload an Excel/CSV invoice tracker, and a weekly cron emails your overdue
clients a reminder that escalates in tone the longer they go unpaid. Drafts can
be polished with Claude before they send.

Stack: Vite + React frontend, Vercel serverless functions, Supabase (Postgres),
Resend (email), Anthropic (draft polishing). The browser never holds a database
key or API key. Everything that touches data goes through password-gated
`/api` functions.

## What's where

```
src/            React app (gate, import, dashboard)
api/            serverless functions
  invoices.js   list / import / mark-paid / mute
  draft.js      AI draft polishing (Anthropic, server-side)
  cron-send.js  the weekly send (Resend), called by Vercel Cron
lib/            shared aging + template logic (used by app and cron)
supabase/       schema.sql (run once)
vercel.json     cron schedule (Mondays 14:00 UTC)
```

## Deploy (about 15 minutes)

### 1. Supabase
1. Create a project at supabase.com.
2. SQL editor, paste `supabase/schema.sql`, run it.
3. Project settings, API: copy the **Project URL** and the **service_role** key
   (not the anon key).

### 2. Resend
1. Create an account at resend.com.
2. To send to real clients, add and verify your sending domain (a subdomain like
   `billing.yourdomain.com` with the SPF/DKIM records Resend gives you). Until
   then you can only send to your own address from `onboarding@resend.dev`.
3. Create an API key.

### 3. Push to GitHub, import to Vercel
1. `git init && git add . && git commit -m "init"` then push to a new repo.
2. In Vercel, New Project, import the repo. It auto-detects Vite.
3. Add the environment variables from `.env.example` (Project Settings,
   Environment Variables). Set `CRON_SECRET` to a long random string; Vercel
   sends it automatically with cron requests.
4. Deploy. The cron registers itself from `vercel.json`.

### 4. First run
1. Open the site, enter your `APP_PASSWORD`.
2. Import tab, drop your tracker, map the columns, import.
3. Receivables tab shows aging, the week's drafts, and a mark-paid / mute control
   on every row.

## How the weekly send decides who to email

A row gets a reminder when it is `unpaid`, not `paused`, past its due date, and
has not been reminded in the last 7 days. Reminders are grouped by email, so a
client with three overdue invoices gets one email listing all three. Tone tiers:
1-30 days friendly, 31-60 firmer, 61-90 firm, 90+ final notice.

To test the cron without waiting for Monday, trigger it from the Vercel
dashboard (Cron Jobs, Run), or curl it with the secret:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP.vercel.app/api/cron-send
```

## The two things that decide whether this works

1. **The paid signal.** The cron only stops emailing a client when their invoice
   is marked `paid`. If nobody marks invoices paid, it will dun people who
   already paid. Mark them paid in the dashboard, or later sync status from your
   accounting system.
2. **Deliverability.** Send from a verified subdomain with SPF/DKIM/DMARC and a
   real monitored `REPLY_TO`, so clients can reply "paid last week" and you see
   it.

## Local dev

```
npm install
vercel dev      # runs the frontend and the /api functions together
```

(`npm run dev` alone runs only the frontend; the `/api` calls need `vercel dev`
or a deploy.)

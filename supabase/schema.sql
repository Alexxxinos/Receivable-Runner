-- Run this in the Supabase SQL editor once.

create extension if not exists "pgcrypto";

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  client text not null default 'Unknown',
  email text,
  invoice_no text,
  amount numeric not null,
  due_date date,
  status text not null default 'unpaid',     -- 'unpaid' | 'paid'
  paused boolean not null default false,     -- mute reminders for this row
  last_reminded_at timestamptz,
  reminder_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- upsert key for re-importing the tracker without duplicating
create unique index if not exists invoices_invoice_no_key
  on invoices (invoice_no)
  where invoice_no is not null;

-- lock the table down. only the service role (used by /api) can touch it.
alter table invoices enable row level security;
-- no policies = no anon/public access. service role bypasses RLS.

-- stamp + bump counter for a batch of ids after a successful send
create or replace function mark_reminded(ids uuid[])
returns void language sql as $$
  update invoices
     set last_reminded_at = now(),
         reminder_count = reminder_count + 1,
         updated_at = now()
   where id = any(ids);
$$;

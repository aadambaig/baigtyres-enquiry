create table if not exists public.enquiries (
  id text primary key,
  name text not null,
  contact jsonb not null,
  vehicle_registration text not null,
  service_requested text[] not null default '{}',
  message text not null default '',
  submitted_at timestamptz not null default now(),
  email_sent boolean not null default false
);

comment on table public.enquiries is 'Server-side capture of Baig Tyres website enquiries.';
comment on column public.enquiries.contact is 'Customer phone and email, stored as JSON.';

alter table public.enquiries enable row level security;

-- No public policies: the Vercel function writes through the Supabase service-role key,
-- which bypasses RLS. This keeps customer contact details private by default.

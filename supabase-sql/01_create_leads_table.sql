-- Tabel voor de Lead-intake workflow
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  naam text,
  email text,
  bedrijf text,
  telefoon text,
  vraag text,
  samenvatting text,
  segment text,
  urgentie text,
  eerste_actie text,
  bron text default 'formulier',
  ruwe_payload jsonb
);

alter table public.leads enable row level security;
-- Geen policies: alleen te benaderen met de service-role sleutel (bijv. vanuit n8n).

-- Huidige staat van het bedrijfsbrein (CORTEX + ATLAS), inclusief de twee fixes
-- die na de oorspronkelijke migratie zijn toegepast op vraag_cortex.
-- Dit bestand is een snapshot van hoe de database er nu voor staat, niet de
-- letterlijke oorspronkelijke migratie-tekst.

create extension if not exists vector;

-- CORTEX: feitengeheugen -------------------------------------------------
create table if not exists public.cortex_events (
  id bigint generated always as identity primary key,
  gebeurd_op timestamptz not null default now(),
  type text not null,
  wie text,
  bron text not null default 'handmatig',
  bedrag numeric,
  omschrijving text,
  data jsonb not null default '{}'::jsonb
);

create index if not exists cortex_events_gebeurd_op_idx on public.cortex_events (gebeurd_op desc);

alter table public.cortex_events enable row level security;

-- ATLAS: oordeelgeheugen --------------------------------------------------
create table if not exists public.atlas_chunks (
  id bigint generated always as identity primary key,
  pad text not null,
  type text not null default 'kader',
  titel text not null,
  inhoud text not null,
  hash text,
  embedding vector(384),
  bijgewerkt timestamptz not null default now(),
  zoek tsvector generated always as (
    setweight(to_tsvector('dutch', coalesce(titel, '')), 'A') ||
    setweight(to_tsvector('dutch', coalesce(inhoud, '')), 'B')
  ) stored
);

create index if not exists atlas_chunks_zoek_idx on public.atlas_chunks using gin (zoek);

alter table public.atlas_chunks enable row level security;

create table if not exists public.atlas_inbox (
  id bigint generated always as identity primary key,
  tekst text not null,
  context text,
  bron text default 'balie',
  aangemaakt_door text,
  aangemaakt_op timestamptz not null default now()
);

alter table public.atlas_inbox enable row level security;

create table if not exists public.instellingen (
  sleutel text primary key,
  waarde_text text
);

alter table public.instellingen enable row level security;

insert into public.instellingen (sleutel, waarde_text)
values ('atlas_balie_key', 'VERVANG-MIJ')
on conflict (sleutel) do nothing;

-- vraag_cortex: alleen-lezen feitenvraag op cortex_events ------------------
-- (deze versie bevat de twee fixes: \y i.p.v. \b als woordgrens, en een
--  harde beperking tot uitsluitend de tabel cortex_events)
create or replace function public.vraag_cortex(p_sql text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sql text := btrim(p_sql);
  v_result jsonb;
begin
  if v_sql !~* '^\s*(select|with)\y' then
    raise exception 'alleen lezen is toegestaan (SELECT)';
  end if;
  v_sql := rtrim(v_sql, '; ');
  if position(';' in v_sql) > 0 then
    raise exception 'één vraag per keer';
  end if;
  if v_sql !~* '\ycortex_events\y' then
    raise exception 'deze vraag mag alleen over de tabel cortex_events gaan';
  end if;
  if v_sql ~* '\y(atlas_chunks|atlas_inbox|instellingen|pg_[a-z_]*|information_schema)\y' then
    raise exception 'deze vraag mag alleen over de tabel cortex_events gaan';
  end if;
  perform set_config('statement_timeout', '8000', true);
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) s limit 200) t', v_sql)
    into v_result;
  return v_result;
end;
$function$;

revoke all on function public.vraag_cortex(text) from public, anon, authenticated;

-- match_atlas: hybride vector- + woordzoekopdracht op atlas_chunks --------
create or replace function public.match_atlas(
  query_embedding vector(384),
  query_text text default null,
  match_count int default 6,
  filter_type text default null
)
returns table (
  pad text, type text, titel text, inhoud text,
  gelijkenis double precision, woordscore double precision,
  dekking double precision, woordtreffer boolean
)
language sql stable
set search_path to 'public'
as $function$
  with
  kandidaten as (
    select c.id, c.pad, c.type, c.titel, c.inhoud, c.zoek,
           1 - (c.embedding <=> query_embedding) as gelijkenis
    from atlas_chunks c
    where c.embedding is not null
      and (filter_type is null or c.type = filter_type)
  ),
  stammen as (
    select distinct s as stam
    from unnest(tsvector_to_array(to_tsvector('dutch', coalesce(query_text, '')))) as s
  ),
  gewicht as (
    select st.stam,
           ln(((select count(*) from kandidaten) + 1.0)
              / ((select count(*) from kandidaten k where tsvector_to_array(k.zoek) @> array[st.stam]) + 1.0)) + 0.1 as gewicht
    from stammen st
  ),
  totaal as (select coalesce(sum(gewicht), 0) as totaal from gewicht),
  woorden as (
    select k.id,
           coalesce(sum(g.gewicht), 0)::float as woordscore,
           case when (select totaal from totaal) > 0
                then (coalesce(sum(g.gewicht), 0) / (select totaal from totaal))::float else 0 end as dekking
    from kandidaten k
    left join gewicht g on tsvector_to_array(k.zoek) @> array[g.stam]
    group by k.id
  ),
  rangen as (
    select k.id,
           rank() over (order by k.gelijkenis desc) as r_betekenis,
           case when w.woordscore > 0
                then rank() over (partition by (w.woordscore > 0) order by w.woordscore desc, k.gelijkenis desc) end as r_woorden
    from kandidaten k join woorden w using (id)
  )
  select k.pad, k.type, k.titel, k.inhoud, k.gelijkenis, w.woordscore, round(w.dekking::numeric, 2)::float as dekking,
         (w.dekking >= 0.4) as woordtreffer
  from kandidaten k
  join woorden w using (id)
  join rangen r using (id)
  order by (1.0 / (60 + r.r_betekenis)) + coalesce(1.0 / (60 + r.r_woorden), 0) desc, k.gelijkenis desc
  limit least(coalesce(match_count, 6), 12);
$function$;

revoke all on function public.match_atlas(vector, text, int, text) from public, anon, authenticated;

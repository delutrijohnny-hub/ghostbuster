/* What was read about a contact from outside this app, and when.
 *
 * NOT YET APPLIED -- see docs/channel-research.md.
 *
 * A cache, and the word is load-bearing. The YouTube Data API gives 10,000
 * units a day and a full channel read costs three, so re-reading 987 channels
 * on every brief would burn the day's quota in about three hours and make the
 * Desk Assistant slower than opening YouTube by hand. Everything here can be
 * fetched again; nothing here is a record of anything the business did.
 *
 * `payload` is deliberately jsonb and deliberately raw-ish: the shape of what
 * YouTube returns is theirs to change, and the reading of it lives in
 * logic.js where it can be tested. A column per statistic would mean a
 * migration every time the interesting number changes.
 *
 * `error` exists so a channel that cannot be read is remembered as such. Seven
 * of the links on this book are YouTube SEARCH RESULT urls that name no
 * channel; without somewhere to record that, every brief for those contacts
 * would try again and fail again.
 *
 * One row per contact per source, so a refresh replaces rather than
 * accumulates. The history of somebody's subscriber count is not something
 * this product has any use for, and storing it would make a cache into a
 * record nobody asked for.
 */
create table if not exists public.client_research (
  client_id   text not null references public.clients(id) on delete cascade,
  source      text not null check (source in ('youtube', 'web')),
  org_id      uuid not null,
  user_id     uuid not null,
  payload     jsonb,
  /* Null when the read succeeded. A short reason when it did not, shown to
     the rep rather than swallowed -- "that link is a search result, not a
     channel" is something only they can fix. */
  error       text,
  fetched_at  timestamptz not null default now(),
  primary key (client_id, source)
);

create index if not exists client_research_org_idx on public.client_research (org_id);
create index if not exists client_research_stale_idx on public.client_research (fetched_at);

drop trigger if exists client_research_set_org on public.client_research;
create trigger client_research_set_org before insert on public.client_research
  for each row execute function public.set_org_id_from_user();

/* RLS mirroring conversation_notes: the org reads, the author writes. A
   teammate covering a call should see what was already read about the
   contact rather than spending the quota reading it again. */
alter table public.client_research enable row level security;

drop policy if exists client_research_select on public.client_research;
create policy client_research_select on public.client_research for select
  using (org_id in (select public.user_org_ids()));

drop policy if exists client_research_insert on public.client_research;
create policy client_research_insert on public.client_research for insert
  with check (org_id in (select public.user_org_ids()) and user_id = auth.uid());

drop policy if exists client_research_update on public.client_research;
create policy client_research_update on public.client_research for update
  using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

drop policy if exists client_research_delete on public.client_research;
create policy client_research_delete on public.client_research for delete
  using (user_id = auth.uid());

comment on table public.client_research is
  'Cache of what was read about a contact from outside this app. Everything here can be fetched again; nothing here is a business record.';

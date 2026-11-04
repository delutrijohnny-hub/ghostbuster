/* They said no.
 *
 * Applied to production 2026-11-03 as `clients_declined`; recorded here
 * afterwards, which was an oversight at the time -- the other migrations in
 * this run were written down as they were applied and this one was not.
 * The filename carries the REMOTE version number (20261104003442) rather than
 * a round one, so the repo and supabase_migrations.schema_migrations agree
 * about this change even though they disagree about many older ones.
 *
 * There was no way to record a decline. The seven pipeline statuses have no
 * value for it, and the only thing that stopped the chase was clients.ignored,
 * which means junk: it is what the dedupe and the calendar-exclusion rules
 * set, and every stats path filters it out. Marking a real decline that way
 * made the decline vanish from the numbers instead of counting as an outcome.
 *
 * What that cost, on the live book: Brandon Walsh said "not interested at this
 * time" on 19 August and was texted again on 2 November. Ursula Russo said
 * "I'm no longer interested" after fifteen sends and got another the same day.
 *
 * SEPARATE FROM status, deliberately, rather than an eighth pipeline value.
 * Ursula is Completed -- she had a real call -- and Brandon is a No-show.
 * Collapsing either into "Not interested" would erase why they left, and the
 * funnel would stop being able to tell a lost sale from a lost appointment.
 *
 * Nullable with no default: null means nobody has recorded a decline, which is
 * true of every row today and is not the same as "they are interested".
 */
alter table public.clients
  add column if not exists declined_at     timestamptz,
  add column if not exists declined_reason text,
  add column if not exists declined_by     uuid;

comment on column public.clients.declined_at is
  'When they said no. Stops the cadence and clears the action queue; reversible if they come back.';
comment on column public.clients.declined_reason is
  'Their own words where there are any, so the decline can be checked rather than trusted.';
comment on column public.clients.declined_by is
  'Who recorded it. Never set automatically: a model matching "I''m all set" cannot tell a decline from a confirmation.';

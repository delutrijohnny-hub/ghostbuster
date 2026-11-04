/* A task that knows who it is about and when it is due.
 *
 * NOT YET APPLIED. Written for an operator to run; see docs/desk-assistant.md.
 * The Desk Assistant works without it -- the proposed date is always written
 * into `text` as well, and the insert falls back to omitting these two columns
 * if the database does not have them yet -- so applying this adds sorting and
 * the contact link, and changes nothing else.
 *
 * todos was a flat checklist: id, user_id, text, done, created_at, done_at,
 * org_id. That is enough for "ring the plumber" and not enough for the thing a
 * rep actually leaves a call with -- "send Dave a sample script by Friday" --
 * which has a person and a date in it. Without these columns both survive only
 * as English inside `text`, where nothing can sort by the date, show the task
 * on the contact, or notice it came due.
 *
 * Two nullable columns, no default, and no change to RLS: the existing
 * todos_org_all policy already covers every column, and every task that exists
 * today keeps meaning exactly what it meant. A null client_id is the normal
 * state for a hand-written checklist item, and a null due_at means nobody said
 * when -- which is a real answer and must not be confused with "due now". That
 * distinction is why neither gets a default.
 *
 * ON DELETE SET NULL rather than CASCADE: deleting a contact should not
 * silently delete the reminder to do something about them. The task survives
 * with its text intact and stops claiming a link it no longer has.
 */
alter table public.todos
  add column if not exists client_id text
    references public.clients(id) on delete set null,
  add column if not exists due_at timestamptz;

/* The contact's open tasks, which is the read the brief makes. */
create index if not exists todos_client_idx
  on public.todos (client_id) where client_id is not null;
/* What is coming due, for one person. Partial because a finished task is
   history and never answers "what do I owe anybody". */
create index if not exists todos_due_idx
  on public.todos (user_id, due_at) where due_at is not null and done = false;

comment on column public.todos.client_id is
  'The contact this task is about, when it is about one. Null for a plain checklist item.';
comment on column public.todos.due_at is
  'When it is due. Null means nobody said -- which is not the same as due now.';

-- Link 28 logged sends to the message that really went out.
--
-- Generated 2026-11-02 by scratchpad/plan_backfill.js, which chose every pair
-- with GB.adoptLoggedSend out of logic.js -- the SAME function imessage-sync
-- now calls (commit 8d8134b, function version 9). The pairs are therefore not
-- a SQL re-reading of the rule; a second implementation of the three tiers is
-- exactly what this is cleaning up after.
--
-- Tiers: {"exact":8,"greeting":5,"trimmed":15}
-- Contested (one logged send claimed by two real messages): 0
--
-- WHY THIS IS A MERGE AND NOT A STAMP
--
-- When adoption failed, imessage-sync INSERTED the real message as a new row
-- with stage 'custom' instead of linking it. So each of these is two rows
-- describing one text:
--
--   optimistic  provider_id NULL      stage 'welcome'  variant_key 'w2'
--   agent       provider_id 'imsg:..' stage 'custom'   variant_key 'custom'
--
-- The optimistic row carries the attribution that reply rates are measured
-- on, and the agent row carries the proof of delivery. Keeping the optimistic
-- row and moving the provider id onto it preserves both; keeping the agent row
-- instead would throw away the stage and variant, which is how 297 duplicate
-- rows inflated every reply figure in this product once already.
--
-- Afterwards a re-sync of the same message finds the optimistic row by
-- provider_id and skips it, so this stays idempotent.
--
-- Run the whole file. It is one transaction and it aborts on any surprise.

begin;

-- Every row this touches, both halves of all 28 pairs, before anything
-- changes. Restoring is: update from this table, re-insert the deleted rows.
create table message_log_adopt_backup_20261102 as
select now() as backed_up_at, 'optimistic' as half, m.*
  from message_log m where m.id in (
    '128b92bb-5855-4a0a-b8f8-55b0fc0eb3f5',
    '73847e54-784b-42e1-a86a-bf7a2a6bd5f8',
    '77127a7b-904d-4be2-a1f5-1db7487ff2b5',
    '29f6b796-8c72-44f9-8303-b4b1769d56ba',
    '304f7928-5317-4aed-ade0-a596d2142de1',
    '06831194-a14a-4bd2-ae14-ccb68a82d7c0',
    'ccf75142-7e5c-4c98-968f-8ba540b5d187',
    '099a6fca-004b-4269-98e4-2232b651d4cd',
    '0eefda2b-c57e-4c52-b580-1ce723a5f8e9',
    'fa0b8028-9132-4375-b6db-ef4d29923908',
    '661b4d81-4326-4ad4-9b02-ba51504263e1',
    'ed805bd5-8c03-4899-8237-72576808fe81',
    'bf70d4f1-75eb-422f-b36e-2e181532392f',
    'a112e28b-cdab-4738-b6fa-fec0e823806d',
    '3d01a86d-59fd-4a77-a768-860b9e23ee51',
    'f19acc66-7010-4d62-87d2-441a1248a829',
    'c4895aef-5fad-4021-b67b-2666512c9048',
    '5d186953-2d65-42df-82f5-3f1f6274f288',
    '9371b5ae-9a29-4982-83ac-907b057c5055',
    '2c364958-f17d-4e60-99ec-ee7f5e3340ee',
    '186ef1c8-b5b7-44fc-b1da-da8ff0a0d68f',
    'cbb188a0-65fd-41e7-a890-76f9d0447133',
    '5a6c10c2-6b71-4678-b5c2-2540f73011bb',
    '4a81bb07-5613-439c-86a7-fc80a91837bf',
    'd01ca810-ec78-4499-8864-76096a4ee669',
    '04d0cc9a-a2a7-45f8-ad80-463d683d4d26',
    'f256c730-1285-4b77-a5dd-64c9467aaa13',
    '8d540f8b-8dd0-4b22-8e2f-f6eaf649f0d5'
  )
union all
select now() as backed_up_at, 'agent' as half, m.*
  from message_log m where m.id in (
    '09f9f05a-f9b4-40b0-a887-605d1f4b3a6b',
    '0a28f5dc-ea7a-41a3-85d6-8c34ac8fcf2a',
    '0c1e5ed7-6c02-41b2-ba96-0b0cdb6c122a',
    '1314f7f3-2a23-4199-b8c2-3f24e759b99e',
    '13e8da10-5266-4b68-912c-44bcd85d2bda',
    '17f42651-e1ab-4c69-a78b-4218a62405ad',
    '185aa0c2-4678-486f-bbbe-f8bad773d448',
    '33fa8cb2-8f88-4760-af44-ce58b47a4737',
    '37df34d5-d61f-42ec-ab0e-866ff726ce49',
    '41b0f4fb-00c9-4837-bb0f-17bb32df2e9e',
    '580d45dc-05be-4001-8170-2669d8525f27',
    '58849157-d19d-4d06-b6fc-e68b67100e7a',
    '68e4bce6-3e73-411b-ab29-3f9fdfd35fbf',
    '6c2e0447-a3b0-4005-bd03-802250cd91fc',
    '6c3f8183-b347-4829-816c-ea8e5fef63f9',
    '7319a0a5-7352-4324-a322-5e5cc0864f2f',
    '738d2115-29cd-4829-915b-bb83e246d906',
    '774aebf2-d949-40d4-8683-d6c7aaeacd71',
    '7be9a018-b0ec-4bc6-a39c-ec4821c22c5d',
    '9098998b-7ffb-471c-a813-a0c11cb44ad8',
    '93c02631-27e3-48d2-bab9-fba7b893d82c',
    '97a241ae-8d92-4341-8386-8cc6e117bb42',
    '9f01d3ff-ccf8-4f66-92c0-986e63033824',
    'a865d0bb-e3b8-4ff0-8297-173785469ca5',
    'd023472f-ee91-41ab-9076-e3050d532fe1',
    'f5a85d5e-01ca-4025-a7fd-e521dcd3e35e',
    'f7ab8291-acaa-4b02-b70f-fa6e69a20c71',
    'fc4627b3-329f-4115-8594-22c27fc94478'
  );

/* CREATE TABLE AS does NOT inherit RLS, and Supabase's default grants hand
   public tables to anon -- the key that ships in the app's JavaScript. So for
   the minutes between creating this table and this statement, 56 real client
   messages were readable by anybody. Caught by the suite's own guard ("every
   table created in SQL here also gets RLS turned on"), which is the only
   reason it was a few minutes and not permanent.

   No policies, deliberately: RLS with no policy denies everything except the
   service role, which is exactly right for a backup nobody should read
   through the API. The three older backup tables are set up the same way. */
alter table public.message_log_adopt_backup_20261102 enable row level security;
revoke all on public.message_log_adopt_backup_20261102 from anon, authenticated;

-- Fail loudly rather than quietly doing the wrong thing to the wrong rows.
do $$
declare n int;
begin
  select count(*) into n from message_log_adopt_backup_20261102;
  if n <> 56 then
    raise exception 'backup holds % rows, expected 56', n;
  end if;

  select count(*) into n from message_log_adopt_backup_20261102
   where half = 'optimistic' and provider_id is not null;
  if n <> 0 then
    raise exception '% optimistic rows already carry a provider id', n;
  end if;

  select count(*) into n from message_log_adopt_backup_20261102
   where half = 'agent' and provider_id not like 'imsg:%';
  if n <> 0 then
    raise exception '% agent rows are not agent rows', n;
  end if;

  -- The pairs must not overlap, or a delete below would remove a row the
  -- update above just stamped.
  select count(*) into n from (
    select id from message_log_adopt_backup_20261102 where half='optimistic'
    intersect
    select id from message_log_adopt_backup_20261102 where half='agent') x;
  if n <> 0 then raise exception '% rows appear as both halves', n; end if;
end $$;

-- 1. Move the proof of delivery onto the row that carries the attribution.
update message_log m
   set provider_id = p.provider,
       delivery_status = 'delivered'
  from (values
    ('128b92bb-5855-4a0a-b8f8-55b0fc0eb3f5'::uuid, 'imsg:C4D6528E-D97E-4AE8-81CA-9112F7095407'),
    ('73847e54-784b-42e1-a86a-bf7a2a6bd5f8'::uuid, 'imsg:B0C25A29-7002-41C0-8169-759B33118A1A'),
    ('77127a7b-904d-4be2-a1f5-1db7487ff2b5'::uuid, 'imsg:329EBBFC-8C7E-4B2C-8891-9B37C779401E'),
    ('29f6b796-8c72-44f9-8303-b4b1769d56ba'::uuid, 'imsg:362FB280-B904-4100-98F2-966BEE571BC6'),
    ('304f7928-5317-4aed-ade0-a596d2142de1'::uuid, 'imsg:C57F9903-AB8C-4522-B26D-6EB05B74D94F'),
    ('06831194-a14a-4bd2-ae14-ccb68a82d7c0'::uuid, 'imsg:965DF747-A237-423B-8D3E-B82D38139261'),
    ('ccf75142-7e5c-4c98-968f-8ba540b5d187'::uuid, 'imsg:8588F081-6C06-40E9-8F0E-6A2F9016AFB5'),
    ('099a6fca-004b-4269-98e4-2232b651d4cd'::uuid, 'imsg:8EB2A7BB-58E5-40F5-ADD6-2703AA672425'),
    ('0eefda2b-c57e-4c52-b580-1ce723a5f8e9'::uuid, 'imsg:70270982-2397-4B08-852E-D10359F6D841'),
    ('fa0b8028-9132-4375-b6db-ef4d29923908'::uuid, 'imsg:2EB5674C-3354-448D-8AAA-562B1790A206'),
    ('661b4d81-4326-4ad4-9b02-ba51504263e1'::uuid, 'imsg:A26B75E6-8C2C-4102-91E0-AEFFCFEE85AC'),
    ('ed805bd5-8c03-4899-8237-72576808fe81'::uuid, 'imsg:422A8C40-3B3C-4915-A2AD-251133FA3AA4'),
    ('bf70d4f1-75eb-422f-b36e-2e181532392f'::uuid, 'imsg:60D40E3D-7165-49F1-9787-FB95CAF7EC2E'),
    ('a112e28b-cdab-4738-b6fa-fec0e823806d'::uuid, 'imsg:A56BCAE5-45E9-45F8-B08A-0EB7E7B42F54'),
    ('3d01a86d-59fd-4a77-a768-860b9e23ee51'::uuid, 'imsg:25B5FBA9-5760-4841-802B-D663231C8E98'),
    ('f19acc66-7010-4d62-87d2-441a1248a829'::uuid, 'imsg:2FB21152-5B0C-4E18-AD27-1AD55422588C'),
    ('c4895aef-5fad-4021-b67b-2666512c9048'::uuid, 'imsg:F3A095B0-D7CD-4CA4-BAD9-5D2557C03E91'),
    ('5d186953-2d65-42df-82f5-3f1f6274f288'::uuid, 'imsg:597E5506-FDFC-490C-B390-D67D7E430864'),
    ('9371b5ae-9a29-4982-83ac-907b057c5055'::uuid, 'imsg:571665EB-4B24-4149-AAA1-5E3FFD533830'),
    ('2c364958-f17d-4e60-99ec-ee7f5e3340ee'::uuid, 'imsg:379637BC-E58C-44AE-A959-C1E016D2CBA4'),
    ('186ef1c8-b5b7-44fc-b1da-da8ff0a0d68f'::uuid, 'imsg:8DB785C4-784B-4EE9-944D-583480416E03'),
    ('cbb188a0-65fd-41e7-a890-76f9d0447133'::uuid, 'imsg:FB31FC66-2674-4348-8544-798FCDD1E67A'),
    ('5a6c10c2-6b71-4678-b5c2-2540f73011bb'::uuid, 'imsg:3DE29F94-DBA8-4DFD-A2D5-E28C535B3EE7'),
    ('4a81bb07-5613-439c-86a7-fc80a91837bf'::uuid, 'imsg:7C8CD425-0DCA-4E47-BBD8-B615DC51CFE3'),
    ('d01ca810-ec78-4499-8864-76096a4ee669'::uuid, 'imsg:847EF189-614C-4279-A638-DDCBE0E152A4'),
    ('04d0cc9a-a2a7-45f8-ad80-463d683d4d26'::uuid, 'imsg:7BB297EE-A20F-41FD-9CA0-8A4A57516F49'),
    ('f256c730-1285-4b77-a5dd-64c9467aaa13'::uuid, 'imsg:F4E4A53E-8E50-45FB-BAA5-05AA00064D69'),
    ('8d540f8b-8dd0-4b22-8e2f-f6eaf649f0d5'::uuid, 'imsg:D69B53FF-64D5-4F48-825D-98AE8AEB0ABF')
       ) as p(optimistic, provider)
 where m.id = p.optimistic
   and m.provider_id is null;

-- 2. Remove the agent's duplicate copy.
delete from message_log where id in (
    '09f9f05a-f9b4-40b0-a887-605d1f4b3a6b',
    '0a28f5dc-ea7a-41a3-85d6-8c34ac8fcf2a',
    '0c1e5ed7-6c02-41b2-ba96-0b0cdb6c122a',
    '1314f7f3-2a23-4199-b8c2-3f24e759b99e',
    '13e8da10-5266-4b68-912c-44bcd85d2bda',
    '17f42651-e1ab-4c69-a78b-4218a62405ad',
    '185aa0c2-4678-486f-bbbe-f8bad773d448',
    '33fa8cb2-8f88-4760-af44-ce58b47a4737',
    '37df34d5-d61f-42ec-ab0e-866ff726ce49',
    '41b0f4fb-00c9-4837-bb0f-17bb32df2e9e',
    '580d45dc-05be-4001-8170-2669d8525f27',
    '58849157-d19d-4d06-b6fc-e68b67100e7a',
    '68e4bce6-3e73-411b-ab29-3f9fdfd35fbf',
    '6c2e0447-a3b0-4005-bd03-802250cd91fc',
    '6c3f8183-b347-4829-816c-ea8e5fef63f9',
    '7319a0a5-7352-4324-a322-5e5cc0864f2f',
    '738d2115-29cd-4829-915b-bb83e246d906',
    '774aebf2-d949-40d4-8683-d6c7aaeacd71',
    '7be9a018-b0ec-4bc6-a39c-ec4821c22c5d',
    '9098998b-7ffb-471c-a813-a0c11cb44ad8',
    '93c02631-27e3-48d2-bab9-fba7b893d82c',
    '97a241ae-8d92-4341-8386-8cc6e117bb42',
    '9f01d3ff-ccf8-4f66-92c0-986e63033824',
    'a865d0bb-e3b8-4ff0-8297-173785469ca5',
    'd023472f-ee91-41ab-9076-e3050d532fe1',
    'f5a85d5e-01ca-4025-a7fd-e521dcd3e35e',
    'f7ab8291-acaa-4b02-b70f-fa6e69a20c71',
    'fc4627b3-329f-4115-8594-22c27fc94478'
  );

-- Confirm the shape before committing.
do $$
declare stamped int; left_over int;
begin
  select count(*) into stamped from message_log
   where id in (select id from message_log_adopt_backup_20261102 where half='optimistic')
     and provider_id like 'imsg:%' and delivery_status = 'delivered';
  if stamped <> 28 then
    raise exception 'stamped % rows, expected 28', stamped;
  end if;

  select count(*) into left_over from message_log
   where id in (select id from message_log_adopt_backup_20261102 where half='agent');
  if left_over <> 0 then
    raise exception '% agent duplicates survived the delete', left_over;
  end if;

  raise notice 'linked % sends, removed % duplicates', stamped, 28;
end $$;

commit;

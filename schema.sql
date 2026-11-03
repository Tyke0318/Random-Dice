begin;

create schema meeting_private;
revoke all on schema meeting_private from public, anon, authenticated, service_role;

create table meeting_private.admins (
  user_id uuid primary key references auth.users on delete cascade
);

create table meeting_private.settings (
  singleton boolean primary key default true check (singleton),
  viewer_key uuid not null default gen_random_uuid()
);
insert into meeting_private.settings default values;

create table meeting_private.rounds (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 40),
  start_date date not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  schedule jsonb,
  check ((finished_at is null) = (schedule is null))
);

create table meeting_private.entries (
  round_id uuid not null references meeting_private.rounds,
  roster_order integer not null check (roster_order between 1 and 100),
  name text not null check (char_length(name) between 1 and 24),
  invite uuid not null default gen_random_uuid() unique,
  slot integer check (slot between 1 and 100),
  primary key (round_id, roster_order),
  unique (round_id, slot)
);
create unique index entries_unique_name on meeting_private.entries (round_id, lower(name));

alter table meeting_private.admins enable row level security;
alter table meeting_private.settings enable row level security;
alter table meeting_private.rounds enable row level security;
alter table meeting_private.entries enable row level security;
revoke all on all tables in schema meeting_private from public, anon, authenticated, service_role;

create function meeting_private.is_admin() returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from meeting_private.admins where user_id = auth.uid());
$$;

create function meeting_private.can_view(p_viewer uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from meeting_private.settings where viewer_key = p_viewer);
$$;

create function public.meeting_overview(p_viewer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_admin boolean := meeting_private.is_admin();
begin
  if not v_admin and not meeting_private.can_view(p_viewer) then
    raise exception '需要组内查看链接，或以管理员身份登录。' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'admin', v_admin,
    'viewer_key', case when v_admin then (select viewer_key from meeting_private.settings) end,
    'rounds', coalesce((
      select jsonb_agg(to_jsonb(summary) order by created_at desc, id)
      from (
        select r.id, r.name, r.start_date, r.created_at, r.finished_at,
          count(e.roster_order) as total, count(e.slot) as drawn
        from meeting_private.rounds r
        join meeting_private.entries e on e.round_id = r.id
        group by r.id
      ) summary
    ), '[]'::jsonb)
  );
end;
$$;

create function public.meeting_round(p_round uuid, p_viewer uuid, p_invite uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_admin boolean := meeting_private.is_admin();
  v_mine jsonb;
  v_result jsonb;
begin
  select jsonb_build_object('name', name, 'slot', slot) into v_mine
  from meeting_private.entries where round_id = p_round and invite = p_invite;
  if not v_admin and v_mine is null and not meeting_private.can_view(p_viewer) then
    raise exception '场次链接无效，或没有查看权限。' using errcode = '42501';
  end if;
  select to_jsonb(r) || jsonb_build_object(
    'admin', v_admin,
    'mine', v_mine,
    'entries', (
      select jsonb_agg(
        jsonb_build_object('name', e.name, 'slot', e.slot)
          || case when v_admin and r.finished_at is null and e.slot is null
             then jsonb_build_object('invite', e.invite) else '{}'::jsonb end
        order by e.slot nulls last, e.roster_order
      ) from meeting_private.entries e where e.round_id = r.id
    )
  ) into v_result from meeting_private.rounds r where r.id = p_round;
  if v_result is null then
    raise exception '找不到这个场次。';
  end if;
  return v_result;
end;
$$;

create function public.meeting_create(p_round uuid, p_name text, p_start date, p_names text[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_names text[];
begin
  if not meeting_private.is_admin() then
    raise exception '需要管理员权限。' using errcode = '42501';
  end if;
  p_name := btrim(p_name);
  if p_round is null or p_name is null or char_length(p_name) not between 1 and 40
     or p_start is null or p_start not between date '2000-01-01' and date '2100-12-31'
     or coalesce(cardinality(p_names), 0) not between 1 and 100 then
    raise exception '请填写场次名称、开始日期及 1–100 位组员。';
  end if;
  select array_agg(btrim(regexp_replace(name, '[[:space:]　]+', ' ', 'g')) order by n)
  into v_names from unnest(p_names) with ordinality as roster(name, n);
  if exists (select 1 from unnest(v_names) as n(name)
             where name is null or char_length(name) not between 1 and 24) then
    raise exception '每个组员姓名须为 1–24 字。';
  end if;
  if (select count(distinct lower(name)) from unnest(v_names) as n(name)) <> cardinality(v_names) then
    raise exception '名单有重复姓名，同名组员请加区分标记。';
  end if;

  insert into meeting_private.rounds (id, name, start_date) values (p_round, p_name, p_start)
  on conflict (id) do nothing;
  if found then
    insert into meeting_private.entries (round_id, roster_order, name)
    select p_round, n, name from unnest(v_names) with ordinality as roster(name, n);
  elsif not exists (
    select 1 from meeting_private.rounds r
    where r.id = p_round and r.name = p_name and r.start_date = p_start and v_names = (
      select array_agg(name order by roster_order) from meeting_private.entries where round_id = r.id
    )
  ) then
    raise exception '场次编号已使用，请刷新后重试。';
  end if;
  return p_round;
end;
$$;

create function public.meeting_draw(p_round uuid, p_invite uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_round meeting_private.rounds%rowtype;
  v_entry meeting_private.entries%rowtype;
  v_slot integer;
begin
  if not exists (
    select 1 from meeting_private.entries where round_id = p_round and invite = p_invite
  ) then
    raise exception '个人抽签链接无效。' using errcode = '42501';
  end if;
  -- All draws and finalization for this round take the same lock.
  select * into strict v_round from meeting_private.rounds where id = p_round for update;
  select * into strict v_entry from meeting_private.entries
    where round_id = p_round and invite = p_invite;
  if v_entry.slot is not null then
    return v_entry.slot;
  end if;
  if v_round.finished_at is not null then
    raise exception '抽签已结束。';
  end if;

  -- Choose uniformly among unclaimed slots using independent random UUIDs.
  select candidate into strict v_slot
  from generate_series(1, (select count(*)::int from meeting_private.entries where round_id = p_round))
    as slots(candidate)
  where not exists (
    select 1 from meeting_private.entries where round_id = p_round and slot = candidate
  )
  order by gen_random_uuid() limit 1;
  update meeting_private.entries set slot = v_slot
    where round_id = p_round and roster_order = v_entry.roster_order;
  return v_slot;
end;
$$;

create function public.meeting_finish(p_round uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_round meeting_private.rounds%rowtype;
  v_schedule jsonb;
begin
  if not meeting_private.is_admin() then
    raise exception '需要管理员权限。' using errcode = '42501';
  end if;
  select * into v_round from meeting_private.rounds where id = p_round for update;
  if not found then
    raise exception '找不到这个场次。';
  end if;
  if v_round.finished_at is not null then
    return;
  end if;
  if exists (select 1 from meeting_private.entries where round_id = p_round and slot is null) then
    raise exception '组员尚未全部抽签。';
  end if;

  select jsonb_agg(jsonb_build_object(
    'week', week + 1, 'date', v_round.start_date + 7 * week, 'speakers', speakers
  ) order by week) into v_schedule
  from (
    select (slot - 1) / 2 as week,
      jsonb_agg(jsonb_build_object('slot', slot, 'name', name) order by slot) as speakers
    from meeting_private.entries where round_id = p_round
    group by (slot - 1) / 2
  ) weeks;
  update meeting_private.rounds set finished_at = clock_timestamp(), schedule = v_schedule
    where id = p_round;
end;
$$;

revoke execute on all functions in schema meeting_private from public, anon, authenticated, service_role;
revoke execute on function public.meeting_overview(uuid), public.meeting_round(uuid, uuid, uuid),
  public.meeting_create(uuid, text, date, text[]), public.meeting_draw(uuid, uuid),
  public.meeting_finish(uuid) from public, anon, authenticated, service_role;
grant execute on function public.meeting_overview(uuid), public.meeting_round(uuid, uuid, uuid),
  public.meeting_draw(uuid, uuid) to anon, authenticated;
grant execute on function public.meeting_create(uuid, text, date, text[]),
  public.meeting_finish(uuid) to authenticated;

commit;

begin;

alter table meeting_private.rounds add column dice_mode boolean not null default false;
alter table meeting_private.entries
  add column die integer check (die between 1 and 6),
  drop constraint entries_roster_order_check,
  add constraint entries_roster_order_check check (roster_order > 0);

create table meeting_private.round_shares (
  round_id uuid primary key references meeting_private.rounds,
  share_key uuid not null unique default gen_random_uuid()
);
alter table meeting_private.round_shares enable row level security;
revoke all on meeting_private.round_shares from public, anon, authenticated, service_role;

create function public.meeting_group_share(p_group uuid, p_round uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform meeting_private.require_group(p_group);
  if not exists (select 1 from meeting_private.rounds where id = p_round) then
    raise exception '找不到这个场次。';
  end if;
  insert into meeting_private.round_shares (round_id) values (p_round)
    on conflict (round_id) do nothing;
  return (select share_key from meeting_private.round_shares where round_id = p_round);
end;
$$;

create function meeting_private.shared_round(p_share uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_round uuid;
begin
  select round_id into v_round from meeting_private.round_shares where share_key = p_share;
  if not found then
    raise exception '场次链接无效。' using errcode = '42501';
  end if;
  return v_round;
end;
$$;
revoke execute on function meeting_private.shared_round(uuid) from public, anon, authenticated, service_role;

create function public.meeting_share_round(p_share uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return public.meeting_group_round((select group_key from meeting_private.settings),
    meeting_private.shared_round(p_share)) - 'id';
end;
$$;

create or replace function public.meeting_group_overview(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform meeting_private.require_group(p_group);
  return jsonb_build_object('rounds', coalesce((
    select jsonb_agg(to_jsonb(summary) order by created_at desc, id)
    from (
      select r.id, r.name, r.start_date, r.created_at, r.finished_at, r.dice_mode,
        count(e.roster_order) as total,
        count(*) filter (where e.die is not null or e.slot is not null) as drawn
      from meeting_private.rounds r
      left join meeting_private.entries e on e.round_id = r.id
      group by r.id
    ) summary
  ), '[]'::jsonb));
end;
$$;

create or replace function public.meeting_group_round(p_group uuid, p_round uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  perform meeting_private.require_group(p_group);
  select to_jsonb(r) || jsonb_build_object('entries', coalesce((
    select jsonb_agg(jsonb_build_object('name', e.name, 'slot', e.slot, 'die', e.die)
      order by e.roster_order)
    from meeting_private.entries e where e.round_id = r.id
  ), '[]'::jsonb)) into v_result from meeting_private.rounds r where r.id = p_round;
  if v_result is null then
    raise exception '找不到这个场次。';
  end if;
  return v_result;
end;
$$;

create function public.meeting_group_create_dice(p_group uuid, p_round uuid, p_name text, p_start date) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform meeting_private.require_group(p_group);
  p_name := btrim(p_name);
  if p_round is null or p_name is null or char_length(p_name) not between 1 and 40
     or p_start is null or p_start not between date '2000-01-01' and date '2100-12-31' then
    raise exception '请填写场次名称和开始日期。';
  end if;
  insert into meeting_private.rounds(id, name, start_date, dice_mode)
    values (p_round, p_name, p_start, true) on conflict (id) do nothing;
  if not found and not exists (
    select 1 from meeting_private.rounds where id = p_round and dice_mode and name = p_name and start_date = p_start
  ) then
    raise exception '场次编号已使用，请刷新后重试。';
  end if;
  return p_round;
end;
$$;

create function meeting_private.roll_dice(p_round uuid, p_name text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_round meeting_private.rounds%rowtype;
  v_die integer;
  v_order integer;
begin
  p_name := btrim(regexp_replace(p_name, '[[:space:]　]+', ' ', 'g'));
  if p_name is null or char_length(p_name) not between 1 and 24 then
    raise exception '请填写 1–24 字的姓名。';
  end if;
  -- Serialize registration, retries, and finalization for the round.
  select * into v_round from meeting_private.rounds where id = p_round for update;
  if not found or not v_round.dice_mode then
    raise exception '找不到这个掷骰场次。';
  end if;
  select die into v_die from meeting_private.entries
    where round_id = p_round and lower(name) = lower(p_name);
  if found then
    return v_die;
  end if;
  if v_round.finished_at is not null then
    raise exception '此场次已归档。';
  end if;
  select coalesce(max(roster_order), 0) + 1 into v_order
    from meeting_private.entries where round_id = p_round;
  v_die := floor(random() * 6)::integer + 1;
  insert into meeting_private.entries(round_id, roster_order, name, die)
    values (p_round, v_order, p_name, v_die);
  return v_die;
end;
$$;
revoke execute on function meeting_private.roll_dice(uuid, text) from public, anon, authenticated, service_role;

create function public.meeting_group_roll(p_group uuid, p_round uuid, p_name text) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform meeting_private.require_group(p_group);
  return meeting_private.roll_dice(p_round, p_name);
end;
$$;

create function public.meeting_share_draw(p_share uuid, p_name text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_round uuid := meeting_private.shared_round(p_share);
  v_name text;
begin
  if exists (select 1 from meeting_private.rounds where id = v_round and dice_mode) then
    return meeting_private.roll_dice(v_round, p_name);
  end if;
  select name into v_name from meeting_private.entries
    where round_id = v_round and lower(name) = lower(btrim(regexp_replace(p_name, '[[:space:]　]+', ' ', 'g')));
  if not found then
    raise exception '姓名不在本场名单中。';
  end if;
  return public.meeting_group_draw((select group_key from meeting_private.settings), v_round, v_name);
end;
$$;

create or replace function public.meeting_draw(p_round uuid, p_invite uuid) returns integer
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
  if v_round.dice_mode then
    raise exception '请使用本场掷骰链接。';
  end if;
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

create or replace function public.meeting_group_finish(p_group uuid, p_round uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_round meeting_private.rounds%rowtype;
  v_schedule jsonb;
begin
  perform meeting_private.require_group(p_group);
  select * into v_round from meeting_private.rounds where id = p_round for update;
  if not found then
    raise exception '找不到这个场次。';
  end if;
  if v_round.finished_at is not null then
    return;
  end if;
  if not exists (select 1 from meeting_private.entries where round_id = p_round) then
    raise exception '还没有人抽签。';
  end if;
  if not v_round.dice_mode and exists (
    select 1 from meeting_private.entries where round_id = p_round and slot is null
  ) then
    raise exception '组员尚未全部抽签。';
  end if;

  with ranked as (
    select name, die, row_number() over (order by slot nulls last, die, roster_order)::integer as position
    from meeting_private.entries where round_id = p_round
  ), weeks as (
    select (position - 1) / 2 as week,
      jsonb_agg(jsonb_strip_nulls(jsonb_build_object('slot', position, 'name', name, 'die', die))
        order by position) as speakers
    from ranked group by (position - 1) / 2
  )
  select jsonb_agg(jsonb_build_object(
    'week', week + 1, 'date', v_round.start_date + 7 * week, 'speakers', speakers
  ) order by week) into v_schedule from weeks;

  update meeting_private.rounds set finished_at = clock_timestamp(), schedule = v_schedule where id = p_round;
end;
$$;

revoke execute on function public.meeting_group_share(uuid, uuid), public.meeting_share_round(uuid),
  public.meeting_share_draw(uuid, text), public.meeting_group_create_dice(uuid, uuid, text, date),
  public.meeting_group_roll(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.meeting_group_share(uuid, uuid), public.meeting_share_round(uuid),
  public.meeting_share_draw(uuid, text), public.meeting_group_create_dice(uuid, uuid, text, date),
  public.meeting_group_roll(uuid, uuid, text) to anon, authenticated;

commit;

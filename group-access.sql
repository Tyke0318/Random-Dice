begin;

-- Generate a fresh write-capable link. Old read-only links keep their original rights.
alter table meeting_private.settings
  add column group_key uuid not null default gen_random_uuid();

create function meeting_private.require_group(p_group uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from meeting_private.settings where group_key = p_group) then
    raise exception '群链接无效，请从课题组群里重新打开。' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function meeting_private.require_group(uuid) from public, anon, authenticated, service_role;

create function public.meeting_group_overview(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform meeting_private.require_group(p_group);
  return public.meeting_overview((select viewer_key from meeting_private.settings)) - 'admin' - 'viewer_key';
end;
$$;

create function public.meeting_group_round(p_group uuid, p_round uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  perform meeting_private.require_group(p_group);
  select to_jsonb(r) || jsonb_build_object('entries', (
    select jsonb_agg(jsonb_build_object('name', e.name, 'slot', e.slot)
      order by e.roster_order)
    from meeting_private.entries e where e.round_id = r.id
  )) into v_result from meeting_private.rounds r where r.id = p_round;
  if v_result is null then
    raise exception '找不到这个场次。';
  end if;
  return v_result;
end;
$$;

create function public.meeting_group_draw(p_group uuid, p_round uuid, p_name text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_invite uuid;
begin
  perform meeting_private.require_group(p_group);
  select invite into v_invite from meeting_private.entries where round_id = p_round and name = p_name;
  if not found then
    raise exception '请从本场名单选择姓名。';
  end if;
  -- The existing draw function locks the round and handles retries atomically.
  return public.meeting_draw(p_round, v_invite);
end;
$$;

create function public.meeting_group_edit(p_group uuid, p_round uuid, p_name text, p_start date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform meeting_private.require_group(p_group);
  p_name := btrim(p_name);
  if p_name is null or char_length(p_name) not between 1 and 40
     or p_start is null or p_start not between date '2000-01-01' and date '2100-12-31' then
    raise exception '请填写有效的场次名称和开始日期。';
  end if;
  -- UPDATE and finalization take the same row lock; the condition is rechecked on a concurrent close.
  update meeting_private.rounds set name = p_name, start_date = p_start
    where id = p_round and finished_at is null;
  if not found then
    raise exception '找不到这个场次，或场次已归档。';
  end if;
end;
$$;

create function public.meeting_group_create(p_group uuid, p_round uuid, p_name text, p_start date, p_names text[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_names text[];
begin
  perform meeting_private.require_group(p_group);
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

create function public.meeting_group_finish(p_group uuid, p_round uuid) returns void
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

revoke execute on function public.meeting_group_overview(uuid), public.meeting_group_round(uuid, uuid),
  public.meeting_group_create(uuid, uuid, text, date, text[]), public.meeting_group_edit(uuid, uuid, text, date),
  public.meeting_group_draw(uuid, uuid, text), public.meeting_group_finish(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.meeting_group_overview(uuid), public.meeting_group_round(uuid, uuid),
  public.meeting_group_create(uuid, uuid, text, date, text[]), public.meeting_group_edit(uuid, uuid, text, date),
  public.meeting_group_draw(uuid, uuid, text), public.meeting_group_finish(uuid, uuid)
  to anon, authenticated;

commit;

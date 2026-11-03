begin;

-- Drawing remains closed when its archived schedule is removed.
alter table meeting_private.rounds
  drop constraint rounds_check,
  add constraint rounds_schedule_requires_finish check (schedule is null or finished_at is not null);

create function public.meeting_group_delete_schedule(p_group uuid, p_round uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform meeting_private.require_group(p_group);
  update meeting_private.rounds set schedule = null
    where id = p_round and schedule is not null and finished_at is not null;
end;
$$;
revoke execute on function public.meeting_group_delete_schedule(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.meeting_group_delete_schedule(uuid, uuid)
  to anon, authenticated;

create or replace function public.meeting_group_overview(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform meeting_private.require_group(p_group);
  return jsonb_build_object('rounds', coalesce((
    select jsonb_agg(to_jsonb(summary) order by created_at desc, id)
    from (
      select r.id, r.name, r.start_date, r.created_at, r.finished_at, r.dice_mode,
        r.schedule is not null as has_schedule,
        count(e.roster_order) as total,
        count(*) filter (where e.die is not null or e.slot is not null) as drawn
      from meeting_private.rounds r
      left join meeting_private.entries e on e.round_id = r.id
      group by r.id
    ) summary
  ), '[]'::jsonb));
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
  if v_round.schedule is not null then
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

  update meeting_private.rounds set finished_at = coalesce(v_round.finished_at, clock_timestamp()), schedule = v_schedule where id = p_round;
end;
$$;

commit;

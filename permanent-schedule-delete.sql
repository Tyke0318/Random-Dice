begin;

-- Clearing a closed round's snapshot permanently removes its archive.
create function meeting_private.reject_archive_restore() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '排班已永久删除。';
end;
$$;
revoke execute on function meeting_private.reject_archive_restore()
  from public, anon, authenticated, service_role;

create trigger reject_archive_restore
  before update of schedule on meeting_private.rounds
  for each row
  when (old.finished_at is not null and old.schedule is null and new.schedule is not null)
  execute function meeting_private.reject_archive_restore();

drop function public.meeting_share_delete_schedule(uuid);

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
      where r.finished_at is null or r.schedule is not null
      group by r.id
    ) summary
  ), '[]'::jsonb));
end;
$$;

commit;

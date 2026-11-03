begin;

-- A shared link can operate on its own round only.
create function public.meeting_share_edit(p_share uuid, p_name text, p_start date) returns void
language sql security definer set search_path = '' as $$
  select public.meeting_group_edit((select group_key from meeting_private.settings),
    meeting_private.shared_round(p_share), p_name, p_start);
$$;

create function public.meeting_share_finish(p_share uuid) returns void
language sql security definer set search_path = '' as $$
  select public.meeting_group_finish((select group_key from meeting_private.settings),
    meeting_private.shared_round(p_share));
$$;

create function public.meeting_share_delete_schedule(p_share uuid) returns void
language sql security definer set search_path = '' as $$
  select public.meeting_group_delete_schedule((select group_key from meeting_private.settings),
    meeting_private.shared_round(p_share));
$$;

revoke execute on function public.meeting_share_edit(uuid, text, date),
  public.meeting_share_finish(uuid), public.meeting_share_delete_schedule(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.meeting_share_edit(uuid, text, date),
  public.meeting_share_finish(uuid), public.meeting_share_delete_schedule(uuid)
  to anon, authenticated;

commit;

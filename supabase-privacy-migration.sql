create table if not exists public.fund_members (
    fund_id text not null check (fund_id in ('fund', 'activitiesFund')),
    member_index integer not null check (member_index >= 0),
    display_name text not null,
    birthday text,
    primary key (fund_id, member_index)
);

create table if not exists public.fund_member_accounts (
    fund_id text not null,
    member_index integer not null,
    user_id uuid not null references auth.users (id) on delete cascade,
    primary key (fund_id, member_index),
    unique (fund_id, user_id),
    foreign key (fund_id, member_index)
        references public.fund_members (fund_id, member_index) on delete cascade
);

create table if not exists public.fund_activities_viewers (
    user_id uuid primary key references auth.users (id) on delete cascade,
    member_index integer not null unique,
    fund_id text not null default 'activitiesFund'
        check (fund_id = 'activitiesFund'),
    foreign key (fund_id, member_index)
        references public.fund_members (fund_id, member_index) on delete cascade
);

alter table public.fund_members enable row level security;
alter table public.fund_member_accounts enable row level security;
alter table public.fund_activities_viewers enable row level security;
alter table public.fund_admins enable row level security;

revoke all on public.fund_members from anon, authenticated;
revoke all on public.fund_member_accounts from anon, authenticated;
revoke all on public.fund_activities_viewers from anon, authenticated;
grant select on public.fund_admins to authenticated;

drop policy if exists "Admins can view their own membership" on public.fund_admins;
create policy "Admins can view their own membership"
    on public.fund_admins for select
    to authenticated
    using (user_id = (select auth.uid()));

drop policy if exists "Anyone can view fund ledgers" on public.fund_ledgers;
drop policy if exists "Fund admins can view ledgers" on public.fund_ledgers;
drop policy if exists "Fund admins can insert ledgers" on public.fund_ledgers;
drop policy if exists "Fund admins can update ledgers" on public.fund_ledgers;

revoke all on public.fund_ledgers from anon;
revoke all on public.fund_ledgers from authenticated;
grant select, update on public.fund_ledgers to authenticated;

create policy "Fund admins can view ledgers"
    on public.fund_ledgers for select
    to authenticated
    using (
        exists (
            select 1
            from public.fund_admins
            where user_id = (select auth.uid())
        )
    );

create policy "Fund admins can insert ledgers"
    on public.fund_ledgers for insert
    to authenticated
    with check (
        exists (
            select 1
            from public.fund_admins
            where user_id = (select auth.uid())
        )
    );

create policy "Fund admins can update ledgers"
    on public.fund_ledgers for update
    to authenticated
    using (
        exists (
            select 1
            from public.fund_admins
            where user_id = (select auth.uid())
        )
    )
    with check (
        exists (
            select 1
            from public.fund_admins
            where user_id = (select auth.uid())
        )
    );

create or replace function public.read_fund_ledger(p_fund_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_role text;
    v_member_index integer;
    v_data jsonb;
    v_revision bigint;
    v_updated_at timestamptz;
    v_members jsonb;
    v_monthly jsonb;
    v_receipts jsonb := '[]'::jsonb;
    v_expenses jsonb := '[]'::jsonb;
    v_receipt jsonb;
    v_expense jsonb;
    v_share jsonb;
    v_own_share jsonb;
    v_filtered_expense jsonb;
begin
    if v_user_id is null or p_fund_id not in ('fund', 'activitiesFund') then
        raise exception using errcode = '42501', message = 'Access denied.';
    end if;

    if exists (
        select 1 from public.fund_admins where user_id = v_user_id
    ) then
        v_role := 'admin';
    elsif p_fund_id = 'fund' then
        select member_index into v_member_index
        from public.fund_member_accounts
        where fund_id = p_fund_id and user_id = v_user_id;
        if found then
            v_role := 'community_member';
        end if;
    else
        select member_index into v_member_index
        from public.fund_activities_viewers
        where fund_id = p_fund_id and user_id = v_user_id;
        if found then
            v_role := 'activities_viewer';
        end if;
    end if;

    if v_role is null then
        raise exception using errcode = '42501', message = 'Access denied.';
    end if;

    select data, revision, updated_at
    into v_data, v_revision, v_updated_at
    from public.fund_ledgers
    where fund_id = p_fund_id;

    if not found then
        raise exception using errcode = 'P0002', message = 'Fund ledger not found.';
    end if;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'name', display_name,
                'birthday', birthday
            )
            order by member_index
        ),
        '[]'::jsonb
    )
    into v_members
    from public.fund_members
    where fund_id = p_fund_id
      and (
          v_role in ('admin', 'activities_viewer')
          or member_index = v_member_index
      );

    if v_role = 'community_member' then
        select coalesce(
            jsonb_object_agg(
                month_entry.key,
                jsonb_build_array(
                    coalesce(
                        month_entry.value -> v_member_index,
                        '[false, false, false, false]'::jsonb
                    )
                )
            ),
            '{}'::jsonb
        )
        into v_monthly
        from jsonb_each(coalesce(v_data -> 'monthlyContributions', '{}'::jsonb))
            as month_entry(key, value);

        select coalesce(
            jsonb_agg(
                jsonb_set(receipt.value, '{memberIndex}', '0'::jsonb, true)
                order by receipt.value ->> 'date'
            ),
            '[]'::jsonb
        )
        into v_receipts
        from jsonb_array_elements(coalesce(v_data -> 'receipts', '[]'::jsonb))
            as receipt(value)
        where (receipt.value ->> 'memberIndex')::integer = v_member_index;

        for v_expense in
            select expense.value
            from jsonb_array_elements(coalesce(v_data -> 'expenses', '[]'::jsonb))
                as expense(value)
        loop
            select share.value
            into v_share
            from jsonb_array_elements(coalesce(v_expense -> 'shares', '[]'::jsonb))
                as share(value)
            where (share.value ->> 'memberIndex')::integer = v_member_index
            limit 1;

            if found then
                v_own_share := jsonb_set(v_share, '{memberIndex}', '0'::jsonb, true);
                v_filtered_expense := jsonb_set(
                    v_expense,
                    '{shares}',
                    jsonb_build_array(v_own_share),
                    true
                );
                v_filtered_expense := jsonb_set(
                    v_filtered_expense,
                    '{costCents}',
                    coalesce(v_own_share -> 'amountCents', '0'::jsonb),
                    true
                );
                v_expenses := v_expenses || jsonb_build_array(v_filtered_expense);
            end if;
        end loop;

        v_data := jsonb_build_object(
            'monthlyContributions', v_monthly,
            'receipts', v_receipts,
            'expenses', v_expenses
        );
    elsif v_role = 'activities_viewer' then
        select coalesce(
            jsonb_agg(receipt.value order by receipt.value ->> 'date'),
            '[]'::jsonb
        )
        into v_receipts
        from jsonb_array_elements(coalesce(v_data -> 'receipts', '[]'::jsonb))
            as receipt(value)
        where (receipt.value ->> 'memberIndex')::integer = v_member_index;

        v_data := jsonb_set(v_data, '{receipts}', v_receipts, true);
    end if;

    return jsonb_build_object(
        'role', v_role,
        'memberIndex', v_member_index,
        'members', v_members,
        'data', v_data,
        'revision', v_revision,
        'updatedAt', v_updated_at
    );
end;
$$;

revoke all on function public.read_fund_ledger(text) from public;
revoke all on function public.read_fund_ledger(text) from anon;
grant execute on function public.read_fund_ledger(text) to authenticated;

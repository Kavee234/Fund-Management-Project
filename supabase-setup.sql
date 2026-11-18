create table if not exists public.fund_ledgers (
    fund_id text primary key,
    data jsonb not null,
    revision bigint not null default 1,
    updated_at timestamptz not null default now()
);

create table if not exists public.fund_admins (
    user_id uuid primary key references auth.users (id) on delete cascade
);

alter table public.fund_ledgers enable row level security;
alter table public.fund_admins enable row level security;

revoke all on public.fund_ledgers from anon;
grant select on public.fund_ledgers to authenticated;
grant insert, update on public.fund_ledgers to authenticated;
grant select on public.fund_admins to authenticated;

drop policy if exists "Anyone can view fund ledgers" on public.fund_ledgers;
drop policy if exists "Fund admins can view ledgers" on public.fund_ledgers;
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

drop policy if exists "Fund admins can insert ledgers" on public.fund_ledgers;
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

drop policy if exists "Fund admins can update ledgers" on public.fund_ledgers;
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

drop policy if exists "Admins can view their own membership" on public.fund_admins;
create policy "Admins can view their own membership"
    on public.fund_admins for select
    to authenticated
    using (user_id = (select auth.uid()));

insert into public.fund_ledgers (fund_id, data)
values
    ('fund', jsonb_build_object(
        'monthlyContributions', '{}'::jsonb,
        'receipts', '[]'::jsonb,
        'expenses', '[]'::jsonb
    )),
    ('activitiesFund', jsonb_build_object(
        'monthlyContributions', '{}'::jsonb,
        'receipts', '[]'::jsonb,
        'expenses', '[]'::jsonb
    ))
on conflict (fund_id) do nothing;

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'fund_ledgers'
    ) then
        alter publication supabase_realtime add table public.fund_ledgers;
    end if;
end
$$;

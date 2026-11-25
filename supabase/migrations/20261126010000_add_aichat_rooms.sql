create table if not exists public.aichat_rooms (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid,
    room_number integer,
    title text not null default '新しいチャット'
        check (char_length(btrim(title)) between 1 and 100),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.aichat_rooms
    add column if not exists owner_id uuid;

alter table public.aichat_rooms
    add column if not exists room_number integer;

update public.aichat_rooms
set owner_id = id
where owner_id is null;

update public.aichat_rooms
set room_number = 1
where room_number is null;

alter table public.aichat_rooms
    alter column owner_id set not null,
    alter column room_number set not null;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'public.aichat_rooms'::regclass
          and conname = 'aichat_rooms_room_number_positive'
    ) then
        alter table public.aichat_rooms
            add constraint aichat_rooms_room_number_positive
            check (room_number > 0);
    end if;
end
$$;

insert into public.aichat_rooms
    (id, owner_id, room_number, title, created_at, updated_at)
select
    messages.conversation_id,
    messages.conversation_id,
    1,
    coalesce(
        (
            select left(btrim(first_message.content), 50)
            from public.aichat_messages as first_message
            where first_message.conversation_id = messages.conversation_id
              and first_message.sender = 'user'
            order by first_message.created_at, first_message.id
            limit 1
        ),
        '過去のチャット'
    ),
    min(messages.created_at),
    max(messages.created_at)
from public.aichat_messages as messages
group by messages.conversation_id
on conflict (id) do nothing;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'public.aichat_messages'::regclass
          and conname = 'aichat_messages_conversation_id_fkey'
    ) then
        alter table public.aichat_messages
            add constraint aichat_messages_conversation_id_fkey
            foreign key (conversation_id)
            references public.aichat_rooms (id);
    end if;
end
$$;

create index if not exists aichat_rooms_updated_idx
    on public.aichat_rooms (updated_at desc, id desc);

create unique index if not exists aichat_rooms_owner_room_idx
    on public.aichat_rooms (owner_id, room_number);

alter table public.aichat_rooms enable row level security;

revoke all on public.aichat_rooms from anon, authenticated;
grant select, insert, update on public.aichat_rooms to service_role;

create or replace function public.update_aichat_room_from_message()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    update public.aichat_rooms
    set
        updated_at = greatest(updated_at, new.created_at),
        title = case
            when new.sender = 'user' and title = '新しいチャット'
                then left(btrim(new.content), 50)
            else title
        end
    where id = new.conversation_id;

    return new;
end;
$$;

drop trigger if exists aichat_messages_update_room
    on public.aichat_messages;

create trigger aichat_messages_update_room
after insert on public.aichat_messages
for each row
execute function public.update_aichat_room_from_message();

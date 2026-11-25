create table if not exists public.aichat_messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null,
    sender text not null check (sender in ('user', 'assistant')),
    content text not null check (char_length(btrim(content)) > 0),
    created_at timestamptz not null default now()
);

create index if not exists aichat_messages_conversation_idx
    on public.aichat_messages (conversation_id, created_at, id);

alter table public.aichat_messages enable row level security;

revoke all on public.aichat_messages from anon, authenticated;
grant select, insert on public.aichat_messages to service_role;

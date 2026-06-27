-- Enable pgcrypto for gen_random_bytes
create extension if not exists pgcrypto;

-- ─── Profiles ────────────────────────────────────────────────────────────────
create table if not exists profiles (
  id         uuid references auth.users on delete cascade primary key,
  name       text,
  created_at timestamptz default now() not null
);

alter table profiles enable row level security;

create policy "Users can read own profile"   on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- ─── API Keys ─────────────────────────────────────────────────────────────────
-- One key per user (unique on user_id)
create table if not exists api_keys (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users on delete cascade not null unique,
  key        text unique not null,
  name       text not null default 'Default',
  created_at timestamptz default now() not null
);

alter table api_keys enable row level security;

create policy "Users can read own API keys"  on api_keys for select using (auth.uid() = user_id);
-- Insert/delete handled by service role in server actions (bypasses RLS)

-- ─── Trigger: provision profile + API key on signup ──────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.profiles (id, name)
    values (new.id, new.raw_user_meta_data->>'name');

  insert into public.api_keys (user_id, key, name)
    values (
      new.id,
      'sk-' || translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_'),
      'Default'
    );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 001_meetups.sql
-- 組隊 / Meetups：使用者發起 → 管理員審核 → 其他人 +1 加入
-- 在 Supabase Dashboard → SQL Editor 整段貼上執行（可重複執行）

-- ───────── 資料表 ─────────
create table if not exists public.meetups (
  id            uuid primary key default gen_random_uuid(),
  host_id       text        not null,                       -- 發起者的 device id（不對外公開）
  host_name     text        not null check (char_length(host_name) between 1 and 30),
  title         text        not null check (char_length(title) between 3 and 80),
  description   text        not null default '' check (char_length(description) <= 1000),
  location      text        not null default '' check (char_length(location) <= 120),
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  starts_at     timestamptz not null,
  max_people    int         not null check (max_people between 2 and 50),
  tags          text[]      not null default '{}',
  status        text        not null default 'pending'
                check (status in ('pending','approved','rejected','cancelled')),
  reject_reason text,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz
);

create index if not exists meetups_status_starts_idx on public.meetups (status, starts_at);
create index if not exists meetups_host_idx          on public.meetups (host_id);

create table if not exists public.meetup_members (
  meetup_id    uuid not null references public.meetups(id) on delete cascade,
  user_id      text not null,
  display_name text not null check (char_length(display_name) between 1 and 30),
  joined_at    timestamptz not null default now(),
  primary key (meetup_id, user_id)
);

create index if not exists meetup_members_user_idx on public.meetup_members (user_id);

-- ───────── 發起者自動算 1 人 ─────────
create or replace function public.meetups_add_host()
returns trigger language plpgsql as $$
begin
  insert into public.meetup_members (meetup_id, user_id, display_name)
  values (new.id, new.host_id, new.host_name);
  return new;
end $$;

drop trigger if exists trg_meetups_add_host on public.meetups;
create trigger trg_meetups_add_host
  after insert on public.meetups
  for each row execute function public.meetups_add_host();

-- ───────── 加入（鎖列檢查人數，避免多人同時按超賣）─────────
create or replace function public.join_meetup(p_meetup uuid, p_user text, p_name text)
returns jsonb language plpgsql as $$
declare
  m   public.meetups%rowtype;
  cnt int;
begin
  select * into m from public.meetups where id = p_meetup for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if m.status <> 'approved' then
    return jsonb_build_object('ok', false, 'code', 'not_open');
  end if;
  if m.starts_at < now() then
    return jsonb_build_object('ok', false, 'code', 'ended');
  end if;

  if exists (select 1 from public.meetup_members
             where meetup_id = p_meetup and user_id = p_user) then
    select count(*) into cnt from public.meetup_members where meetup_id = p_meetup;
    return jsonb_build_object('ok', true, 'already', true, 'member_count', cnt);
  end if;

  select count(*) into cnt from public.meetup_members where meetup_id = p_meetup;
  if cnt >= m.max_people then
    return jsonb_build_object('ok', false, 'code', 'full');
  end if;

  insert into public.meetup_members (meetup_id, user_id, display_name)
  values (p_meetup, p_user, p_name);

  return jsonb_build_object('ok', true, 'already', false, 'member_count', cnt + 1);
end $$;

-- ───────── 權限：資料表只讓後端（secret key）存取 ─────────
alter table public.meetups        enable row level security;
alter table public.meetup_members enable row level security;
-- 不建立任何 policy = anon / publishable key 完全讀不到。後端必須改用 secret key。

-- 建議順便把既有的 events 也鎖起來（後端改用 secret key 後不受影響）：
-- alter table public.events enable row level security;

notify pgrst, 'reload schema';

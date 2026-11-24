-- 002_trips.sql
-- 行程分享：行程平常存在手機本機，按「Share」時才上傳快照，用 8 碼短代碼取回
-- 在 Supabase Dashboard → SQL Editor 貼上執行（可重複執行）

create table if not exists public.trips (
  code        text primary key check (code ~ '^[2-9A-HJKMNP-Z]{8}$'),
  owner_id    text        not null,                         -- 分享者的 device id（不對外公開）
  title       text        not null check (char_length(title) between 1 and 80),
  data        jsonb       not null check (octet_length(data::text) <= 60000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists trips_owner_idx on public.trips (owner_id);

-- 只讓後端（secret key）存取
alter table public.trips enable row level security;

notify pgrst, 'reload schema';

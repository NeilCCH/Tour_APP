-- Tour_APP 資料表 + 安全規則（Row Level Security）
-- =============================================================================
-- 用法:Supabase 主控台 → 左側「SQL Editor」→ New query → 貼上整段 → 按 Run。
-- 可重複執行(重跑不會出錯)。
-- =============================================================================

-- 三張表結構相同:
--   id         每筆資料的唯一碼(由 App 產生,本地與雲端共用同一個)
--   user_id    擁有者(自動填入登入者,靠它做權限隔離)
--   data       整筆資料本體(JSON,App 的欄位都放這裡,日後加欄位不用改表)
--   updated_at 最後修改時間(毫秒),雙向同步以較新者為準
--   deleted    軟刪除標記,讓「刪除」也能同步到別的裝置

create table if not exists public.trips (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0,
  deleted boolean not null default false
);

create table if not exists public.places (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0,
  deleted boolean not null default false
);

create table if not exists public.moments (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0,
  deleted boolean not null default false
);

-- 開啟 Row Level Security(沒有下面的政策,任何人都讀不到任何資料)
alter table public.trips   enable row level security;
alter table public.places  enable row level security;
alter table public.moments enable row level security;

-- 政策:每個人只能讀寫「自己的」資料
drop policy if exists "own trips"   on public.trips;
drop policy if exists "own places"  on public.places;
drop policy if exists "own moments" on public.moments;

create policy "own trips"   on public.trips   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own places"  on public.places  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own moments" on public.moments for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 授權:登入使用者可透過 API 存取(實際能存取哪些列,仍受上面 RLS 限制)
grant all on public.trips   to authenticated;
grant all on public.places  to authenticated;
grant all on public.moments to authenticated;

-- ===========================================================================
-- 公開分享(唯讀):允許「未登入的人」讀取被標為 public 的資料。
-- 開啟某趟「公開分享」時,App 會把該趟與其地點的 data.public 設為 true;
-- 下面的規則讓匿名者只能讀到這些被公開的列,其餘一律讀不到。
-- ===========================================================================
grant select on public.trips   to anon;
grant select on public.places  to anon;
grant select on public.moments to anon;

drop policy if exists "public read trips"   on public.trips;
drop policy if exists "public read places"  on public.places;
drop policy if exists "public read moments" on public.moments;

create policy "public read trips"   on public.trips   for select using ((data->>'public')::boolean is true);
create policy "public read places"  on public.places  for select using ((data->>'public')::boolean is true);
create policy "public read moments" on public.moments for select using ((data->>'public')::boolean is true);

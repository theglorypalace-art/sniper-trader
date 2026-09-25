-- Run this once in the Supabase SQL editor for your project.
-- This is the shared "brain" between the always-on engine, the Telegram
-- bot, and the web dashboard — all three read/write the same tables, so
-- a change from any one of them shows up in the others within seconds.

-- ---------------------------------------------------------------------
-- bot_config: exactly one row. Every filter that should be adjustable
-- live (no redeploy) lives here instead of in .env. The engine polls +
-- subscribes to this table and applies changes without restarting.
-- ---------------------------------------------------------------------
create table if not exists bot_config (
  id smallint primary key default 1,
  paused boolean not null default false,
  enable_solana boolean not null default true,
  enable_bsc boolean not null default false,
  min_recommend_tier text not null default 'LOW', -- 'LOW' or 'LOW_MEDIUM'
  max_tokens_per_day integer not null default 5,
  max_dev_percent numeric not null default 30,
  max_top10_percent numeric not null default 70,
  capital_pct numeric not null default 5,
  max_position_sol numeric not null default 0.5,
  bsc_capital_pct numeric not null default 5,
  bsc_max_position_bnb numeric not null default 0.1,
  take_profit_pct numeric not null default 0,   -- 0 = auto by risk tier
  stop_loss_pct numeric not null default 0,     -- 0 = auto by risk tier (positive: 25 = -25%)
  max_hold_min numeric not null default 0,      -- 0 = auto by risk tier
  max_risk_score numeric not null default 50,   -- entry quality gate (LOW <= 25, MEDIUM <= 50)
  heartbeat_min integer not null default 60,    -- 0 = off
  updated_at timestamptz not null default now(),
  updated_by text -- 'telegram', 'dashboard', 'default'
);

insert into bot_config (id) values (1) on conflict (id) do nothing;

-- Keep updated_at current on every change, so subscribers can tell a row
-- actually changed vs. a no-op write.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists bot_config_updated_at on bot_config;
create trigger bot_config_updated_at
  before update on bot_config
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- assessments: every token the engine ever evaluates, pass or fail —
-- this is the "instant feedback" feed the dashboard/Telegram read from.
-- ---------------------------------------------------------------------
create table if not exists assessments (
  id bigint generated always as identity primary key,
  chain text not null,             -- 'solana' | 'bsc'
  address text not null,
  verdict text not null,           -- 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNSAFE'
  recommended boolean not null default false,
  category text,
  is_community_coin boolean,
  dev_percent numeric,
  top10_percent numeric,
  curve_progress_pct numeric,
  migrated boolean,
  score numeric,
  reasons jsonb,
  exit_plan jsonb,
  created_at timestamptz not null default now()
);

create index if not exists assessments_created_at_idx on assessments (created_at desc);
create index if not exists assessments_recommended_idx on assessments (recommended, created_at desc);

-- ---------------------------------------------------------------------
-- positions: every buy/sell the engine actually executes (or would have,
-- in DRY_RUN). This is what a dashboard's "open positions" / "history"
-- view reads from.
-- ---------------------------------------------------------------------
create table if not exists positions (
  id bigint generated always as identity primary key,
  chain text not null,
  address text not null,
  status text not null default 'open', -- 'open' | 'closed'
  dry_run boolean not null default true,
  size_native numeric,              -- SOL or BNB spent entering
  entry_tx text,
  exit_tx text,
  exit_reason text,                 -- 'take_profit' | 'stop_loss' | 'max_age'
  pnl_pct numeric,
  pnl_native numeric,               -- realized P&L in SOL/BNB
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists positions_status_idx on positions (status, opened_at desc);

-- ---------------------------------------------------------------------
-- Enable Realtime so the engine/dashboard get pushed changes instantly
-- instead of only polling. In the Supabase dashboard: Database > Replication
-- > toggle these tables on, or run:
-- ---------------------------------------------------------------------
-- alter publication supabase_realtime add table bot_config;
-- alter publication supabase_realtime add table assessments;
-- alter publication supabase_realtime add table positions;

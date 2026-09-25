-- Run this ONCE in the Supabase SQL editor (Dashboard > SQL Editor > New query).
-- It adds the new adjustable settings. Safe to run more than once.
--
-- Until you run it, the bot still works: the new settings apply immediately
-- from Telegram but live in memory only (they reset to defaults on restart).

alter table bot_config add column if not exists take_profit_pct numeric not null default 0;   -- 0 = auto (by risk tier: LOW 20 / MEDIUM 15 / HIGH 12)
alter table bot_config add column if not exists stop_loss_pct   numeric not null default 0;   -- 0 = auto (LOW 25 / MEDIUM 30 / HIGH 35). Stored positive: 25 means -25%.
alter table bot_config add column if not exists max_hold_min    numeric not null default 0;   -- 0 = auto (LOW 20 / MEDIUM 12 / HIGH 6 minutes)
alter table bot_config add column if not exists max_risk_score  numeric not null default 50;  -- only enter tokens scoring <= this (LOW <= 25, MEDIUM <= 50)
alter table bot_config add column if not exists heartbeat_min   integer not null default 60;  -- Telegram "still scanning" summary every N minutes, 0 = off

-- Realized profit/loss in SOL/BNB for each closed position.
alter table positions add column if not exists pnl_native numeric;

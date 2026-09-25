-- Run this ONCE in the Supabase SQL editor, same as migration 002. Safe to
-- run more than once. Until you run it, these still work from Telegram —
-- they just reset to defaults on restart.

alter table bot_config add column if not exists medium_max_dev_percent numeric not null default 45;
alter table bot_config add column if not exists medium_max_top10_percent numeric not null default 85;
alter table bot_config add column if not exists medium_max_score numeric not null default 50;
alter table bot_config add column if not exists max_buy_tax_pct numeric not null default 15;   -- BSC only
alter table bot_config add column if not exists max_sell_tax_pct numeric not null default 15;  -- BSC only

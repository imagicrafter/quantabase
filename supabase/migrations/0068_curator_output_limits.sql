-- 0068_curator_output_limits.sql
--
-- Curator output limits (live blind A/B, 2026-11-21): every tiebreak reply
-- from a reasoning model stopped at exactly 4,096 output tokens, cut off
-- before its JSON ended. Each model now asks for its own limit (engine
-- model.ts: 4,096 for gpt-oss-120b, 16,384 for the reasoning models), and
-- the owner may override any model here:
--
--   curator_settings.max_output_tokens   {"<model>": <tokens>, ...}
--                                         default {} (the built-in limits);
--                                         each value 256 to 65536
--
-- curator_consensus_get() returns it with the other model settings.

alter table workspace.curator_settings
    add column if not exists max_output_tokens jsonb not null default '{}'::jsonb;

alter table workspace.curator_settings drop constraint if exists curator_settings_output_limits;
alter table workspace.curator_settings add constraint curator_settings_output_limits
    check (
        jsonb_typeof(max_output_tokens) = 'object'
        and not jsonb_path_exists(max_output_tokens,
            '$.* ? (@.type() != "number" || @ < 256 || @ > 65536 || @ != @.floor())')
    );

create or replace function workspace.curator_consensus_get()
returns jsonb
language sql
stable
security definer
set search_path = workspace, pg_temp
as $$
    select jsonb_build_object('enabled', s.consensus, 'primary_model', s.model,
                              'tiebreak_model', s.tiebreak_model, 'strong_model', s.strong_model,
                              'max_output_tokens', s.max_output_tokens)
    from workspace.curator_settings s
    where s.id;
$$;

revoke all on function workspace.curator_consensus_get() from public;
revoke all on function workspace.curator_consensus_get() from anon, authenticated;
grant execute on function workspace.curator_consensus_get() to kb_engine;

-- Down (by hand):
-- alter table workspace.curator_settings drop constraint if exists curator_settings_output_limits;
-- alter table workspace.curator_settings drop column if exists max_output_tokens;
-- (then re-run the curator_consensus_get definition from 0067)

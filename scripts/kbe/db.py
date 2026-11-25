"""`kbe db` -- migrations and the embed function.

    kbe db migrate [--schema NAME] [--dry-run] [--accept-changed FILE ...]
    kbe db adopt --through 0028 [--force] [--dry-run]
    kbe db deploy-functions [--project-ref REF] [--dry-run]
    kbe db expose-schema [--project-ref REF] [--dry-run]   (see expose.py)
    kbe db render FILE [--schema NAME]
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Collection, Mapping, Protocol, Sequence
from urllib.parse import urlsplit

from . import migrations as mig
from . import expose, pg, schema, secrets, state
from .context import Context
from .errors import KbeError, UsageError
from .schema_rewrite import rewrite_schema

EMBED_FUNCTION = "embed"
PROJECT_REF_KEY = "SUPABASE_PROJECT_REF"
PROJECT_REF_ANSWER = "supabase_project_ref"
_PROJECT_REF = re.compile(r"^[a-z0-9]{15,30}$")


class Executor(Protocol):
    schema: str

    def tracking_exists(self) -> bool: ...
    def schema_exists(self) -> bool: ...
    def recorded_schemas(self) -> Sequence[str]: ...
    def prepare(self, migrations: Sequence[mig.Migration]) -> None: ...
    def applied(self) -> Mapping[str, str]: ...
    def ensure_tracking(self) -> None: ...
    def apply(self, migration: mig.Migration) -> None: ...
    def record(self, migrations: Sequence[mig.Migration]) -> None: ...


def _recorded(executor: Executor) -> Mapping[str, str]:
    return executor.applied() if executor.tracking_exists() else {}


def _refuse_other_schema(executor: Executor) -> None:
    """One database holds one Engine. Never migrate it into a second schema."""
    others = sorted(set(executor.recorded_schemas()) - {executor.schema})
    if others:
        raise KbeError(
            f'This database already holds an Engine in the schema "{others[0]}", but '
            f'"{executor.schema}" was asked for. Nothing was run. Set '
            f"{schema.SCHEMA_ENV_VAR}={others[0]} in your local env file, or use a "
            "database that has not been migrated."
        )


def _refuse_changed(changed: Sequence[mig.Migration]) -> KbeError:
    names = "\n".join(f"  {m.filename}" for m in changed)
    flags = " ".join(f"--accept-changed {m.filename}" for m in changed)
    return KbeError(
        "These files were already applied and have changed since:\n"
        f"{names}\n"
        "Nothing was run. A change to an applied file never reaches the "
        "database; write a new migration instead. If the change is known to be "
        f"harmless (for example, seed rows removed), re-run with: {flags}"
    )


def migrate(
    executor: Executor,
    migrations: Sequence[mig.Migration],
    out,
    *,
    accept_changed: Collection[str] = (),
    dry_run: bool = False,
) -> int:
    """Apply every pending migration, in order, each in its own transaction."""
    _refuse_other_schema(executor)
    todo = mig.plan(migrations, _recorded(executor), accept_changed)
    for name in todo.missing:
        out(f"note: {name} is recorded in the database but is not a file here")
    if todo.blocked:
        raise _refuse_changed(todo.changed)
    for late in todo.out_of_order:
        out(f"note: {late.filename} is numbered below a migration already applied")
    if not todo.pending and not todo.accepted:
        out("Nothing to apply: the database is up to date.")
        return 0
    verb = "would" if dry_run else "will"
    for accepted in todo.accepted:
        out(f"{verb} accept the new content of {accepted.filename} (not re-run)")
    if dry_run:
        for pending in todo.pending:
            out(f"would apply {pending.filename}")
        out(f"Dry run: {len(todo.pending)} to apply, nothing was changed.")
        return 0
    executor.prepare(todo.pending)
    executor.ensure_tracking()
    executor.record(todo.accepted)
    for pending in todo.pending:
        out(f"apply {pending.filename}")
        executor.apply(pending)
    out(f"Applied {len(todo.pending)} migration(s).")
    return 0


def adopt(
    executor: Executor,
    migrations: Sequence[mig.Migration],
    out,
    *,
    through: int,
    force: bool = False,
    dry_run: bool = False,
) -> int:
    """Record migrations as applied, without running them."""
    chosen = mig.through(migrations, through)
    _refuse_other_schema(executor)
    if not executor.schema_exists():
        raise KbeError(
            f'This database has no schema "{executor.schema}", so there is nothing '
            f"to adopt. Check {schema.SCHEMA_ENV_VAR} in your local env file, or run "
            "`kbe db migrate` to build it."
        )
    existing = _recorded(executor)
    if existing and not force:
        raise KbeError(
            f"This database already has {len(existing)} recorded migration(s), so "
            "it has been adopted or migrated before. Nothing was changed. Use "
            "`kbe db migrate` to bring it up to date, or --force to record again."
        )
    if dry_run:
        for item in chosen:
            out(f"would record {item.filename}")
        out(f"Dry run: {len(chosen)} to record, nothing was changed.")
        return 0
    executor.ensure_tracking()
    executor.record(chosen)
    out(
        f"Recorded {len(chosen)} migration(s) through {through:04d} as already "
        "applied. None were run. Next: kbe db migrate"
    )
    return 0


def project_ref(explicit: str | None, answers: Mapping, values: Mapping[str, str]) -> str:
    """The Supabase project ref: flag, then local state, then the env file."""
    from_url = urlsplit(values.get("SUPABASE_URL", "")).hostname or ""
    derived = from_url.split(".")[0] if from_url.endswith(".supabase.co") else ""
    found = (
        explicit
        or state.answer(answers, PROJECT_REF_ANSWER)
        or values.get(PROJECT_REF_KEY)
        or derived
    )
    if not found:
        raise KbeError(
            "No Supabase project ref. Pass --project-ref, or set "
            f"{PROJECT_REF_KEY} (or SUPABASE_URL) in your local env file."
        )
    if not _PROJECT_REF.fullmatch(found):
        raise UsageError("That does not look like a Supabase project ref (letters and digits).")
    return found


def _executor(ctx: Context, explicit: str | None = None) -> pg.PsqlExecutor:
    values = secrets.load(ctx.env_file)
    chosen = schema.chosen(values, explicit)
    if chosen != schema.DEFAULT_SCHEMA:
        ctx.out(f"Schema: {chosen}")
    return pg.PsqlExecutor(pg.connect(values, ctx.runner), chosen)


def _cmd_migrate(args: argparse.Namespace, ctx: Context) -> int:
    found = mig.discover(ctx.migrations_dir)
    return migrate(
        _executor(ctx, args.schema), found, ctx.out,
        accept_changed=tuple(args.accept_changed), dry_run=args.dry_run,
    )


def _cmd_adopt(args: argparse.Namespace, ctx: Context) -> int:
    found = mig.discover(ctx.migrations_dir)
    return adopt(
        _executor(ctx), found, ctx.out,
        through=mig.parse_number(args.through), force=args.force, dry_run=args.dry_run,
    )


def _cmd_render(args: argparse.Namespace, ctx: Context) -> int:
    """Print a SQL file as it would be applied to the chosen schema."""
    chosen = schema.chosen(secrets.load_optional(ctx.env_file), args.schema)
    try:
        written = Path(args.file).read_text(encoding="utf-8")
    except OSError as error:
        raise KbeError(f"Could not read {args.file}: {error.strerror}.") from error
    ctx.out(rewrite_schema(written, chosen))
    return 0


def _schema_secret_argv(name: str, ref: str) -> list[str]:
    """The command that tells the embed function its schema; none for the default."""
    if name == schema.DEFAULT_SCHEMA:
        return []
    return ["supabase", "secrets", "set", f"{schema.SCHEMA_ENV_VAR}={name}", "--project-ref", ref]


_SCHEMA_SECRET = re.compile(rf"\b{schema.SCHEMA_ENV_VAR}\b")


def _supabase(ctx: Context, argv: list[str], extra: Mapping[str, str], values, what: str):
    done = ctx.runner(argv, extra=dict(extra), cwd=ctx.root, timeout=120)
    if not done.ok:
        detail = secrets.redact(done.stderr or done.stdout, values).strip()
        raise KbeError(
            f"{what} Nothing was deployed. If it says you are not logged in, run "
            f"`supabase login` first.\n{detail}"
        )
    return done


def _clear_schema_secret(ctx: Context, ref: str, extra: Mapping[str, str], values) -> None:
    """Back on the default schema: remove a KB_SCHEMA the function still holds.

    A function left with an old name would keep asking the old schema who may
    embed. It is looked for first, so a function that never had the setting
    is not touched.
    """
    listed = _supabase(
        ctx, ["supabase", "secrets", "list", "--project-ref", ref], extra, values,
        f"Could not read the {EMBED_FUNCTION} function's settings.",
    )
    if _SCHEMA_SECRET.search(listed.stdout) is None:
        return
    _supabase(
        ctx, ["supabase", "secrets", "unset", schema.SCHEMA_ENV_VAR, "--project-ref", ref],
        extra, values,
        f"Could not clear the {EMBED_FUNCTION} function's old {schema.SCHEMA_ENV_VAR} setting.",
    )
    ctx.out(f"Cleared the function's old {schema.SCHEMA_ENV_VAR} setting "
            f"(it uses the default schema, {schema.DEFAULT_SCHEMA}, again).")


def _tell_schema(ctx: Context, ref: str, extra: Mapping[str, str], values) -> None:
    secret_argv = _schema_secret_argv(schema.chosen(values), ref)
    if not secret_argv:
        _clear_schema_secret(ctx, ref, extra, values)
        return
    _supabase(ctx, secret_argv, extra, values,
              f"Could not tell the {EMBED_FUNCTION} function which schema to use.")


def _cmd_deploy_functions(args: argparse.Namespace, ctx: Context) -> int:
    values = secrets.load_optional(ctx.env_file)
    ref = project_ref(args.project_ref, state.load(ctx.state_file), values)
    # --no-verify-jwt: callers send a principal token, which the function
    # checks itself (principal_can_embed). It is not a project JWT.
    argv = ["supabase", "functions", "deploy", EMBED_FUNCTION, "--project-ref", ref,
            "--no-verify-jwt"]
    if args.dry_run:
        secret_argv = _schema_secret_argv(schema.chosen(values), ref)
        ctx.out("would run: " + " ".join(secret_argv) if secret_argv else
                f"would clear the function's {schema.SCHEMA_ENV_VAR} setting if it has one")
        ctx.out("would run: " + " ".join(argv))
        return 0
    login = values.get("SUPABASE_ACCESS_TOKEN")
    extra = {"SUPABASE_ACCESS_TOKEN": login} if login else {}
    _tell_schema(ctx, ref, extra, values)
    result = ctx.runner(argv, extra=extra, cwd=ctx.root, timeout=600)
    if not result.ok:
        detail = secrets.redact(result.stderr or result.stdout, values).strip()
        raise KbeError(
            f"Deploying the {EMBED_FUNCTION} function failed. If it says you are "
            f"not logged in, run `supabase login` first.\n{detail}"
        )
    state.save(
        ctx.state_file,
        state.with_answer(state.load(ctx.state_file), PROJECT_REF_ANSWER, ref),
    )
    ctx.out(f"Deployed the {EMBED_FUNCTION} function to project {ref}.")
    return 0


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "db",
        help="apply migrations, adopt an existing database, deploy the embed function",
        description="Database commands. The database is the one named by "
        "KBE_DATABASE_URL in your local env file.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")
    _register_migrate(commands)
    _register_adopt_and_deploy(commands)
    expose.register(commands, project_ref)
    _register_render(commands)


def _register_migrate(commands: argparse._SubParsersAction) -> None:
    run = commands.add_parser(
        "migrate",
        help="apply supabase/migrations/*.sql that have not run yet",
        description="Apply pending migration files in filename order, each in its "
        "own transaction. What has run is recorded in the kbe_migrations table "
        "with a checksum. Stops, changing nothing, if an applied file has changed. "
        "The files are written for a schema named workspace; for another schema "
        "the name is changed as each file is applied.",
    )
    run.add_argument(
        "--schema", metavar="NAME",
        help=f"the schema to build the Engine in (default: {schema.SCHEMA_ENV_VAR} in "
        f"your local env file, then {schema.DEFAULT_SCHEMA})",
    )
    run.add_argument("--dry-run", action="store_true", help="list what would run; change nothing")
    run.add_argument(
        "--accept-changed", action="append", default=[], metavar="FILE",
        help="an applied file whose content changed on purpose; its new checksum "
        "is recorded and it is not re-run (repeatable)",
    )
    run.set_defaults(func=_cmd_migrate)


def _register_adopt_and_deploy(commands: argparse._SubParsersAction) -> None:
    take = commands.add_parser(
        "adopt",
        help="mark an existing database as already migrated",
        description="For a database that was built before this tool existed: record "
        "every migration up to and including --through as applied, without "
        "running any of them. Refuses if anything is recorded already.",
    )
    take.add_argument("--through", required=True, metavar="NNNN",
                      help="the highest migration the database already has, e.g. 0028")
    take.add_argument("--force", action="store_true",
                      help="record even though the tracking table already has rows")
    take.add_argument("--dry-run", action="store_true", help="list what would be recorded")
    take.set_defaults(func=_cmd_adopt)

    deploy = commands.add_parser(
        "deploy-functions",
        help="deploy the embed edge function with the supabase CLI",
        description="Runs `supabase functions deploy embed` for your project. The "
        "project ref comes from --project-ref, local state, or your local env file.",
    )
    deploy.add_argument("--project-ref", metavar="REF", help="Supabase project ref")
    deploy.add_argument("--dry-run", action="store_true", help="print the command only")
    deploy.set_defaults(func=_cmd_deploy_functions)


def _register_render(commands: argparse._SubParsersAction) -> None:
    show = commands.add_parser(
        "render",
        help="print a SQL file as it would be applied to your schema",
        description="Print a SQL file with the schema name changed to yours, exactly "
        "as `kbe db migrate` would send it. With the default schema the file is "
        "printed as written. Changes nothing.",
    )
    show.add_argument("file", metavar="FILE", help="a .sql file written for the default schema")
    show.add_argument("--schema", metavar="NAME", help="render for this schema instead")
    show.set_defaults(func=_cmd_render)

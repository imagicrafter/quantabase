"""`kbe support` -- let an outside support person read the issue inbox.

    kbe support enable  (--clipboard | --out FILE | --show) [--login NAME] [--dry-run] [--yes]
    kbe support disable [--login NAME] [--dry-run] [--yes]
    kbe support status

What support may do is fixed by a migration (0036_support_role.sql): the
group role `kb_support` reads the view v_support_inbox and runs
issue_set_card() and issue_set_status(), and nothing else in the Engine's
schema. It cannot read a document, a person, a grant or a setting. (Outside
that schema it has only what the database gives every role; the migration's
header says what that means when the database is shared with another app.)

`enable` creates a login that is a member of that role, with a password made
here. The connection string is handed over once (the clipboard, a new
owner-only file, or printed with --show), for the customer to pass on through
a secure channel. It is never stored in the state file and never put on a
child program's command line. The database is sent only
a SCRAM verifier, so the password is not in the server's statement log
either. `disable` drops the login; `enable` again gives a new password.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import re
import secrets as stdlib_secrets
from typing import Mapping

from . import pg, secret_out, secrets
from .context import Context
from .errors import KbeError, UsageError

GROUP_ROLE = "kb_support"
DEFAULT_LOGIN = "kb_support_login"
_LOGIN = re.compile(r"kb_support_[a-z0-9_]{1,40}")
_SCRAM_ITERATIONS = 4096
_CONNECTION_LIMIT = 5


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def scram_verifier(password: str, salt: bytes | None = None) -> str:
    """The SCRAM-SHA-256 verifier Postgres stores for `password`.

    Sending this instead of the password keeps it out of the server's log.
    """
    chosen = salt if salt is not None else stdlib_secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), chosen, _SCRAM_ITERATIONS)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    return (
        f"SCRAM-SHA-256${_SCRAM_ITERATIONS}:{_b64(chosen)}"
        f"${_b64(stored_key)}:{_b64(server_key)}"
    )


def login_name(name: str | None) -> str:
    """The login role's name, checked before it is put into SQL text."""
    chosen = name or DEFAULT_LOGIN
    if _LOGIN.fullmatch(chosen) is None:
        raise UsageError("--login must start with kb_support_ and use a-z, 0-9 and _ only.")
    return chosen


def connection_string(conn: Mapping[str, str], login: str, password: str) -> str:
    """Where support connects. A pooler login keeps the project suffix."""
    admin = conn.get("PGUSER", "")
    suffix = admin[admin.index("."):] if "." in admin else ""
    mode = conn.get("PGSSLMODE") or "require"
    return (
        f"postgresql://{login}{suffix}:{password}@{conn['PGHOST']}:{conn.get('PGPORT', '5432')}"
        f"/{conn.get('PGDATABASE', 'postgres')}?sslmode={mode}"
    )


def _role_exists(psql: pg.Psql, name: str) -> bool:
    rows = psql.rows(f"select count(*) from pg_roles where rolname = {pg.quote_literal(name)};")
    return bool(rows) and rows[0][0] == "1"


def _require_group(psql: pg.Psql) -> None:
    if not _role_exists(psql, GROUP_ROLE):
        raise KbeError(
            f"The {GROUP_ROLE} role does not exist in this database yet. "
            "Run: python -m kbe db migrate"
        )


def _members(psql: pg.Psql) -> list[tuple[str, bool]]:
    """Logins that are members of the support role: (name, may log in)."""
    rows = psql.rows(
        "select m.rolname, m.rolcanlogin from pg_auth_members a "
        "join pg_roles g on g.oid = a.roleid join pg_roles m on m.oid = a.member "
        f"where g.rolname = {pg.quote_literal(GROUP_ROLE)} order by 1;"
    )
    return [(row[0], row[1] == "t") for row in rows]


def _connect(ctx: Context) -> pg.Psql:
    return pg.connect(secrets.load(ctx.env_file), ctx.runner)


SECRET_NAME = "SUPPORT_DATABASE_URL"
_AFTER = (
    "Pass it to your support contact through a secure channel (a password manager "
    "share, not email or chat). It can read the issue inbox and mark issues; it "
    "cannot read documents, people or settings.",
    "To take it away: python -m kbe support disable",
)


def _show_once(ctx: Context, text: str) -> None:
    """The one place the support connection string is printed, and only with --show."""
    for line in (
        "",
        "Support connection string (shown once -- it is not saved anywhere):",
        "",
        f"    {text}",
        "",
    ):
        ctx.out(line)


def _cmd_enable(args: argparse.Namespace, ctx: Context) -> int:
    login = login_name(args.login)
    psql = _connect(ctx)
    _require_group(psql)
    if _role_exists(psql, login):
        raise KbeError(
            f"Support is already enabled (the login {login} exists). For a new password "
            "run `python -m kbe support disable`, then enable again."
        )
    if args.dry_run:
        ctx.out(f"Dry run: would create the login {login} as a member of {GROUP_ROLE}. "
                "Nothing was changed.")
        return 0
    delivery = secret_out.choose(args, what="support connection string")
    question = f"Create the support login {login}? It can read the issue inbox only."
    if not args.yes and not ctx.confirm(question):
        raise KbeError("Not changed. Re-run with --yes to go ahead without being asked.")
    password = stdlib_secrets.token_urlsafe(32)
    created = psql.script(
        f"create role {login} login inherit connection limit {_CONNECTION_LIMIT} "
        f"password {pg.quote_literal(scram_verifier(password))} in role {GROUP_ROLE};"
    )
    if not created.ok:
        raise KbeError(f"The support login could not be created:\n{created.stderr}")
    text = connection_string(psql.conn, login, password)
    try:
        sent = delivery.send(ctx, {SECRET_NAME: text}, show=lambda c: _show_once(c, text))
    except KbeError as error:
        raise KbeError(
            f"{error} The login was created but its connection string could not be handed "
            "over; run `python -m kbe support disable`, then enable again."
        ) from error
    for line in (*sent, *_AFTER):
        ctx.out(line)
    return 0


def _cmd_disable(args: argparse.Namespace, ctx: Context) -> int:
    login = login_name(args.login)
    psql = _connect(ctx)
    if not _role_exists(psql, login):
        ctx.out(f"Support is not enabled: there is no login {login}.")
        return 0
    if login not in [name for name, _can_login in _members(psql)]:
        raise KbeError(
            f"{login} is not a support login (it is not a member of {GROUP_ROLE}). "
            "Nothing was changed."
        )
    if args.dry_run:
        ctx.out(f"Dry run: would end {login}'s sessions and drop the login. Nothing was changed.")
        return 0
    if not args.yes and not ctx.confirm(f"Drop the support login {login}?"):
        raise KbeError("Not changed. Re-run with --yes to go ahead without being asked.")
    dropped = psql.script(
        "select pg_terminate_backend(pid) from pg_stat_activity "
        f"where usename = {pg.quote_literal(login)};\n"
        f"drop role {login};"
    )
    if not dropped.ok:
        raise KbeError(f"The support login could not be dropped:\n{dropped.stderr}")
    ctx.out(f"Support is disabled: {login} was dropped and its connection string no longer works.")
    return 0


def _cmd_status(args: argparse.Namespace, ctx: Context) -> int:
    psql = _connect(ctx)
    if not _role_exists(psql, GROUP_ROLE):
        ctx.out("support role:  missing (run: python -m kbe db migrate)")
        ctx.out("support login: none")
        return 0
    ctx.out("support role:  present (reads the issue inbox; marks issues; nothing else)")
    logins = [name for name, can_login in _members(psql) if can_login]
    ctx.out(f"support login: {', '.join(logins) if logins else 'none (support is disabled)'}")
    return 0


def _change_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--login", metavar="NAME",
                        help=f"name of the login role (default: {DEFAULT_LOGIN})")
    parser.add_argument("--dry-run", action="store_true", help="say what would happen only")
    parser.add_argument("--yes", action="store_true", help="go ahead without asking")


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "support",
        help="give or take away read-only support access to the issue inbox",
        description="Support access is a database login that can read the issue inbox "
        "and mark issues, and nothing else: no documents, people, grants or settings. "
        "Uses the direct database connection (KBE_DATABASE_URL).",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")

    enable = commands.add_parser(
        "enable", help="create the support login and hand over its connection string once",
        description="Creates a login that is a member of the kb_support role, with a "
        "password made here, and hands the connection string over once (--clipboard, "
        "--out FILE or --show) for you to pass on through a secure channel. With none "
        "of the three the command refuses. It is not stored anywhere else.",
    )
    _change_flags(enable)
    secret_out.add_flags(enable, what="support connection string")
    enable.set_defaults(func=_cmd_enable)

    disable = commands.add_parser(
        "disable", help="drop the support login",
        description="Ends the support login's sessions and drops it. The connection "
        "string stops working at once. The kb_support role itself stays, unused.",
    )
    _change_flags(disable)
    disable.set_defaults(func=_cmd_disable)

    status = commands.add_parser(
        "status", help="whether support access is on",
        description="Shows whether the support role exists and which logins, if any, "
        "can use it. Shows no password: none is stored.",
    )
    status.set_defaults(func=_cmd_status)

"""`kbe access setup` -- set up Cloudflare sign-in with one command.

    kbe access setup [--host HOST] [--level owner|people|domain]
                     [--emails LIST] [--domains LIST] [--replace]
                     [--token-file PATH] [--legacy-format] [--app-id ID]
                     [--wait-minutes N]
                     [--dry-run] [--yes] [--via auto|api|db]

What is left for the person: open one link, click Create in Cloudflare and
copy the token, and say yes to the preview.

What the command does, in order:

1. Reads the hostname, the owner and who may sign in (access_choices.py).
2. Makes a new setup code in memory, stores its hash in the database, and
   sets the code as SETUP_CODE on the app (setup_app.py). That starts a
   deployment, which it follows until it is live.
3. Prints a link to Cloudflare's token screen with the permissions filled in
   (cloudflare_token_link.py).
4. Reads the token from the clipboard, or from --token-file (token_input.py).
5. Asks the app itself for its plan and shows it; then, after a yes (or with
   --yes), has the app carry it out (setup_http.py). Every Cloudflare call is
   made by the app, exactly as its setup page makes them.
6. Takes SETUP_CODE off the app again, clears the clipboard, and checks the
   result the way `kbe access status` does. It then says, from what the app
   read back in Cloudflare, which setting (if any) still needs a click, and
   waits until the hostname asks for a sign-in (setup_probe.py): a new
   hostname answers "not found" for a minute or two.

SECRETS. The setup code exists only in this process and, encrypted, on the
app. It never reaches the screen, the clipboard or a file. The token goes
clipboard -> this process -> HTTPS -> the app, and is stored nowhere. Neither
is ever printed: every line that comes back from doctl or from the app has
both removed before it is shown.

AN INTERRUPTED RUN. The code is not kept, so a run that stops cannot be
resumed with the same code. Run the command again: it makes a new code. What
was already done in Cloudflare stays done and is not repeated.

WHAT IT DOES NOT DO. Once the Engine has sign-in settings, its setup routes
answer only behind the admin sign-in (second factor). This command has no
such sign-in and does not try to get round it: to change sign-in later, use
`kbe access reopen` and the setup page.
"""

from __future__ import annotations

import argparse
import sys
from typing import Callable, Mapping

from . import (
    access, access_choices, cloudflare_token_link, config_store, deploy_doctl, secrets,
    setup_app, setup_http, setup_probe, state, token_input,
)
from .context import Context
from .errors import KbeError, UsageError

SETUP_CODE = setup_app.SETUP_CODE
_STATUS_WORDS = {
    "created": "Created", "updated": "Updated", "unchanged": "Already in place",
    "failed": "Failed", "not_run": "Not run",
}
_USE_THE_PAGE = (
    "To change sign-in on an Engine that already has it, run `python -m kbe access "
    "reopen` and use the setup page at https://{host}/setup. That page is behind the "
    "admin sign-in (second factor), which this command does not have."
)


_NO_TEAM = (
    "This Cloudflare account has never opened Zero Trust, so it has no team name. "
    "Nothing was created in Cloudflare.",
    "Do this once: go to https://one.dash.cloudflare.com, choose your account, pick a "
    "team name and the free plan.",
    "Then run this command again. It makes a new setup code by itself.{kept}",
)
_ZERO_TRUST_FIRST = (
    "First time with Zero Trust on this Cloudflare account? Open "
    "https://one.dash.cloudflare.com once and pick a team name (free plan) before "
    "you make the token."
)


def _at_a_terminal() -> bool:
    """True when a person can be asked the one question at the end."""
    try:
        return sys.stdin.isatty()
    except (AttributeError, ValueError):
        return False


def _app_id(args: argparse.Namespace, local: Mapping) -> str:
    found = args.app_id or state.answer(local, "do_app_id")
    if not found:
        raise KbeError("No app yet. Run `python -m kbe deploy apply`, or pass --app-id.")
    return deploy_doctl.check_app_id(str(found))


def _already(ctx: Context, status: Mapping, replace: bool) -> int:
    """Sign-in exists: say so, change nothing."""
    host = (status.get("access") or {}).get("host") or "<your hostname>"
    complete = status.get("setup_state") == "complete"
    ctx.out("Sign-in is already set up for this Engine. Nothing was changed." if complete
            else "This Engine already has sign-in settings, and setup has been reopened.")
    for line in access.describe_status(status):
        ctx.out(f"  {line}")
    if replace or not complete:
        ctx.out(_USE_THE_PAGE.format(host=host))
    return 0


def _say_plan(ctx: Context, choices: access_choices.Choices, app_host: str, src) -> None:
    ctx.out("Sign-in will be set up with these choices (nothing is retyped):")
    for line in choices.lines():
        ctx.out(line)
    ctx.out(f"  The app's own address: {app_host}")
    ctx.out(f"In Cloudflare the app will make: a DNS record for {choices.host}, two sign-in "
            "rules and two sign-in applications (the one for /status and /setup asks for a "
            "second factor). Its exact list is shown before anything is changed.")
    ctx.out("What this command does:")
    for line in (
        f"1. Makes a new setup code and sets it as {SETUP_CODE} on the app. The code is "
        "never shown. This starts a deployment (a few minutes).",
        "2. Gives you a link to make a one-time Cloudflare API token.",
        f"3. Reads the token from {src.name}. It is never shown or stored.",
        "4. Shows the app's list of every change in Cloudflare, and asks before making them.",
        f"5. Takes {SETUP_CODE} off the app again and checks the result.",
    ):
        ctx.out(f"  {line}")


def _say_link(ctx: Context, choices: access_choices.Choices, src) -> None:
    ctx.out("")
    ctx.out(_ZERO_TRUST_FIRST)
    ctx.out("Make the one-time Cloudflare token now (the app is deploying meanwhile):")
    ctx.out("  1. Open this link. It fills in the four permissions:")
    ctx.out(f"     {cloudflare_token_link.link()}")
    ctx.out("  2. The link cannot set these, so set them on that screen:")
    for line in cloudflare_token_link.BY_HAND:
        ctx.out(f"       - {line.format(host=choices.host)}")
    ctx.out("     and check that it lists exactly these (add any that is missing):")
    for line in cloudflare_token_link.permission_lines():
        ctx.out(f"       - {line}")
    where = ("copy the token" if src.is_clipboard
             else f"save the token in {src.name}, a new file only you can read")
    ctx.out(f"  3. Click Continue to summary (or Create Token), and {where}.")
    ctx.out("Do not paste the token anywhere else. This command picks it up by itself.")
    ctx.out("")


def _say_preview(ctx: Context, preview: setup_http.Preview) -> None:
    ctx.out("")
    ctx.out("This is exactly what will be done (the app's own list):")
    for number, step in enumerate(preview.steps, start=1):
        ctx.out(f"  {number}. {step.title}")
        for line in step.lines:
            ctx.out(f"       - {line}")
    ctx.out("Anything that already exists and is already right is left alone.")


def _say_result(ctx: Context, result: setup_http.Result) -> None:
    ctx.out("")
    ctx.out("What was done:")
    for step in result.steps:
        ctx.out(f"  {_STATUS_WORDS.get(step.status, 'Unknown'):<17}{step.title}")
        if step.note:
            ctx.out(f"  {'':<17}{step.note}")
    for warning in result.warnings:
        ctx.out(f"  Note: {warning}")


def _take_code_off(ctx: Context, doctl: deploy_doctl.Doctl, app_id: str) -> None:
    """Best effort, and never in the way of the error that brought us here."""
    try:
        if setup_app.clear_code(doctl, app_id):
            ctx.out(f"{SETUP_CODE} was taken off the app. That starts one more deployment; "
                    "there is nothing to wait for.")
    except KbeError as error:
        ctx.out(f"{SETUP_CODE} could not be taken off the app ({error}). Remove the "
                "variable from the kb-engine component in the DigitalOcean dashboard, or "
                "run this command again.")


def _after_success(ctx: Context, store, src, result: setup_http.Result,
                   choices: access_choices.Choices, clock: setup_app.Clock) -> None:
    if src.is_clipboard:
        cleared = token_input.clear_clipboard(ctx)
        ctx.out("The clipboard was cleared." if cleared
                else "The clipboard could not be cleared. Copy something else now.")
    else:
        ctx.out(f"Delete {src.name} now: it still holds the token.")
    status = access.read_status(store)
    for line in access.describe_status(status):
        ctx.out(f"  {line}")
    if status.get("setup_state") != "complete":
        raise KbeError(
            "The app reported success, but the database does not show setup as complete. "
            "Run `python -m kbe access status` in a minute."
        )
    current = state.load(ctx.state_file)
    for key, value in choices.answers().items():
        current = state.with_answer(current, key, value)
    state.save(ctx.state_file, state.with_phase(current, access.PHASE, "done"))
    for line in (
        "Setup is complete.",
        "The Cloudflare token is no longer needed. Delete it in Cloudflare (My Profile, "
        "API Tokens). If you set an end date, it also stops working by itself then.",
    ):
        ctx.out(line)
    _say_checks(ctx, result)
    _say_probe(ctx, choices.host, clock)
    ctx.out(f"Connector address for Claude: {result.connector_url}")
    ctx.out("Next: python -m kbe verify --phases access_setup")


def _say_checks(ctx: Context, result: setup_http.Result) -> None:
    """What the app read back: one plain line for each thing not in place."""
    missing = [check for check in result.checks if check.state == "missing"]
    unknown = [check for check in result.checks if check.state == "unknown"]
    if result.checks and not missing and not unknown:
        ctx.out("Checked in Cloudflare: Managed OAuth is on, Claude's redirect addresses "
                "are allowed, and /status asks for a second factor.")
    for check in missing:
        ctx.out(f"Needs a click in Cloudflare: {check.title} is not in place. {check.fix}")
    for check in unknown:
        ctx.out(f"Could not be checked: {check.title}. If Claude cannot connect later, see "
                "engine/deploy/cloudflare-access-setup.md.")


def _say_probe(ctx: Context, host: str, clock: setup_app.Clock) -> None:
    probe = setup_probe.wait_for_sign_in(host, ctx.out, clock, _get())
    for line in probe.lines:
        ctx.out(line)


def _get() -> Callable:
    """The plain GET of the hostname. A function so a test can stand in for it."""
    return setup_probe._default_get  # noqa: SLF001 - the one real transport


def _stopped(result: setup_http.Result, src) -> KbeError:
    kept = (" The token is still on the clipboard for that run." if src.is_clipboard else "")
    if result.failed_with("no_team"):
        return KbeError("\n".join(_NO_TEAM).format(kept=kept))
    return KbeError(
        "Setup stopped. The steps marked Created, Updated or Already in place are done and "
        "stay done; nothing was undone. Fix what the failed step says, then run this "
        f"command again: it finishes the job and repeats nothing.{kept}"
    )


def _through_the_app(
    args: argparse.Namespace, ctx: Context, values: Mapping[str, str], code: str,
    app_host: str, choices: access_choices.Choices, src, clock: setup_app.Clock,
) -> setup_http.Result:
    """Token in, the app's preview shown, a yes, the app's apply. Returns its report."""
    token = token_input.wait_for(src, values, code, ctx.out, args.wait_minutes, clock)
    # The platform can let the old deployment answer for a moment after the new
    # one shows as live. A code sent to it would count as a wrong one.
    clock.sleep(setup_app.SETTLE_SECONDS)
    hidden = {**values, SETUP_CODE: code, "CLOUDFLARE_API_TOKEN": token}
    api = setup_http.SetupApi(app_host, hidden, _post())
    preview = api.preview(code, choices.form())
    _say_preview(ctx, preview)
    if not args.yes and not ctx.confirm("Make these changes in Cloudflare?"):
        raise KbeError("Nothing was changed in Cloudflare. Run this command again to "
                       "set up sign-in.")
    ctx.out("Applying. This can take up to a minute.")
    result = api.apply(code, token, preview)
    _say_result(ctx, result)
    return result


def _post() -> Callable:
    """The HTTP call. A function so a test can stand in for the network."""
    return setup_http._default_post  # noqa: SLF001 - the one real transport


def _clock() -> setup_app.Clock:
    """Real time. A function so a test can run the waits without waiting."""
    return setup_app.Clock()


def run(args: argparse.Namespace, ctx: Context) -> int:
    values = secrets.load(ctx.env_file)
    store = config_store.choose(values, args.via, ctx.runner)
    status = access.read_status(store)
    if status.get("setup_state") == "complete" or access.has_sign_in(status):
        return _already(ctx, status, bool(args.replace))

    local = state.load(ctx.state_file)
    choices = access_choices.resolve(args, store.get(), local.get("answers", {}))
    app_id = _app_id(args, local)
    doctl = deploy_doctl.Doctl(ctx.runner, values)
    # From DigitalOcean itself, for this app: never an address remembered earlier.
    app_host = setup_http.check_host(doctl.get(app_id).default_hostname)
    src = token_input.source(ctx, args.token_file, args.legacy_format)
    _say_plan(ctx, choices, app_host, src)
    if args.dry_run:
        ctx.out("Dry run: nothing was changed.")
        return 0
    if not args.yes and not _at_a_terminal():
        raise UsageError(
            "Nothing was changed. This command asks one question before it changes "
            "Cloudflare, and nobody is at this terminal to answer. Run it in your own "
            "terminal, or pass --yes to apply the app's plan without being asked."
        )
    if status.get("setup_code_set"):
        ctx.out("A setup code from an earlier run is replaced: it stops working.")
    src.read()  # fails now, not after the deployment, when the clipboard cannot be read

    code = access.new_code()
    doctl = deploy_doctl.Doctl(ctx.runner, {**values, SETUP_CODE: code})
    store.call("engine_setup_reopen", {"p_code_hash": access.code_hash(code)})
    current = state.load(ctx.state_file)
    for key, value in choices.answers().items():
        current = state.with_answer(current, key, value)
    state.save(ctx.state_file, state.with_phase(current, access.PHASE, "pending"))
    clock = _clock()
    try:
        started = setup_app.set_code(doctl, app_id, code)
        ctx.out(f"{SETUP_CODE} is set on the app (not shown). A deployment has started.")
        _say_link(ctx, choices, src)
        setup_app.wait_until_live(doctl, app_id, started, ctx.out, args.wait_minutes, clock)
        result = _through_the_app(args, ctx, values, code, app_host, choices, src, clock)
    finally:
        _take_code_off(ctx, doctl, app_id)
    if not result.ok:
        raise _stopped(result, src)
    _after_success(ctx, store, src, result, choices, clock)
    return 0


def add_parser(
    commands: argparse._SubParsersAction, common: Callable[..., None],
) -> None:
    setup = commands.add_parser(
        "setup",
        help="set up Cloudflare sign-in: one link, one token, one yes",
        description="Sets up Cloudflare sign-in through the app's own setup routes. Reads "
        "the hostname and the owner from the applied config, makes the setup code and "
        "sets it on the app without showing it, gives you a link that opens Cloudflare's "
        "token screen with the permissions filled in, reads the token from the clipboard, "
        "shows the app's list of every change and asks before making them, then takes "
        "the setup code off the app again. Neither the code nor the token is ever shown "
        "or stored. If a run stops part way, run it again: it makes a new code and "
        "finishes the job. --dry-run changes nothing.",
    )
    setup.add_argument("--host", metavar="HOST",
                       help="the Engine's hostname (default: the applied config's)")
    setup.add_argument("--level", choices=access_choices.LEVELS,
                       help="who may sign in (default: the level used last, else owner)")
    setup.add_argument("--emails", metavar="LIST",
                       help="for --level people: email addresses, separated by commas")
    setup.add_argument("--domains", metavar="LIST",
                       help="for --level domain: email domains, separated by commas")
    setup.add_argument("--replace", action="store_true",
                       help="take over a DNS record or application for this hostname that "
                       "setup did not make (the page's \"Replace what is already there\")")
    setup.add_argument("--token-file", metavar="PATH",
                       help="read the Cloudflare token from this file instead of the "
                       "clipboard (for machines without pbpaste)")
    setup.add_argument("--legacy-format", action="store_true",
                       help="also accept a Cloudflare token in the old form: 40 characters "
                       "with no cfut_ or cfat_ in front")
    setup.add_argument("--app-id", metavar="ID",
                       help="the app to act on (default: the one this tool created)")
    setup.add_argument("--wait-minutes", type=int, default=20, metavar="N",
                       help="how long to wait for the deployment, and then for the token "
                       "(default: 20 each)")
    common(setup, changes=True)
    setup.set_defaults(func=run)

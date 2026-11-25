"""`kbe deploy` -- the DigitalOcean app: its spec, creating it, updating it.

    kbe deploy render [--host H] [--app-name N] [--region R] [--config PATH]
                      [--source github:<owner>/<repo>@<branch>]
                      [--cf-team-domain URL --cf-aud AUD [--cf-status-aud AUD]] [--stdout]
    kbe deploy apply [--app-id ID] [--allow-remove] [--dry-run] [--yes]
    kbe deploy status [--app-id ID] [--json]
    kbe deploy redeploy [--app-id ID] [--dry-run] [--yes]
    kbe deploy secrets push [--app-id ID] [--setup-code-from-clipboard]
                            [--dry-run] [--yes]            (deploy_push.py)

No command here takes a secret value as an argument. Secrets are declared in
the spec with no value. `secrets push` sets them on the app from the local
env file; the DigitalOcean dashboard is the other way to enter them.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Mapping

from . import (
    config_cmd, context, deploy_doctl, deploy_merge, deploy_push, deploy_render, schema, secrets,
    state,
)
from .context import Context
from .errors import KbeError, UsageError

PHASE = "deploy"
SPEC_NAME = "do-app-spec.yaml"
DEFAULT_REGION = "nyc"


def spec_path(ctx: Context) -> Path:
    return ctx.root / context.STATE_DIR / SPEC_NAME


def _remember(ctx: Context, answers: Mapping[str, Any], done: bool = False) -> None:
    updated = state.load(ctx.state_file)
    for key, value in answers.items():
        if value or value is False:
            updated = state.with_answer(updated, key, value)
    if done:
        updated = state.with_phase(updated, PHASE, "done")
    state.save(ctx.state_file, updated)


def _config_file(args: argparse.Namespace, answers: Mapping[str, Any]) -> Path:
    if args.config:
        return Path(args.config).expanduser()
    repo = answers.get("knowledge_repo_path")
    if not repo:
        raise UsageError(
            "No Engine config to read. Pass --config PATH, or run `python -m kbe repo init` first."
        )
    return Path(str(repo)).expanduser() / ".kb-engine" / "engine.yaml"


def _inputs(args: argparse.Namespace, ctx: Context) -> deploy_render.Inputs:
    """Flags win, then what an earlier run remembered, then the defaults."""
    answers = state.load(ctx.state_file).get("answers", {})
    config = config_cmd.read_config(_config_file(args, answers))
    host = args.host or answers.get("engine_host")
    if not host:
        raise UsageError("The Engine's hostname is needed: pass --host engine.example.com")
    return deploy_render.Inputs(
        app_name=args.app_name or answers.get("app_name") or f'{config["engine"]["id"]}-kb-engine',
        region=args.region or answers.get("region") or DEFAULT_REGION,
        host=host,
        config=config,
        source=deploy_render.parse_source(args.source or answers.get("engine_source")),
        schema=schema.chosen(secrets.load_optional(ctx.env_file)),
        access_env=deploy_render.access_env(args.cf_team_domain, args.cf_aud, args.cf_status_aud),
        server_mode=_server_mode(args, answers),
    )


def _server_mode(args: argparse.Namespace, answers: Mapping[str, Any]) -> bool:
    """The flag wins; else what the last render chose; else off."""
    if args.server_mode is not None:
        return bool(args.server_mode)
    return answers.get("server_mode") is True


def _write_private(path: Path, text: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(path, 0o600)
    except OSError as error:
        raise KbeError(f"Could not write {path}: {error.strerror}.") from error


def _secret_lines(spec: Mapping[str, Any]) -> list[str]:
    """Names only, by component, with where each value comes from.

    Never "set" or "not set": the platform returns an encrypted text for
    every declared secret, with or without a value behind it.
    """
    lines: list[str] = []
    last = None
    for component, key in deploy_render.secret_names(spec):
        if component != last:
            lines.append(f"  {component}")
            last = component
        lines.append(f"    {key}  <- {deploy_render.secret_source(key)}")
    return lines


def _clone_url(source: deploy_render.Source) -> str:
    return source.repo if source.kind == "git" else f"https://github.com/{source.repo}.git"


def check_source(ctx: Context, source: deploy_render.Source) -> None:
    """Stop before a spec is written when the branch to build from is not there.

    A spec that names a missing branch is accepted by the platform and then
    fails at its first build, which is a slow way to find out.
    """
    name = deploy_render.source_text(source)
    bypass = "To render anyway, pass --skip-source-check."
    found = ctx.runner(
        ["git", "ls-remote", "--heads", _clone_url(source), source.branch],
        extra={"GIT_TERMINAL_PROMPT": "0"}, timeout=60,
    )
    if not found.ok:
        raise KbeError(
            f"Could not check that {name} exists (git ls-remote failed: the network, or a "
            f"repository this machine may not read). {bypass}"
        )
    heads = [line.split("\t")[-1].strip() for line in found.stdout.splitlines()]
    if f"refs/heads/{source.branch}" not in heads:
        raise KbeError(
            f"The branch `{source.branch}` does not exist in the repository {name} builds "
            f"from, so the first build would fail. Name a branch that exists with "
            f"--source. {bypass}"
        )


def _cmd_render(args: argparse.Namespace, ctx: Context) -> int:
    inputs = _inputs(args, ctx)
    if not args.skip_source_check:
        check_source(ctx, inputs.source)
    spec = deploy_render.render(inputs)
    text = deploy_render.dump(spec)
    if args.stdout:
        ctx.out(text)
        return 0
    target = spec_path(ctx)
    _write_private(target, text)
    _remember(ctx, {
        "app_name": inputs.app_name, "region": inputs.region, "engine_host": inputs.host,
        "engine_source": deploy_render.source_text(inputs.source),
        "server_mode": inputs.server_mode,
    })
    names = ", ".join(str(c.get("name")) for _kind, c in deploy_render.components(spec))
    ctx.out(f"Wrote {target}")
    ctx.out(f"App {inputs.app_name} in {inputs.region}, hostname {inputs.host}.")
    ctx.out(f"Builds from {deploy_render.source_text(inputs.source)}. Components: {names}.")
    skipped = deploy_render.skipped_sources(inputs)
    if skipped:
        ctx.out(f"Server mode is off, so the enabled sources ({', '.join(skipped)}) get no "
                "scheduled job. To run the pullers on DigitalOcean, render with --server-mode.")
    ctx.out("Secrets it declares (no values; `python -m kbe deploy secrets push` sets them "
            "after apply):")
    for line in _secret_lines(spec):
        ctx.out(line)
    ctx.out("Next: python -m kbe deploy apply")
    return 0


def _rendered(ctx: Context) -> Mapping[str, Any]:
    import yaml

    path = spec_path(ctx)
    if not path.is_file():
        raise KbeError(f"No rendered spec at {path}. Run: python -m kbe deploy render")
    try:
        spec = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise KbeError(
            f"{path} could not be read. Run `python -m kbe deploy render` again."
        ) from error
    if not isinstance(spec, Mapping) or not spec.get("services"):
        raise KbeError(f"{path} is not an app spec. Run `python -m kbe deploy render` again.")
    return spec


def _doctl(ctx: Context) -> deploy_doctl.Doctl:
    return deploy_doctl.Doctl(ctx.runner, secrets.load_optional(ctx.env_file))


def _app_id(args: argparse.Namespace, ctx: Context, required: bool = True) -> str | None:
    found = args.app_id or state.answer(state.load(ctx.state_file), "do_app_id")
    if not found:
        if required:
            raise KbeError("No app yet. Run `python -m kbe deploy apply`, or pass --app-id.")
        return None
    return deploy_doctl.check_app_id(str(found))


def _after_apply(ctx: Context, spec: Mapping[str, Any], app: deploy_doctl.App) -> None:
    ctx.out("The app's secrets, and where each value comes from:")
    for line in _secret_lines(spec):
        ctx.out(line)
    ctx.out("DigitalOcean does not reveal whether a secret holds a value, so this list "
            "cannot say which are set.")
    ctx.out("`python -m kbe deploy secrets push` (a preview) shows which ones have a local "
            "value to send; with --yes it sets them.")
    ctx.out("Or enter them in the DigitalOcean dashboard (app -> Settings -> the "
            "component -> Environment Variables, as Encrypted).")
    if app.default_hostname:
        host = (spec.get("domains") or [{}])[0].get("domain", "your hostname")
        ctx.out(f"The app's own address: {app.default_hostname}")
        ctx.out(f"Once the secrets are set, open setup at exactly this address: "
                f"https://{app.default_hostname}/setup")
        ctx.out(f"The setup page points {host} at it; you do not make a DNS record by hand.")
    else:
        ctx.out("The app's own address is assigned after its first deploy. "
                "See it with: python -m kbe deploy status")


def _create(args: argparse.Namespace, ctx: Context, spec: Mapping[str, Any]) -> int:
    ctx.out(f'This creates a new DigitalOcean app "{spec.get("name")}" (it is billed).')
    if args.dry_run:
        ctx.out(f"Dry run: would run doctl apps create --spec {spec_path(ctx)}")
        return 0
    if not args.yes and not ctx.confirm("Create the app?"):
        raise KbeError("Not created. Re-run with --yes to create without being asked.")
    app = _doctl(ctx).create(spec_path(ctx))
    _remember(ctx, {"do_app_id": app.id, "do_default_hostname": app.default_hostname}, done=True)
    ctx.out(f"Created app {app.id}. Its first deploy fails until the secrets are set; "
            "that is expected.")
    _after_apply(ctx, spec, app)
    return 0


def _update(args: argparse.Namespace, ctx: Context, spec: Mapping[str, Any], app_id: str) -> int:
    doctl = _doctl(ctx)
    live = doctl.live_spec(app_id)
    merged = deploy_merge.carry_over(spec, live)
    removed = deploy_merge.removed_components(merged, live)
    changes = deploy_merge.diff(live, merged)
    if not changes:
        ctx.out("No changes: the live app already matches the rendered spec.")
        _after_apply(ctx, merged, doctl.get(app_id))
        return 0
    ctx.out("Changes to the live app (secret values are kept and never shown):")
    for line in changes:
        ctx.out(line)
    if removed:
        ctx.out("WARNING: THIS UPDATE WOULD DELETE LIVE COMPONENTS: " + ", ".join(removed))
    if args.dry_run:
        ctx.out("Dry run: nothing was changed.")
        return 0
    if removed and not args.allow_remove:
        raise KbeError(
            "Nothing was changed. If deleting them is intended, re-run with --allow-remove."
        )
    question = "Delete those components and update the app?" if removed else "Update the app?"
    if (removed or not args.yes) and not ctx.confirm(question):
        raise KbeError("Not updated.")
    app = doctl.update(app_id, deploy_render.dump(merged))
    _remember(ctx, {"do_app_id": app.id, "do_default_hostname": app.default_hostname}, done=True)
    ctx.out(f"Updated app {app.id}.")
    _after_apply(ctx, merged, app)
    return 0


def _cmd_apply(args: argparse.Namespace, ctx: Context) -> int:
    spec = _rendered(ctx)
    app_id = _app_id(args, ctx, required=False)
    return _update(args, ctx, spec, app_id) if app_id else _create(args, ctx, spec)


def _cmd_status(args: argparse.Namespace, ctx: Context) -> int:
    app_id = _app_id(args, ctx)
    doctl = _doctl(ctx)
    app = doctl.get(app_id)
    runs = doctl.job_runs(app_id)
    if app.default_hostname:
        _remember(ctx, {"do_default_hostname": app.default_hostname})
    if args.json:
        ctx.out(json.dumps({
            "app_id": app.id, "name": app.name, "default_hostname": app.default_hostname,
            "active_deployment": {"phase": app.phase, "at": app.deployed_at},
            "in_progress_deployment": app.in_progress or None,
            "job_runs": None if runs is None else [vars(run) for run in runs],
        }, indent=2))
        return 0
    ctx.out(f"App {app.name or app.id} ({app.id})")
    when = f" at {app.deployed_at}" if app.deployed_at else ""
    ctx.out(f"Active deployment: {app.phase}{when}")
    if app.in_progress:
        ctx.out(f"Deployment in progress: {app.in_progress}")
    ctx.out(f"Default hostname: {app.default_hostname or 'not assigned yet'}")
    if runs is None:
        ctx.out("Last job runs: unknown (this doctl cannot list them)")
    elif not runs:
        ctx.out("Last job runs: none yet")
    for run in runs or []:
        ctx.out(f"  {run.job}: {run.phase}" + (f" at {run.at}" if run.at else ""))
    return 0


def _cmd_redeploy(args: argparse.Namespace, ctx: Context) -> int:
    app_id = _app_id(args, ctx)
    if args.dry_run:
        ctx.out(f"Dry run: would run doctl apps create-deployment {app_id}")
        return 0
    if not args.yes and not ctx.confirm("Build and deploy the app again from its source?"):
        raise KbeError("Not deployed. Re-run with --yes to deploy without being asked.")
    deployment = _doctl(ctx).deploy(app_id)
    ctx.out(f"Deployment {deployment or 'started'}. Follow it with: python -m kbe deploy status")
    return 0


def _cmd_secrets_push(args: argparse.Namespace, ctx: Context) -> int:
    return deploy_push.run(args, ctx, str(_app_id(args, ctx)))


def _add_render(commands: argparse._SubParsersAction) -> None:
    render = commands.add_parser(
        "render", help="write the app spec for this Engine",
        description="Fill in engine/deploy/do-app-spec.template.yaml and write the result "
        "to .kb-engine-local/do-app-spec.yaml (git-ignored): the service, one scheduled "
        "job per source that is enabled in the Engine config, and the hostname. Every "
        "secret is declared with no value. Answers are remembered for the next run.",
    )
    render.add_argument("--host", help="the Engine's public hostname, e.g. engine.example.com")
    render.add_argument("--app-name", help="the app's name (default: <engine id>-kb-engine)")
    render.add_argument("--region", help=f"DigitalOcean region slug (default: {DEFAULT_REGION})")
    render.add_argument("--config", metavar="PATH",
                        help="engine.yaml (default: the one in your knowledge repo)")
    render.add_argument("--source", metavar="github:<owner>/<repo>@<branch>",
                        help="build from a repository you have authorised in DigitalOcean "
                        "instead of the public one on its stable branch; "
                        "public@<branch> names another branch of the public one")
    render.add_argument("--cf-team-domain", metavar="URL",
                        help="keep the sign-in settings in the app's environment instead of "
                        "the database: https://<team>.cloudflareaccess.com (not a secret)")
    render.add_argument("--cf-aud", metavar="AUD", help="AUD tag of the hostname application")
    render.add_argument("--cf-status-aud", metavar="AUD",
                        help="AUD tag of the admin-pages application (optional)")
    render.add_argument("--server-mode", dest="server_mode", action="store_true", default=None,
                        help="add one scheduled puller job per enabled source (the Python "
                        "pullers; off by default, remembered for the next render)")
    render.add_argument("--no-server-mode", dest="server_mode", action="store_false",
                        help="the service alone, with no puller jobs (the default)")
    render.add_argument("--skip-source-check", action="store_true",
                        help="do not check that the branch to build from exists on the remote")
    render.add_argument("--stdout", action="store_true",
                        help="print the spec and write nothing")
    render.set_defaults(func=_cmd_render)


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "deploy", help="render the app spec, create or update the app, see its state",
        description="The Engine runs as one DigitalOcean app. These commands write its "
        "spec, create or update the app with doctl, and set its secrets from the local "
        "env file. No command takes a secret value as an argument.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")
    _add_render(commands)
    deploy_push.add_parser(commands, _cmd_secrets_push)

    apply = commands.add_parser(
        "apply", help="create the app, or update the one that exists",
        description="With no app yet: creates it from the rendered spec and remembers its "
        "id. With an app: reads the live spec, keeps every stored secret value, shows a "
        "diff of the other changes and asks before updating. Then lists the app's "
        "secrets by name and where each value comes from (the platform does not reveal "
        "which ones hold a value).",
    )
    apply.add_argument("--allow-remove", action="store_true",
                       help="let an update delete live components the new spec lacks")
    redeploy = commands.add_parser(
        "redeploy", help="build and deploy the app again",
        description="Start a new deployment of the app from its source, for example "
        "after setting secrets or when the stable branch has moved on. Asks first.",
    )
    for command, func in ((apply, _cmd_apply), (redeploy, _cmd_redeploy)):
        command.add_argument("--dry-run", action="store_true", help="show what would happen only")
        command.add_argument("--yes", action="store_true", help="do it without asking")
        command.set_defaults(func=func)

    status = commands.add_parser(
        "status", help="the app's deployment and its last job runs",
        description="Show the active deployment and its phase, the app's default "
        "hostname, and the latest run of each scheduled job when doctl can list them.",
    )
    status.add_argument("--json", action="store_true", help="machine-readable output")
    status.set_defaults(func=_cmd_status)
    for command in (apply, redeploy, status):
        command.add_argument("--app-id", metavar="ID",
                             help="the app to act on (default: the one this tool created)")

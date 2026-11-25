#!/usr/bin/env python3
"""Every registered puller satisfies the `Puller` contract.

    python -m pullers.puller_contract_test

Structural check only -- SOURCE / fetch / to_document exist with the right
shapes. Does NOT call any source API (no --network mode here, deliberately:
a puller hitting Gmail/Fireflies/Drive live is what `runner.py --dry-run`
is for). This test's whole job is to fail loudly if a new puller is added to
`pullers/runner.py::REGISTRY` without satisfying the contract -- the failure
mode `knowledge.connector_contract_test` already shipped once, where running
without `--network` silently tested only ONE connector and still printed
"All connectors pass the contract". This test iterates every entry in
REGISTRY explicitly and names each one it checked in its output.
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts"))
sys.path.insert(0, str(WORKSPACE_ROOT))

from pullers.runner import REGISTRY  # noqa: E402


class ContractError(AssertionError):
    """A registered puller does not satisfy the Puller contract."""


def check_puller(name: str, puller) -> None:
    if not hasattr(puller, "SOURCE") or not isinstance(puller.SOURCE, str) or not puller.SOURCE:
        raise ContractError(f"{name}: SOURCE must be a non-empty string")

    if not hasattr(puller, "fetch") or not callable(puller.fetch):
        raise ContractError(f"{name}: fetch() is missing")
    fetch_params = inspect.signature(puller.fetch).parameters
    if "cursor" not in fetch_params:
        raise ContractError(f"{name}: fetch() must accept a `cursor` argument")
    if "sb" not in fetch_params:
        raise ContractError(f"{name}: fetch() must accept an `sb` keyword argument")

    if not hasattr(puller, "to_document") or not callable(puller.to_document):
        raise ContractError(f"{name}: to_document() is missing")
    to_doc_params = inspect.signature(puller.to_document).parameters
    if len(to_doc_params) != 1:
        raise ContractError(f"{name}: to_document() must take exactly one argument (raw)")

    for flag in ("BRONZE", "FULL_SYNC"):
        if not hasattr(puller, flag) or not isinstance(getattr(puller, flag), bool):
            raise ContractError(f"{name}: {flag} must be a bool constant")


def main() -> int:
    if not REGISTRY:
        print("[puller-contract] FAIL: REGISTRY is empty", file=sys.stderr)
        return 1

    checked = []
    failed = []
    for name, puller in REGISTRY.items():
        try:
            check_puller(name, puller)
            checked.append(name)
        except ContractError as error:
            failed.append((name, str(error)))

    print(f"[puller-contract] checked: {sorted(checked)}")
    if failed:
        for name, reason in failed:
            print(f"[puller-contract] FAIL {name}: {reason}", file=sys.stderr)
        return 1

    print(f"[puller-contract] all {len(checked)} registered puller(s) pass the contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""The hash of an Engine config -- one implementation, used by `kbe config
apply` and by the wiki puller, so both agree on whether a config changed."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping


def config_hash(config: Mapping[str, Any]) -> str:
    """SHA-256 of the config's canonical JSON. Comments and key order do not count.

    Raises ValueError for a value JSON cannot hold (a YAML date, for one).
    """
    try:
        canonical = json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, ValueError) as error:
        raise ValueError(f"the config holds a value that cannot be stored: {error}") from error
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

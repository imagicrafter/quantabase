"""The source jobs must build on DigitalOcean App Platform.

The platform chooses a buildpack BEFORE it runs a job's build command. A
cold-start run failed with "could not detect app files that match known
buildpacks" because nothing at the repository root said "Python".
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
TEMPLATE = ROOT / "engine" / "deploy" / "do-app-spec.template.yaml"


def test_the_repository_root_has_a_requirements_file_that_points_at_the_real_list():
    lines = (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
    active = [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]
    assert active == ["-r pullers/requirements.txt"]
    assert (ROOT / "pullers" / "requirements.txt").is_file()


def test_the_job_template_names_the_python_buildpack():
    spec = yaml.safe_load(TEMPLATE.read_text(encoding="utf-8"))
    jobs = spec["jobs"]
    assert jobs, "the template declares no job"
    for job in jobs:
        assert job["environment_slug"] == "python", job["name"]
        assert job["source_dir"] == "/", job["name"]

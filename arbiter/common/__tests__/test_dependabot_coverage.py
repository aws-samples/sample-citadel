"""Guard: every requirements file, npm lockfile and Dockerfile is covered by dependabot.

Sibling guard to ``test_requirements_ci_completeness`` (same directory), which
only checks that CI installs every ``arbiter/*/requirements.txt``. This test
checks the orthogonal concern: that Dependabot is configured to receive
update PRs for every dependency manifest in the repository, so a new
service/script doesn't silently fall outside automated dependency scanning.

Covers, repo-wide (excluding ``node_modules``, ``.venv*``, ``cdk.out``, ``dist``):
  * every ``requirements*.txt``                -> pip ecosystem entry
  * every ``package-lock.json``                 -> npm ecosystem entry
  * every ``Dockerfile*``                       -> docker ecosystem entry

A manifest is "covered" if its containing directory matches a
``directory``/``directories`` entry of the right ecosystem in
``.github/dependabot.yml``.
"""

from __future__ import annotations

import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent  # common/__tests__/ -> common/ -> arbiter/ -> repo root

EXCLUDED_DIR_NAMES = {"node_modules", "cdk.out", "dist"}


def _is_excluded(path: pathlib.Path) -> bool:
    for part in path.parts:
        if part in EXCLUDED_DIR_NAMES:
            return True
        if part.startswith(".venv"):
            return True
    return False


def _find_files(pattern: str) -> list[pathlib.Path]:
    found = []
    for path in sorted(REPO_ROOT.rglob(pattern)):
        if not path.is_file():
            continue
        if _is_excluded(path):
            continue
        found.append(path)
    return found


def _load_dependabot_entries(dependabot_path: pathlib.Path) -> list[dict]:
    """Return a list of {ecosystem, directories: [str, ...]} dicts.

    Tries PyYAML first (confirmed importable via arbiter/requirements-ci.txt's
    transitive dependency set); falls back to a small line parser if PyYAML
    is not importable in the environment running this test.
    """
    text = dependabot_path.read_text()

    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
        entries = []
        for update in data.get("updates", []):
            ecosystem = update.get("package-ecosystem")
            dirs = []
            if "directory" in update:
                dirs.append(update["directory"])
            if "directories" in update:
                dirs.extend(update["directories"])
            entries.append({"ecosystem": ecosystem, "directories": dirs})
        return entries
    except ImportError:
        return _parse_dependabot_lines(text)


def _parse_dependabot_lines(text: str) -> list[dict]:
    """Minimal line-based parser for dependabot.yml's `updates:` list.

    Only understands the subset of syntax this repo's dependabot.yml uses:
    a top-level `updates:` list of mappings, each with `package-ecosystem:`,
    and either `directory: <path>` or a `directories:` block of `- <path>`
    list items. Good enough as a PyYAML-unavailable fallback; not a general
    YAML parser.
    """
    entries: list[dict] = []
    current: dict | None = None
    in_directories_block = False

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()

        if stripped.startswith("- package-ecosystem:"):
            if current is not None:
                entries.append(current)
            ecosystem = stripped.split(":", 1)[1].strip()
            current = {"ecosystem": ecosystem, "directories": []}
            in_directories_block = False
            continue

        if current is None:
            continue

        if stripped.startswith("directory:"):
            value = stripped.split(":", 1)[1].strip()
            current["directories"].append(value)
            in_directories_block = False
            continue

        if stripped == "directories:":
            in_directories_block = True
            continue

        if in_directories_block:
            if stripped.startswith("- "):
                current["directories"].append(stripped[2:].strip())
                continue
            else:
                in_directories_block = False

    if current is not None:
        entries.append(current)

    return entries


def _normalize_dir(raw: str) -> str:
    """Normalize a dependabot `directory`/`directories` entry for comparison.

    Strips a trailing slash, but never strips the root "/" down to "".
    """
    stripped = raw.rstrip("/")
    return stripped if stripped else "/"


def _covering_dirs(entries: list[dict], ecosystem: str) -> set[str]:
    dirs: set[str] = set()
    for entry in entries:
        if entry["ecosystem"] == ecosystem:
            for d in entry["directories"]:
                dirs.add(_normalize_dir(d))
    return dirs


def _repo_relative_dir(path: pathlib.Path) -> str:
    rel_dir = path.parent.relative_to(REPO_ROOT)
    if str(rel_dir) == ".":
        return "/"
    return "/" + str(rel_dir)


def _uncovered(files: list[pathlib.Path], covering_dirs: set[str]) -> list[str]:
    missing = []
    for f in files:
        rel_dir = _repo_relative_dir(f)
        if rel_dir not in covering_dirs:
            missing.append(str(f.relative_to(REPO_ROOT)))
    return missing


def test_dependabot_covers_every_requirements_lockfile_and_dockerfile():
    dependabot_path = REPO_ROOT / ".github" / "dependabot.yml"
    assert dependabot_path.exists(), ".github/dependabot.yml is missing"

    entries = _load_dependabot_entries(dependabot_path)

    pip_dirs = _covering_dirs(entries, "pip")
    npm_dirs = _covering_dirs(entries, "npm")
    docker_dirs = _covering_dirs(entries, "docker")

    requirements_files = _find_files("requirements*.txt")
    lockfiles = _find_files("package-lock.json")
    dockerfiles = _find_files("Dockerfile*")

    assert requirements_files, "Expected at least one requirements*.txt in the repo"
    assert lockfiles, "Expected at least one package-lock.json in the repo"
    assert dockerfiles, "Expected at least one Dockerfile in the repo"

    missing_pip = _uncovered(requirements_files, pip_dirs)
    missing_npm = _uncovered(lockfiles, npm_dirs)
    missing_docker = _uncovered(dockerfiles, docker_dirs)

    failures = []
    if missing_pip:
        failures.append(f"pip-uncovered requirements files: {missing_pip}")
    if missing_npm:
        failures.append(f"npm-uncovered package-lock.json files: {missing_npm}")
    if missing_docker:
        failures.append(f"docker-uncovered Dockerfiles: {missing_docker}")

    assert not failures, (
        "The following dependency manifests are not covered by a matching "
        "ecosystem entry in .github/dependabot.yml: " + "; ".join(failures)
    )

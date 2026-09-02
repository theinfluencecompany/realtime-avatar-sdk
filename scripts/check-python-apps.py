"""Every Python example must compile AND import.

The FastAPI quickstart shipped for weeks with `Depends(current_user)` on a name that was
never defined: it parsed fine, so nothing here noticed, and `uvicorn main:app` died with a
NameError before binding a port. Python resolves names at import, not at parse — so this
imports every example module, with placeholder values for the variables its sibling
`.env.example` declares. Third-party imports come from each example's requirements.txt:

    pip install -r apps/quickstart/python-fastapi/requirements.txt
    python3 scripts/check-python-apps.py
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import py_compile
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SKIP_PARTS = {"node_modules", ".venv", "venv", "__pycache__"}


def env_from_example(folder: pathlib.Path) -> dict[str, str]:
    """Placeholder values for every KEY the example's .env.example declares."""
    env: dict[str, str] = {}
    example = folder / ".env.example"
    if not example.exists():
        return env
    for line in example.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip() or "placeholder-placeholder"
    return env


def main() -> int:
    files = sorted(
        p for p in (ROOT / "apps").rglob("*.py") if not (SKIP_PARTS & set(p.parts))
    )
    if not files:
        print("no Python examples under apps/ — nothing to check")
        return 0
    failures = 0
    for path in files:
        rel = path.relative_to(ROOT)
        try:
            py_compile.compile(str(path), doraise=True)
        except py_compile.PyCompileError as err:
            print(f"✗ {rel}: does not compile\n{err}")
            failures += 1
            continue
        # Every example file is imported, so a script must guard its entry point with
        # `if __name__ == "__main__":` — importing it must start nothing.
        saved = dict(os.environ)
        os.environ.update(env_from_example(path.parent))
        cwd = os.getcwd()
        os.chdir(path.parent)
        sys.path.insert(0, str(path.parent))
        try:
            spec = importlib.util.spec_from_file_location(f"_check_{path.stem}", path)
            module = importlib.util.module_from_spec(spec)
            assert spec.loader is not None
            spec.loader.exec_module(module)
            print(f"✓ {rel} (imported)")
        except Exception as err:  # noqa: BLE001 — any import-time error is the finding
            print(f"✗ {rel}: import failed — {type(err).__name__}: {err}")
            failures += 1
        finally:
            sys.path.pop(0)
            os.chdir(cwd)
            os.environ.clear()
            os.environ.update(saved)
    if failures:
        print(f"\n{failures} Python example(s) would not run as shipped")
        return 1
    print(f"\n{len(files)} Python example file(s) compile and import")
    return 0


if __name__ == "__main__":
    sys.exit(main())

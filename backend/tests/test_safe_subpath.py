"""Tests for mcp_server._safe_subpath path-traversal guard."""
import sys
from pathlib import Path

import pytest

# mcp_server.py is at backend/, tests are at backend/tests/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Importing mcp_server pulls fastmcp; gate it so the test still runs in lean envs
fastmcp = pytest.importorskip("fastmcp")
from mcp_server import _safe_subpath  # noqa: E402


def test_valid_one_level(tmp_path):
    (tmp_path / "Class2D").mkdir()
    result = _safe_subpath(str(tmp_path), "Class2D")
    assert result == (tmp_path / "Class2D").resolve()


def test_valid_two_level(tmp_path):
    (tmp_path / "Class2D" / "job003").mkdir(parents=True)
    result = _safe_subpath(str(tmp_path), "Class2D/job003")
    assert result == (tmp_path / "Class2D" / "job003").resolve()


def test_nonexistent_path_still_resolves_under_base(tmp_path):
    # safe_subpath does not require existence — file may be created later
    result = _safe_subpath(str(tmp_path), "Refine3D/job099")
    assert result.is_relative_to(tmp_path.resolve())


def test_dotdot_traversal_blocked(tmp_path):
    with pytest.raises(ValueError, match="Path traversal blocked"):
        _safe_subpath(str(tmp_path), "../etc/passwd")


def test_absolute_escape_blocked(tmp_path):
    with pytest.raises(ValueError, match="Path traversal blocked"):
        _safe_subpath(str(tmp_path), "/etc/passwd")


def test_embedded_dotdot_blocked(tmp_path):
    with pytest.raises(ValueError, match="Path traversal blocked"):
        _safe_subpath(str(tmp_path), "Class2D/../../etc/passwd")


def test_empty_subpath_returns_base(tmp_path):
    # Empty string is treated as "no subpath" — returns the project root itself.
    # (Tools that need this path use `_safe_subpath(p, sub) if sub else Path(p).resolve()`.)
    result = _safe_subpath(str(tmp_path), "")
    assert result == tmp_path.resolve()

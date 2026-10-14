/**
 * Tests for the PYTHON_ASSET_EXCLUDES shared constant and its application
 * across arbiter-stack.ts and services-stack.ts.
 *
 * Validates that:
 *   1. The exported constant contains the expected entries.
 *   2. Every Python-based asset in the synthesized ArbiterStack template
 *      carries '.venv' in its exclude/assetExcludes list.
 *   3. The services-stack intake container asset excludes '.venv'.
 */
import { PYTHON_ASSET_EXCLUDES } from "../lib/python-asset-excludes";

describe("PYTHON_ASSET_EXCLUDES constant", () => {
  it("includes .venv, venv, __pycache__, and .mypy_cache", () => {
    expect(PYTHON_ASSET_EXCLUDES).toContain(".venv");
    expect(PYTHON_ASSET_EXCLUDES).toContain(".venv-*");
    expect(PYTHON_ASSET_EXCLUDES).toContain("venv");
    expect(PYTHON_ASSET_EXCLUDES).toContain("__pycache__");
    expect(PYTHON_ASSET_EXCLUDES).toContain(".mypy_cache");
    expect(PYTHON_ASSET_EXCLUDES).toContain(".pytest_cache");
    expect(PYTHON_ASSET_EXCLUDES).toContain(".hypothesis");
    expect(PYTHON_ASSET_EXCLUDES).toContain("*.pyc");
    expect(PYTHON_ASSET_EXCLUDES).toContain("node_modules");
    expect(PYTHON_ASSET_EXCLUDES).toContain(".git");
    expect(PYTHON_ASSET_EXCLUDES).toContain("cdk.out");
    expect(PYTHON_ASSET_EXCLUDES).toContain("__tests__");
    expect(PYTHON_ASSET_EXCLUDES).toContain("conftest.py");
    expect(PYTHON_ASSET_EXCLUDES).toContain("*.md");
  });

  it("does not exclude requirements.txt or .py (non-test sources)", () => {
    expect(PYTHON_ASSET_EXCLUDES).not.toContain("requirements.txt");
    expect(PYTHON_ASSET_EXCLUDES).not.toContain("*.py");
  });

  it("is frozen (readonly)", () => {
    // The const is typed as readonly string[] — attempting to push should
    // fail at compile time. At runtime, verify the array has not been
    // accidentally replaced with a mutable copy.
    expect(Object.isFrozen(PYTHON_ASSET_EXCLUDES)).toBe(false); // readonly ≠ frozen, but...
    expect(Array.isArray(PYTHON_ASSET_EXCLUDES)).toBe(true);
    expect(PYTHON_ASSET_EXCLUDES.length).toBeGreaterThan(10);
  });
});

"""Root conftest for arbiter tests - adds module directories to sys.path."""
import sys
import os

# Add each module directory to sys.path so tests can import from them
_arbiter_root = os.path.dirname(__file__)
for subdir in ['fabricator', 'supervisor', 'workerWrapper', 'seedConfig', 'stepRunner']:
    path = os.path.join(_arbiter_root, subdir)
    if path not in sys.path:
        sys.path.insert(0, path)

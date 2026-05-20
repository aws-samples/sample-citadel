"""
Subprocess agent runner.

Executed by the worker wrapper as an isolated subprocess. Receives the
agent module path and request payload via stdin (JSON). Scoped AWS
credentials are injected into this process's environment by the parent
— they never touch the parent's os.environ.

Writes the agent response as a JSON line to stdout.
"""

import json
import sys
import importlib.util


def main():
    # Read input from stdin (single JSON line)
    raw = sys.stdin.read()
    payload = json.loads(raw)

    module_path = payload['modulePath']
    request = payload.get('request', {})

    # Load and execute the agent module
    spec = importlib.util.spec_from_file_location("agent_module", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    try:
        response = module.handler(**request)
    except Exception as e:
        response = f"Agent execution failed: {e}"

    # Write response as JSON to stdout
    print(json.dumps({"response": str(response)}))


if __name__ == "__main__":
    main()

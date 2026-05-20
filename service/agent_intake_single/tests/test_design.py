"""Test generate_technical_design against a real session."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from tools.design import generate_technical_design

SESSION_ID = sys.argv[1] if len(sys.argv) > 1 else "session-2d7bc5f39664486191b944575163ec3a"

if __name__ == "__main__":
    print("=== Generating technical design ===")
    result = generate_technical_design(SESSION_ID)
    print(result)

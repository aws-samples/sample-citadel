"""Test extract_information against a real session."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from tools.extract import extract_information, get_assessment_summary, get_next_assessment_question

SESSION_ID = sys.argv[1] if len(sys.argv) > 1 else "session-2d7bc5f39664486191b944575163ec3a"

if __name__ == "__main__":
    print("=== Running extraction ===")
    result = extract_information(SESSION_ID)
    print(result)

    print("\n=== Assessment summary ===")
    print(get_assessment_summary(SESSION_ID))

    print("\n=== Next question ===")
    print(get_next_assessment_question(SESSION_ID))

#!/usr/bin/env python3
"""
Interactive CLI client for Agent 1 running locally on localhost:8080
"""

import requests
import json
import argparse
import uuid
import sys
import termios
import tty
import select


class LocalAgentChatSession:
    def __init__(self, port: int = 8080, session_id: str = None):
        self.port = port
        self.url = f"http://localhost:{port}/invocations"
        
        # Handle session ID
        if session_id:
            self.session_id = session_id
        else:
            self.session_id = f"session-{uuid.uuid4().hex}"
            
        self.turn_count = 0
        
        # Test connection
        try:
            response = requests.get(f"http://localhost:{port}/health", timeout=5)
        except requests.exceptions.RequestException:
            print(f"❌ Cannot connect to localhost:{port}", file=sys.stderr)
            print("Make sure the agent is running locally with: python agent.py", file=sys.stderr)
            sys.exit(1)
    
    def detect_ctrl_f(self, user_input):
        """Check if Ctrl+F was pressed during input"""
        # This is a simple approach - in practice, you'd need more sophisticated input handling
        return user_input == '\x06'  # Ctrl+F ASCII code
        
    def invoke(self, prompt: str, document_key: str = None):
        """Invoke the local agent with a prompt and optional document key"""
        self.turn_count += 1
        
        try:
            headers = {
                'Content-Type': 'application/json'
            }
            
            payload = {"prompt": prompt, "session_id": self.session_id}
            
            # Add document key if provided
            if document_key:
                payload["document_upload_key"] = document_key
            
            response = requests.post(
                self.url,
                headers=headers,
                json=payload,
                stream=True,
                timeout=300
            )
            
            if not response.ok:
                print(f"\n❌ Error: Request failed with status {response.status_code}", file=sys.stderr)
                print(f"Response: {response.text}", file=sys.stderr)
                return None
            
            # Handle streaming response
            content = []
            for line in response.iter_lines(decode_unicode=True):
                if line:
                    if line.startswith("data: "):
                        chunk = line[6:]
                        try:
                            # Parse JSON and extract text, handle formatting
                            chunk_data = json.loads(chunk)
                            if isinstance(chunk_data, str):
                                # Clean up escaped quotes and newlines
                                formatted_chunk = chunk_data.replace('""', '').replace('\\n', '\n')
                                print(formatted_chunk, end='', flush=True)
                                content.append(formatted_chunk)
                            else:
                                print(chunk, end='', flush=True)
                                content.append(chunk)
                        except json.JSONDecodeError:
                            # If not JSON, print as-is
                            print(chunk, end='', flush=True)
                            content.append(chunk)
                    else:
                        print(line, end='', flush=True)
                        content.append(line)
            
            print()  # New line after streaming
            return ''.join(content)
                
        except Exception as e:
            print(f"\n❌ Error: {str(e)}", file=sys.stderr)
            return None
    
    def start(self):
        """Start the interactive chat session"""
        print("=" * 80)
        print("🤖 Agent 1 - Local Development Interactive Chat")
        print("=" * 80)
        print(f"Local URL: {self.url}")
        print(f"Session ID: {self.session_id}")
        print("\nCommands:")
        print("  - Type your message and press Enter to chat")
        print("  - Type 'exit' or 'quit' to end the session")
        print("  - Type 'clear' to clear the screen")
        print("  - Type 'info' to show session information")
        print("  - Type 'help' for assessment guidance")
        print("  - Type 'upload' to upload a document")
        print("=" * 80)
        print("\n💡 Try asking about:")
        print("  - 'What technical information do you need for assessment?'")
        print("  - 'Show me the business assessment categories'")
        print("  - 'Help me understand the governance requirements'")
        print()
        
        while True:
            try:
                # Get user input
                user_input = input(f"\n[Turn {self.turn_count + 1}] You: ").strip()
                
                # Handle commands
                if user_input.lower() in ['exit', 'quit']:
                    print("\n👋 Ending session. Goodbye!")
                    break
                
                if user_input.lower() == 'clear':
                    print("\033[2J\033[H", end='')  # Clear screen
                    continue
                
                if user_input.lower() == 'info':
                    print(f"\n📊 Session Info:")
                    print(f"   Local URL: {self.url}")
                    print(f"   Session ID: {self.session_id}")
                    print(f"   Turns: {self.turn_count}")
                    continue
                
                if user_input.lower() == 'help':
                    print(f"\n📋 Assessment Dimensions:")
                    print(f"   • Technical Feasibility (30%): Architecture, integration, data strategy")
                    print(f"   • Governance & Compliance (25%): Risk management, regulatory requirements")
                    print(f"   • Business Feasibility (25%): Objectives, stakeholder buy-in, culture")
                    print(f"   • Commercial & Economics (20%): Budget, ROI, cost modeling")
                    continue
                
                if user_input.lower() == 'upload':
                    # Handle document upload
                    document_key = input("📄 Enter document key (S3 path): ").strip()
                    if not document_key:
                        print("❌ Document key cannot be empty")
                        continue
                    
                    message = input("💬 Enter message about the document: ").strip()
                    if not message:
                        message = f"Please analyze the uploaded document: {document_key}"
                    
                    print(f"\n🤖 Agent: ", end='', flush=True)
                    self.invoke(message, document_key)
                    continue
                
                if not user_input:
                    continue
                
                # Invoke agent
                print(f"\n🤖 Agent: ", end='', flush=True)
                self.invoke(user_input)
                
            except KeyboardInterrupt:
                print("\n\n👋 Session interrupted. Goodbye!")
                break
            except EOFError:
                print("\n\n👋 Session ended. Goodbye!")
                break


def main():
    parser = argparse.ArgumentParser(
        description="Interactive CLI client for Agent 1 running locally",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  python agent_local_cli_interactive.py
  python agent_local_cli_interactive.py --port 8080
        """
    )
    
    parser.add_argument(
        '--port',
        type=int,
        default=8080,
        help='Local port where agent is running (default: 8080)'
    )
    
    args = parser.parse_args()
    
    print(f"🔗 Connecting to local agent on port {args.port}...")
    
    # Get session ID from user
    session_input = input("📝 Enter session ID (press Enter to auto-generate): ").strip()
    session_id = session_input if session_input else None
    
    # Start interactive session
    session = LocalAgentChatSession(port=args.port, session_id=session_id)
    session.start()


if __name__ == "__main__":
    main()

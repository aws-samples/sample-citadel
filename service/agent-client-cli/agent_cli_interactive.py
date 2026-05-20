#!/usr/bin/env python3
"""
Interactive CLI client for multi-turn conversations with Bedrock AgentCore agents
Uses AWS IAM credentials for authentication via boto3
"""

import boto3
import json
import argparse
import uuid
import sys
import os


class AgentChatSession:
    def __init__(self, agent_arn: str, region: str = 'ap-southeast-2', session_id: str = None):
        self.agent_arn = agent_arn
        self.region = region
        
        # Handle session ID
        if session_id:
            self.session_id = session_id
        else:
            self.session_id = f"session-{uuid.uuid4().hex}"
            
        self.turn_count = 0
        
        # Initialize boto3 client
        try:
            self.client = boto3.client('bedrock-agentcore', region_name=region)
           
        except Exception as e:
            print(f"❌ Failed to initialize AWS client: {e}", file=sys.stderr)
            print("Make sure your AWS credentials are configured (aws configure)", file=sys.stderr)
            sys.exit(1)
        
    def invoke(self, prompt: str, document_key: str = None):
        """Invoke the agent with a prompt and optional document key"""
        self.turn_count += 1
        
        try:
            # Prepare payload matching agent.py expected format
            payload_data = {
                "prompt": prompt,
                "session_id": self.session_id
            }
            
            # Add document key in nested structure if provided
            if document_key:
                payload_data["sessionAttributes"] = {
                    "metadata": {
                        "document_upload_key": document_key
                    }
                }
            
            payload = json.dumps(payload_data)
            
            # Invoke agent
            response = self.client.invoke_agent_runtime(
                agentRuntimeArn=self.agent_arn,
                runtimeSessionId=self.session_id,
                payload=payload,
                qualifier="DEFAULT"
            )
            
            # Handle streaming response
            if "text/event-stream" in response.get("contentType", ""):
                content = []
                for line in response["response"].iter_lines(chunk_size=1):
                    if line:
                        line = line.decode("utf-8")
                        if line.startswith("data: "):
                            chunk = line[6:]
                            # Parse JSON and extract text, handle formatting
                            try:
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
                print()  # New line after streaming
                return ''.join(content)
            else:
                # Non-streaming response
                response_body = response['response'].read()
                if response_body:
                    response_data = json.loads(response_body)
                    print("Agent Response:", response_data)
                    return response_data
                else:
                    print("No response received")
                    return None
                
        except Exception as e:
            print(f"\n❌ Error: {str(e)}", file=sys.stderr)
            return None
    
    def start(self):
        """Start the interactive chat session"""
        print("=" * 80)
        print("🤖 Agent 1 - Assessment & Evaluation Interactive Chat")
        print("=" * 80)
        print(f"Agent ARN: {self.agent_arn}")
        print(f"Session ID: {self.session_id}")
        print(f"Region: {self.region}")
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
                    print(f"   Agent ARN: {self.agent_arn}")
                    print(f"   Session ID: {self.session_id}")
                    print(f"   Region: {self.region}")
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
        description="Interactive CLI client for Agent 1 - Assessment & Evaluation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  python agent_cli_interactive.py \\
    --agent-arn arn:aws:bedrock-agentcore:ap-southeast-2:123456789012:runtime/agent1_assessment-XXXXX
        """
    )
    
    parser.add_argument(
        '--agent-arn',
        required=True,
        help='ARN of the Agent 1 runtime to invoke'
    )
    
    parser.add_argument(
        '--region',
        default='ap-southeast-2',
        help='AWS region (default: ap-southeast-2)'
    )
    
    args = parser.parse_args()
    
    # Check AWS credentials
    try:
        boto3.Session().get_credentials()
        print("✅ AWS credentials found\n")
    except Exception as e:
        print(f"❌ AWS credentials not configured: {e}", file=sys.stderr)
        print("Run 'aws configure' to set up your credentials", file=sys.stderr)
        sys.exit(1)
    
    # Get session ID from user
    session_input = input("📝 Enter session ID (press Enter to auto-generate): ").strip()
    session_id = session_input if session_input else None
    
    # Start interactive session
    session = AgentChatSession(agent_arn=args.agent_arn, region=args.region, session_id=session_id)
    session.start()


if __name__ == "__main__":
    main()

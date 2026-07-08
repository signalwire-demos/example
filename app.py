"""
═══════════════════════════════════════════════════════════════════════════════
SignalWire AI Agent Example
═══════════════════════════════════════════════════════════════════════════════

A bare-bones but complete example demonstrating all key patterns for building
SignalWire AI agents with WebRTC frontends.

This example includes:
- AgentServer pattern for serving both API and static files
- SWML handler auto-registration on startup
- Guest token generation for WebRTC authentication
- SWAIG functions with @self.tool() decorator
- User events sent to frontend via swml_user_event()
- State persistence with global_data
- Post-prompt webhook support

Usage:
    python app.py                    # Run locally
    gunicorn app:app ...            # Run in production (see Procfile)

Environment Variables (see .env.example):
    SIGNALWIRE_SPACE_NAME           # Required: Your SignalWire space
    SIGNALWIRE_PROJECT_ID           # Required: Your project ID
    SIGNALWIRE_TOKEN                # Required: Your API token
    SWML_PROXY_URL_BASE or APP_URL  # Auto-detected on Dokku/Heroku, set for local

═══════════════════════════════════════════════════════════════════════════════
"""

import os
import time
import logging
import threading
import warnings
from pathlib import Path
from dotenv import load_dotenv

# ─────────────────────────────────────────────────────────────────────────────
# SignalWire Agents SDK imports
# ─────────────────────────────────────────────────────────────────────────────
from signalwire import AgentBase, AgentServer
from signalwire.core.function_result import SwaigFunctionResult
from signalwire.rest import RestClient
from fastapi.responses import JSONResponse

# Load environment variables from .env file (for local development)
load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
# Logging Configuration
# ─────────────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Global State
# ─────────────────────────────────────────────────────────────────────────────
# This dict stores the SWML handler info after registration on startup.
# It's used by the /get_token endpoint to provide the call address to clients.
swml_handler_info = {
    "id": None,           # Handler resource ID
    "address_id": None,   # Address resource ID (used to scope tokens)
    "address": None       # The SIP address clients dial to reach the agent
}
# Reason the last handler-setup attempt didn't complete (surfaced via /get_token)
swml_setup_error = None
# Serializes the lazy /get_token re-registration so workers don't race
_swml_setup_lock = threading.Lock()

# Server configuration
HOST = "0.0.0.0"
PORT = int(os.environ.get('PORT', 5000))


# ═══════════════════════════════════════════════════════════════════════════════
# SWML Handler Registration Functions
# ═══════════════════════════════════════════════════════════════════════════════
# These functions handle automatic registration of your agent with SignalWire
# so that incoming calls are routed to your SWML endpoint.
#
# URL Detection:
# - On Dokku/Heroku: APP_URL is set automatically by the platform
# - For local dev: Set SWML_PROXY_URL_BASE to your ngrok/tunnel URL
# - The SDK's get_full_url() also auto-detects from X-Forwarded headers at runtime

def get_signalwire_host():
    """
    Get the full SignalWire API host from the space name.

    The space name can be provided as either:
    - Just the space: "myspace" -> "myspace.signalwire.com"
    - Full domain: "myspace.signalwire.com" -> used as-is
    """
    space = os.getenv("SIGNALWIRE_SPACE_NAME", "")
    if not space:
        return None
    if "." in space:
        return space
    return f"{space}.signalwire.com"


def find_resource_address(addresses, agent_name):
    """
    Find the resource address matching /public/{agent_name} from a list of addresses.

    When phone numbers are attached to a handler, multiple addresses exist.
    We want the resource address (e.g., /public/example) not the phone number address.
    """
    expected_address = f"/public/{agent_name}"

    # First, try to find exact match for /public/{agent_name}
    for addr in addresses:
        audio_channel = addr.get("channels", {}).get("audio", "")
        if audio_channel == expected_address:
            return addr

    # Fallback: find any address that looks like a resource address (not a phone number)
    for addr in addresses:
        audio_channel = addr.get("channels", {}).get("audio", "")
        if audio_channel.startswith("/public/") and not any(c.isdigit() for c in audio_channel.split("/")[-1][:3]):
            return addr

    # Last resort: return first address
    return addresses[0] if addresses else None


def build_rest_client():
    """Construct a RestClient from env, or None if credentials are incomplete.

    RestClient() with no args reads SIGNALWIRE_API_TOKEN / SIGNALWIRE_SPACE, which
    do NOT match this demo's SIGNALWIRE_TOKEN / SIGNALWIRE_SPACE_NAME convention --
    so always pass project/token/host explicitly.
    """
    sw_host = get_signalwire_host()
    project = os.getenv("SIGNALWIRE_PROJECT_ID", "")
    token = os.getenv("SIGNALWIRE_TOKEN", "")
    if not all([sw_host, project, token]):
        return None
    return RestClient(project=project, token=token, host=sw_host)


def find_existing_handler(client, agent_name):
    """
    Find an existing SWML handler by name via the SDK RestClient.

    This prevents creating duplicate handlers on each deployment.
    We search by agent name rather than URL because the URL may change
    (e.g., different basic auth credentials).

    Args:
        client: A RestClient instance
        agent_name: The name to search for

    Returns:
        Dict with handler info if found, None otherwise
    """
    try:
        # swml_webhooks == External SWML Handler; response shape matches the
        # legacy REST endpoint 1:1.
        handlers = client.fabric.swml_webhooks.list().get("data", [])

        for handler in handlers:
            # The name is nested in the swml_webhook object
            swml_webhook = handler.get("swml_webhook", {})
            handler_name = swml_webhook.get("name") or handler.get("display_name")

            # Check if this handler matches our agent name
            if handler_name == agent_name:
                handler_id = handler.get("id")
                handler_url = swml_webhook.get("primary_request_url", "")

                # Get the address for this handler (needed for token scoping)
                addresses = client.fabric.swml_webhooks.list_addresses(handler_id).get("data", [])
                resource_addr = find_resource_address(addresses, agent_name)
                if resource_addr:
                    return {
                        "id": handler_id,
                        "name": handler_name,
                        "url": handler_url,
                        "address_id": resource_addr["id"],
                        "address": resource_addr["channels"]["audio"]
                    }
    except Exception as e:
        logger.error(f"Error finding existing handler: {e}")
    return None


def setup_swml_handler():
    """
    Set up SWML handler on startup.

    This function:
    1. Checks if a handler with our agent name already exists
    2. If yes: Updates the URL (in case credentials changed)
    3. If no: Creates a new handler
    4. Stores the handler info globally for use by /get_token

    The SWML URL includes basic auth credentials embedded in it so that
    SignalWire can authenticate when calling back to our endpoint.

    URL Priority:
    1. SWML_PROXY_URL_BASE (if set explicitly)
    2. APP_URL (auto-set by Dokku/Heroku)
    """
    global swml_setup_error

    # Get configuration from environment
    agent_name = os.getenv("AGENT_NAME", "example")

    # URL priority: SWML_PROXY_URL_BASE > APP_URL (auto-set by Dokku/Heroku)
    proxy_url = os.getenv("SWML_PROXY_URL_BASE", os.getenv("APP_URL", ""))
    auth_user = os.getenv("SWML_BASIC_AUTH_USER", "signalwire")
    auth_pass = os.getenv("SWML_BASIC_AUTH_PASSWORD", "")

    client = build_rest_client()
    if client is None:
        swml_setup_error = "SignalWire credentials not configured"
        logger.warning(f"{swml_setup_error} - skipping SWML handler setup")
        return

    if not proxy_url:
        swml_setup_error = "SWML_PROXY_URL_BASE/APP_URL not set"
        logger.warning(f"{swml_setup_error} - skipping SWML handler setup")
        return

    # Build SWML URL with basic auth credentials embedded
    # Format: https://user:pass@example.com/{agent_name}
    if auth_user and auth_pass and "://" in proxy_url:
        scheme, rest = proxy_url.split("://", 1)
        swml_url = f"{scheme}://{auth_user}:{auth_pass}@{rest}/{agent_name}"
    else:
        swml_url = f"{proxy_url}/{agent_name}"

    # Look for an existing handler by name
    existing = find_existing_handler(client, agent_name)

    if existing:
        # Handler exists - update the URL (credentials may have changed)
        swml_handler_info["id"] = existing["id"]
        swml_handler_info["address_id"] = existing["address_id"]
        swml_handler_info["address"] = existing["address"]

        try:
            client.fabric.swml_webhooks.update(
                existing["id"],
                primary_request_url=swml_url,
                primary_request_method="POST"
            )
            logger.info(f"Updated SWML handler: {existing['name']}")
        except Exception as e:
            logger.error(f"Failed to update handler URL: {e}")

        logger.info(f"Call address: {existing['address']}")
        swml_setup_error = None
        return

    # Create a new external SWML handler
    try:
        with warnings.catch_warnings():
            # create() emits a DeprecationWarning steering phone-number setups
            # toward phone_numbers.set_swml_webhook; a standalone dialable handler
            # (guest tokens dial its /public/{name} address) is intentional here.
            warnings.simplefilter("ignore", DeprecationWarning)
            handler = client.fabric.swml_webhooks.create(
                name=agent_name,
                used_for="calling",
                primary_request_url=swml_url,
                primary_request_method="POST"
            )
        handler_id = handler.get("id")
        swml_handler_info["id"] = handler_id

        # Get the address for this handler
        addresses = client.fabric.swml_webhooks.list_addresses(handler_id).get("data", [])
        resource_addr = find_resource_address(addresses, agent_name)
        if resource_addr:
            swml_handler_info["address_id"] = resource_addr["id"]
            swml_handler_info["address"] = resource_addr["channels"]["audio"]
            logger.info(f"Created SWML handler '{agent_name}' with address: {swml_handler_info.get('address')}")
            swml_setup_error = None
        else:
            swml_setup_error = "No address found for created handler"
            logger.error(swml_setup_error)
    except Exception as e:
        swml_setup_error = f"Failed to create SWML handler: {e}"
        logger.error(swml_setup_error)
        # Retry finding existing handler (another worker may have just created it)
        time.sleep(0.5)
        existing = find_existing_handler(client, agent_name)
        if existing:
            swml_handler_info["id"] = existing["id"]
            swml_handler_info["address_id"] = existing["address_id"]
            swml_handler_info["address"] = existing["address"]
            logger.info(f"Found existing SWML handler after retry: {existing['name']}")
            logger.info(f"Call address: {existing['address']}")
            swml_setup_error = None


# ═══════════════════════════════════════════════════════════════════════════════
# Agent Definition
# ═══════════════════════════════════════════════════════════════════════════════
# The agent class defines the AI personality, conversation flow, and tools (SWAIG
# functions) that the agent can use.

class ExampleAgent(AgentBase):
    """
    Example SignalWire AI Agent demonstrating all key patterns.

    This agent includes:
    - Three example SWAIG functions showing different patterns
    - State persistence via global_data
    - User events sent to the frontend
    - Dynamic configuration in on_swml_request
    """

    def __init__(self):
        """Initialize the agent with name and route."""
        super().__init__(
            name="Example Agent",
            route="/example"  # SWML endpoint path (matches AGENT_NAME default)
        )

        # Set up the agent's personality and tools
        self._setup_prompts()
        self._setup_functions()

    def _setup_prompts(self):
        """
        Configure the agent's personality and conversation flow.

        The prompt defines how the AI behaves, what it knows, and how it
        should respond to users.
        """
        # Main personality prompt - use prompt_add_section instead of set_prompt
        self.prompt_add_section(
            "Personality",
            """You are a helpful example assistant demonstrating SignalWire AI capabilities.
Be friendly and helpful. When users interact with you, use the appropriate
tool to demonstrate the feature. Explain what each tool does when you use it."""
        )

        self.prompt_add_section(
            "Available Tools",
            """You have access to three tools that you can use:
1. greet_user - Greet the user. IMPORTANT: Always call this FIRST when the conversation starts!
2. echo_message - Repeat back what the user said
3. increment_counter - Increment a counter (demonstrates state persistence)

IMPORTANT: When a user first connects, immediately call greet_user to welcome them.
- If they later tell you their name, call greet_user again with their name
- If they want you to repeat something, use echo_message
- If they want to count or track something, use increment_counter"""
        )

        # Post-prompt for conversation summaries (sent to webhook if configured)
        post_prompt_url = os.environ.get("POST_PROMPT_URL")
        if post_prompt_url:
            self.set_post_prompt(
                "Summarize this conversation briefly, including any greetings, "
                "echoed messages, and the final counter value if it was used."
            )
            self.set_post_prompt_url(post_prompt_url)

    def _setup_functions(self):
        """
        Register SWAIG functions (tools) that the agent can use.

        Each function is decorated with @self.tool() which defines:
        - name: How the AI calls it
        - description: When to use it (helps AI decide)
        - parameters: JSON Schema for expected arguments
        """

        # ─────────────────────────────────────────────────────────────────────
        # Function 1: greet_user
        # Demonstrates: Basic parameter handling and user events
        # ─────────────────────────────────────────────────────────────────────
        @self.tool(
            name="greet_user",
            description="Greet a user. ALWAYS call this tool first when a conversation starts to welcome the user. Call it again if they tell you their name.",
            parameters={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The name of the person to greet (optional, use 'friend' if unknown)"
                    }
                },
                "required": []
            }
        )
        def greet_user(args, raw_data):
            """
            Greet a user by name.

            Args:
                args: Dict containing 'name' parameter
                raw_data: Full request data including global_data

            Returns:
                SwaigFunctionResult with response text and user event
            """
            name = args.get("name", "friend")

            # Create the result with text for the AI to speak
            result = SwaigFunctionResult(f"Hello {name}! Welcome to the SignalWire example agent!")

            # Send user event to frontend - this updates the UI
            result.swml_user_event({
                "type": "greeting",
                "name": name,
                "timestamp": time.strftime("%H:%M:%S")
            })

            return result

        # ─────────────────────────────────────────────────────────────────────
        # Function 2: echo_message
        # Demonstrates: Bidirectional communication
        # ─────────────────────────────────────────────────────────────────────
        @self.tool(
            name="echo_message",
            description="Echo back a message. Use this when the user wants you to repeat something they said.",
            parameters={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The message to echo back"
                    }
                },
                "required": ["message"]
            }
        )
        def echo_message(args, raw_data):
            """
            Echo back a message from the user.

            This demonstrates how data flows from user -> AI -> SWAIG function -> frontend.
            """
            message = args.get("message", "")

            result = SwaigFunctionResult(f"You said: {message}")

            # Send echo event to frontend
            result.swml_user_event({
                "type": "echo",
                "message": message,
                "timestamp": time.strftime("%H:%M:%S")
            })

            return result

        # ─────────────────────────────────────────────────────────────────────
        # Function 3: increment_counter
        # Demonstrates: State persistence with global_data
        # ─────────────────────────────────────────────────────────────────────
        @self.tool(
            name="increment_counter",
            description="Increment a counter. Use this when the user wants to count something or track a number.",
            parameters={
                "type": "object",
                "properties": {
                    "amount": {
                        "type": "integer",
                        "description": "Amount to increment by (default: 1)",
                        "minimum": 1,
                        "maximum": 100
                    }
                },
                "required": []  # amount is optional
            }
        )
        def increment_counter(args, raw_data):
            """
            Increment a persistent counter.

            This demonstrates state persistence using global_data, which survives
            across multiple SWAIG function calls within the same conversation.

            Args:
                args: Dict with optional 'amount' parameter
                raw_data: Contains global_data for state persistence
            """
            # Get current state from global_data (persists across calls)
            global_data = raw_data.get('global_data', {})
            current_count = global_data.get('counter', 0)

            # Increment the counter
            amount = args.get('amount', 1)
            new_count = current_count + amount

            # Save updated state back to global_data
            global_data['counter'] = new_count

            # Create result with spoken response
            if amount == 1:
                response = f"Counter incremented! The count is now {new_count}."
            else:
                response = f"Counter increased by {amount}! The count is now {new_count}."

            result = SwaigFunctionResult(response)

            # IMPORTANT: Save the updated global_data
            result.update_global_data(global_data)

            # Send counter update to frontend
            result.swml_user_event({
                "type": "counter_updated",
                "count": new_count,
                "increment": amount,
                "timestamp": time.strftime("%H:%M:%S")
            })

            return result

    def on_swml_request(self, request_data, callback_path, request=None):
        """
        Hook called for each incoming SWML request.

        This is where you configure dynamic settings based on the environment
        or request data. Common uses:
        - Set video file URLs
        - Configure voice settings
        - Add speech hints for better recognition
        """
        # Get the base URL for media files
        # The SDK's get_full_url() auto-detects from X-Forwarded headers
        # Falls back to SWML_PROXY_URL_BASE or APP_URL if needed
        base_url = self.get_full_url(include_auth=False)

        # Configure video files (idle and talking avatars)
        if base_url:
            self.set_param("video_idle_file", f"{base_url}/sigmond_pc_idle.mp4")
            self.set_param("video_talking_file", f"{base_url}/sigmond_pc_talking.mp4")

        # Configure voice (using Google TTS)
        self.add_language(
            name="English",
            code="en-US",
            voice="elevenlabs.adam"  # Or use "en-US-Standard-J" for Google TTS
        )

        # Add speech hints for better recognition of domain-specific terms
        self.add_hints([
            "SignalWire",
            "SWAIG",
            "example",
            "counter",
            "increment"
        ])

        # Call parent implementation
        return super().on_swml_request(request_data, callback_path, request)


# ═══════════════════════════════════════════════════════════════════════════════
# Server Creation
# ═══════════════════════════════════════════════════════════════════════════════
# The create_server function sets up the FastAPI application with all routes
# and middleware.

def create_server(port=None):
    """
    Create AgentServer with static file mounting and API endpoints.

    This function:
    1. Creates an AgentServer instance
    2. Registers the agent at its route
    3. Serves static files from the web/ directory
    4. Adds custom API endpoints (/get_token, /health)
    5. Registers startup event for SWML handler setup

    Returns:
        AgentServer instance with everything configured
    """
    # Create the server
    server = AgentServer(host=HOST, port=port or PORT)

    # Create and register the agent
    agent = ExampleAgent()
    server.register(agent, "/example")

    # Serve static files from web/ directory (index.html, app.js, styles.css)
    web_dir = Path(__file__).parent / "web"
    if web_dir.exists():
        server.serve_static_files(str(web_dir))

    # ─────────────────────────────────────────────────────────────────────────
    # Health Check Endpoint
    # Required for Dokku/Heroku deployments to verify the app is running
    # ─────────────────────────────────────────────────────────────────────────
    @server.app.get("/health")
    def health_check():
        """Health check endpoint for deployment verification."""
        return {"status": "healthy", "agent": "example"}

    @server.app.get("/ready")
    def ready_check():
        """Readiness check - verifies SWML handler is configured."""
        if swml_handler_info.get("address"):
            return {"status": "ready", "address": swml_handler_info["address"]}
        return {"status": "initializing"}

    # ─────────────────────────────────────────────────────────────────────────
    # Token Generation Endpoint
    # This is how web clients get authentication tokens for WebRTC calls
    # ─────────────────────────────────────────────────────────────────────────
    @server.app.get("/get_token")
    def get_token():
        """
        Generate a guest token for the web client.

        This endpoint:
        1. Validates SignalWire credentials are configured
        2. Verifies SWML handler is registered
        3. Creates a scoped guest token via SignalWire API
        4. Returns token and destination address

        The frontend uses this to initialize the SignalWire client and dial.
        """
        # Handler registration may have been skipped/failed at startup (e.g. proxy
        # URL not yet set). Lazily retry once, serialized so workers don't race.
        if not swml_handler_info.get("address_id"):
            with _swml_setup_lock:
                if not swml_handler_info.get("address_id"):
                    setup_swml_handler()

        if not swml_handler_info.get("address_id"):
            return JSONResponse(
                {"error": f"SWML handler not registered: {swml_setup_error or 'check startup logs'}"},
                status_code=500
            )

        client = build_rest_client()
        if client is None:
            return JSONResponse({"error": "SignalWire credentials not configured"}, status_code=500)

        try:
            # Create guest token with 24-hour expiry, scoped to our address
            expire_at = int(time.time()) + 3600 * 24  # 24 hours
            guest = client.fabric.tokens.create_guest_token(
                allowed_addresses=[swml_handler_info["address_id"]],
                expire_at=expire_at
            )
            return {
                "token": guest.get("token", ""),
                "address": swml_handler_info["address"]
            }
        except Exception as e:
            logger.error(f"Token request failed: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)

    # ─────────────────────────────────────────────────────────────────────────
    # Debug Endpoint (optional - remove in production if desired)
    # ─────────────────────────────────────────────────────────────────────────
    @server.app.get("/get_resource_info")
    def get_resource_info():
        """Return SWML handler info for debugging."""
        return swml_handler_info

    # ─────────────────────────────────────────────────────────────────────────
    # Startup Event
    # Register SWML handler when the application starts
    # ─────────────────────────────────────────────────────────────────────────
    @server.app.on_event("startup")
    async def on_startup():
        """Register SWML handler on application startup."""
        setup_swml_handler()

    return server


# ═══════════════════════════════════════════════════════════════════════════════
# Module-Level Exports
# ═══════════════════════════════════════════════════════════════════════════════
# These are required for gunicorn to find the application.

# Create server instance
server = create_server()

# Expose the FastAPI app for gunicorn
# Usage in Procfile: gunicorn app:app --bind 0.0.0.0:$PORT ...
app = server.app


# ═══════════════════════════════════════════════════════════════════════════════
# Main Entry Point
# ═══════════════════════════════════════════════════════════════════════════════
# This runs when executing the script directly (not through gunicorn).

if __name__ == "__main__":
    server.run()

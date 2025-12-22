/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SignalWire AI Agent Example - Frontend JavaScript
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file demonstrates the complete client-side implementation for connecting
 * to a SignalWire AI agent, handling user events, and updating the UI.
 *
 * Key patterns demonstrated:
 * 1. Token fetching from /get_token endpoint
 * 2. SignalWire client initialization
 * 3. Event listener setup (multiple patterns for compatibility)
 * 4. User event handling and UI updates
 * 5. Connection lifecycle management
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// Global State
// ─────────────────────────────────────────────────────────────────────────────

// SignalWire client instance
let client = null;

// Room session (the active call)
let roomSession = null;

// Current token and destination (fetched dynamically)
let currentToken = null;
let currentDestination = null;

// Connection state
let isConnected = false;


// ─────────────────────────────────────────────────────────────────────────────
// DOM Element References
// ─────────────────────────────────────────────────────────────────────────────

const videoContainer = document.getElementById('video-container');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const statusEl = document.getElementById('status');
const counterValueEl = document.getElementById('counter-value');
const lastGreetingEl = document.getElementById('last-greeting');
const lastEchoEl = document.getElementById('last-echo');
const eventLogEl = document.getElementById('event-log');


// ─────────────────────────────────────────────────────────────────────────────
// Connection Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connect to the SignalWire AI agent.
 *
 * This function:
 * 1. Fetches a token from the backend
 * 2. Initializes the SignalWire client
 * 3. Sets up event listeners
 * 4. Dials the agent
 * 5. Starts the call
 */
async function connect() {
    if (isConnected) {
        logEvent('system', 'Already connected');
        return;
    }

    updateStatus('connecting', 'Getting token...');
    logEvent('system', 'Fetching authentication token...');

    try {
        // ─────────────────────────────────────────────────────────────────────
        // Step 1: Fetch token from backend
        // The /get_token endpoint returns { token, address }
        // ─────────────────────────────────────────────────────────────────────
        const tokenResp = await fetch('/get_token');
        const tokenData = await tokenResp.json();

        if (tokenData.error) {
            throw new Error(tokenData.error);
        }

        currentToken = tokenData.token;
        currentDestination = tokenData.address;

        logEvent('system', `Token received, destination: ${currentDestination}`);
        updateStatus('connecting', 'Initializing client...');

        // ─────────────────────────────────────────────────────────────────────
        // Step 2: Initialize SignalWire client
        // ─────────────────────────────────────────────────────────────────────
        client = await window.SignalWire.SignalWire({
            token: currentToken,
            logLevel: 'debug'  // Set to 'warn' in production
        });

        logEvent('system', 'Client initialized');

        // ─────────────────────────────────────────────────────────────────────
        // Step 3: Set up event listeners on the client
        // We subscribe to user_event using multiple patterns for compatibility
        // ─────────────────────────────────────────────────────────────────────

        // Primary pattern: Direct user_event on client
        client.on('user_event', (params) => {
            console.log('CLIENT EVENT: user_event', params);
            handleUserEvent(params);
        });

        // Alternative pattern: Prefixed event
        client.on('calling.user_event', (params) => {
            console.log('CLIENT EVENT: calling.user_event', params);
            handleUserEvent(params);
        });

        // Fallback pattern: Generic signalwire.event
        client.on('signalwire.event', (params) => {
            console.log('CLIENT EVENT: signalwire.event', params);
            if (params.event_type === 'user_event') {
                handleUserEvent(params.params || params);
            }
        });

        updateStatus('connecting', 'Dialing agent...');

        // ─────────────────────────────────────────────────────────────────────
        // Step 4: Dial the agent
        // ─────────────────────────────────────────────────────────────────────
        roomSession = await client.dial({
            to: currentDestination,
            rootElement: videoContainer,
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: true,
            negotiateVideo: true,
            userVariables: {
                // These variables are passed to the agent
                userName: 'Example User',
                interface: 'web-ui',
                timestamp: new Date().toISOString()
            }
        });

        logEvent('system', 'Call initiated, waiting for connection...');

        // ─────────────────────────────────────────────────────────────────────
        // Step 5: Set up event listeners on the room session
        // ─────────────────────────────────────────────────────────────────────

        // User events from the agent (primary handler)
        roomSession.on('user_event', (params) => {
            console.log('ROOM EVENT: user_event', params);
            handleUserEvent(params);
        });

        // Room state changes
        roomSession.on('room.joined', () => {
            logEvent('system', 'Connected to agent');
            updateStatus('connected', 'Connected');
            isConnected = true;
            updateButtons();

            // Hide placeholder when connected
            const placeholder = videoContainer.querySelector('.placeholder');
            if (placeholder) {
                placeholder.style.display = 'none';
            }
        });

        roomSession.on('room.left', () => {
            logEvent('system', 'Disconnected from agent');
            handleDisconnect();
        });

        roomSession.on('destroy', () => {
            logEvent('system', 'Session destroyed');
            handleDisconnect();
        });

        // ─────────────────────────────────────────────────────────────────────
        // Step 6: Start the call
        // ─────────────────────────────────────────────────────────────────────
        await roomSession.start();

        logEvent('system', 'Call started successfully');

    } catch (error) {
        console.error('Connection error:', error);
        logEvent('error', `Connection failed: ${error.message}`);
        updateStatus('error', 'Connection failed');
        handleDisconnect();
    }
}


/**
 * Disconnect from the agent.
 */
async function disconnect() {
    if (!isConnected && !roomSession) {
        logEvent('system', 'Not connected');
        return;
    }

    logEvent('system', 'Disconnecting...');
    updateStatus('disconnecting', 'Disconnecting...');

    try {
        if (roomSession) {
            await roomSession.hangup();
        }
    } catch (error) {
        console.error('Disconnect error:', error);
    }

    handleDisconnect();
}


/**
 * Clean up after disconnect.
 */
function handleDisconnect() {
    isConnected = false;
    roomSession = null;

    // Clear video container and restore placeholder with image
    videoContainer.innerHTML = '<div class="placeholder"><img src="sigmond_pc.png" alt="Sigmond - Click Connect to start"></div>';

    updateStatus('disconnected', 'Disconnected');
    updateButtons();
}


// ─────────────────────────────────────────────────────────────────────────────
// User Event Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle user events from the agent.
 *
 * User events are sent by the backend via result.swml_user_event()
 * and contain structured data for the frontend to display.
 *
 * Event structure variations (all handled):
 * - { type: "...", data: ... }           Direct format
 * - { event: { type: "...", data: ... }} Wrapped format
 * - { params: { type: "...", data: ... }} Params format
 *
 * @param {Object} params - The event parameters
 */
function handleUserEvent(params) {
    console.log('Processing user event:', params);

    // ─────────────────────────────────────────────────────────────────────────
    // Extract event data (handles multiple formats)
    // The SDK may wrap events differently depending on version/context
    // ─────────────────────────────────────────────────────────────────────────
    let eventData = params;

    // Check for wrapped formats
    if (params && params.params) {
        eventData = params.params;
    }
    if (params && params.event) {
        eventData = params.event;
    }

    // Validate we have event data with a type field (our custom events)
    // Skip SDK internal events that don't have a type
    if (!eventData || typeof eventData.type !== 'string') {
        console.log('Skipping non-application event:', params);
        return;
    }

    // Skip internal SDK event types
    const internalTypes = ['room.joined', 'room.left', 'member.joined', 'member.left', 'playback.started', 'playback.ended'];
    if (internalTypes.includes(eventData.type)) {
        console.log('Skipping internal event type:', eventData.type);
        return;
    }

    const eventType = eventData.type;

    // ─────────────────────────────────────────────────────────────────────────
    // Handle specific event types
    // ─────────────────────────────────────────────────────────────────────────
    switch (eventType) {
        case 'greeting':
            // Update greeting display
            const name = eventData.name || 'Unknown';
            lastGreetingEl.textContent = `Hello, ${name}!`;
            lastGreetingEl.classList.add('highlight');
            setTimeout(() => lastGreetingEl.classList.remove('highlight'), 1000);
            logEvent('greeting', `Greeted: ${name}`);
            break;

        case 'echo':
            // Update echo display
            const message = eventData.message || '';
            lastEchoEl.textContent = `"${message}"`;
            lastEchoEl.classList.add('highlight');
            setTimeout(() => lastEchoEl.classList.remove('highlight'), 1000);
            logEvent('echo', `Echoed: ${message}`);
            break;

        case 'counter_updated':
            // Update counter display
            const count = eventData.count || 0;
            const increment = eventData.increment || 1;
            counterValueEl.textContent = count;
            counterValueEl.classList.add('highlight');
            setTimeout(() => counterValueEl.classList.remove('highlight'), 500);
            logEvent('counter', `Counter: ${count} (+${increment})`);
            break;

        default:
            // Unknown event type - log it for debugging
            console.log('Unknown event type:', eventType, eventData);
            logEvent('unknown', `Unknown event: ${eventType}`);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// UI Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the status display.
 *
 * @param {string} state - One of: 'ready', 'connecting', 'connected', 'disconnecting', 'disconnected', 'error'
 * @param {string} text - Status message to display
 */
function updateStatus(state, text) {
    statusEl.className = `status ${state}`;
    statusEl.querySelector('.status-text').textContent = text;
}


/**
 * Update button states based on connection state.
 */
function updateButtons() {
    connectBtn.disabled = isConnected;
    disconnectBtn.disabled = !isConnected;
}


/**
 * Add an entry to the event log.
 *
 * @param {string} type - Event type for styling: 'system', 'event', 'error', 'greeting', 'echo', 'counter', 'unknown'
 * @param {string} message - Message to display
 */
function logEvent(type, message) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const timestamp = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-time">${timestamp}</span> ${message}`;

    eventLogEl.appendChild(entry);

    // Auto-scroll to bottom
    eventLogEl.scrollTop = eventLogEl.scrollHeight;

    // Keep only last 50 entries
    while (eventLogEl.children.length > 50) {
        eventLogEl.removeChild(eventLogEl.firstChild);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

// Log startup
logEvent('system', 'Application loaded');
logEvent('system', 'Ready to connect to SignalWire AI agent');

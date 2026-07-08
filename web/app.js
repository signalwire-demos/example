/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SignalWire AI Agent Example - Frontend JavaScript
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file demonstrates the complete client-side implementation for connecting
 * to a SignalWire AI agent, handling user events, and updating the UI.
 * Uses @signalwire/js v4.
 *
 * Key patterns demonstrated:
 * 1. Token fetching from /get_token endpoint
 * 2. SignalWire v4 client initialization (StaticCredentialProvider, auto-connect)
 * 3. RxJS observable subscriptions (remoteStream$, status$, user_event)
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

// The active call
let call = null;

// Current token and destination (fetched dynamically)
let currentToken = null;
let currentDestination = null;

// Connection state
let isConnected = false;

// v4: track every RxJS Subscription so teardown can unsubscribe them all
let subscriptions = [];
let remoteVideoEl = null;
let lastRemoteSig = '';
let teardownDone = false;


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
// v4 helpers
// ─────────────────────────────────────────────────────────────────────────────

function track(sub) {
    if (sub) subscriptions.push(sub);
    return sub;
}

function streamSignature(stream) {
    return stream.getTracks().map(t => t.kind + ':' + t.id).sort().join(',');
}

// Hardened token fetch: tolerate the FastAPI tuple-return array shape and
// validate the payload so a bad response fails loudly.
async function fetchGuestToken() {
    const resp = await fetch('/get_token');
    let data = await resp.json();
    if (Array.isArray(data)) data = data[0] || {};
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
    if (!data.token || !data.address) throw new Error('Token response missing token/address');
    return data;
}

// Gate the dial on the client connecting (replays synchronously; never errors
// on bad creds -> needs a timeout).
function waitForConnected(swClient, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let sub = null;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (sub) { try { sub.unsubscribe(); } catch (e) {} }
            reject(new Error('Timed out waiting for SignalWire connection'));
        }, timeoutMs);
        sub = swClient.isConnected$.subscribe(connected => {
            if (connected && !settled) {
                settled = true;
                clearTimeout(timer);
                setTimeout(() => { if (sub) { try { sub.unsubscribe(); } catch (e) {} } }, 0);
                resolve();
            }
        });
    });
}

// Render the remote (avatar) stream ourselves. Leave it UNMUTED (carries the
// remote audio). Re-attach on track-set change.
function attachRemoteStream(stream) {
    if (!stream) return;
    if (!videoContainer) return;

    const placeholder = videoContainer.querySelector('.placeholder');
    if (placeholder) placeholder.style.display = 'none';

    if (!remoteVideoEl) {
        remoteVideoEl = document.createElement('video');
        remoteVideoEl.autoplay = true;
        remoteVideoEl.playsInline = true;
        remoteVideoEl.setAttribute('playsinline', '');
        remoteVideoEl.style.width = '100%';
        remoteVideoEl.style.height = '100%';
        remoteVideoEl.style.objectFit = 'cover';
        videoContainer.appendChild(remoteVideoEl);
    }

    const sig = streamSignature(stream);
    if (sig !== lastRemoteSig) {
        lastRemoteSig = sig;
        remoteVideoEl.srcObject = stream;
        remoteVideoEl.play().catch(e => console.log('Remote video play blocked:', e.message));
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// Connection Functions (v4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connect to the SignalWire AI agent.
 *
 * This function:
 * 1. Fetches a token from the backend
 * 2. Initializes the v4 SignalWire client (auto-connects)
 * 3. Gates on isConnected$, then dials the agent
 * 4. Subscribes to remoteStream$, user_event, and status$
 */
async function connect() {
    if (isConnected) {
        logEvent('system', 'Already connected');
        return;
    }

    // Reset per-connection state
    teardownDone = false;
    subscriptions = [];
    remoteVideoEl = null;
    lastRemoteSig = '';

    updateStatus('connecting', 'Getting token...');
    logEvent('system', 'Fetching authentication token...');

    try {
        // Step 1: Fetch token from backend -> { token, address }
        const tokenData = await fetchGuestToken();
        currentToken = tokenData.token;
        currentDestination = tokenData.address;

        logEvent('system', `Token received, destination: ${currentDestination}`);
        updateStatus('connecting', 'Initializing client...');

        // Step 2: Initialize the v4 client (constructor auto-connects; a guest SAT
        // works as a plain bearer via StaticCredentialProvider).
        const SW = window.SignalWire;
        if (!SW || typeof SW.SignalWire !== 'function') {
            throw new Error('SignalWire v4 SDK not loaded');
        }
        client = new SW.SignalWire(new SW.StaticCredentialProvider({ token: currentToken }));

        // Surface SDK errors/warnings (replaces logLevel: 'debug')
        track(client.errors$.subscribe(e => logEvent('error', `SDK error: ${e && e.message || e}`)));
        track(client.warnings$.subscribe(w => console.warn('SDK warning:', w && w.code, w && w.message)));

        // Step 3: Gate the dial on the client connecting
        await waitForConnected(client, 15000);
        logEvent('system', 'Client initialized');

        updateStatus('connecting', 'Dialing agent...');

        // Step 4: Dial the agent. No vision on this agent -> receive-only avatar
        // video, no camera permission prompt.
        call = await client.dial(currentDestination, {
            audio: true,
            video: false,
            receiveAudio: true,
            receiveVideo: true,
            userVariables: {
                userName: 'Example User',
                interface: 'web-ui-v4'
            }
        });

        logEvent('system', 'Call initiated, waiting for connection...');

        // Step 5: Subscribe to media + events
        track(call.remoteStream$.subscribe(stream => attachRemoteStream(stream)));

        track(call.subscribe('user_event').subscribe(evt => {
            const params = (evt && evt.params) ? evt.params : evt;
            handleUserEvent(params);
        }));

        track(call.status$.subscribe({
            next: (status) => {
                console.log('call.status:', status);
                if (status === 'connected') {
                    onConnected();
                } else if (status === 'disconnected' || status === 'failed' || status === 'destroyed') {
                    logEvent('system', 'Disconnected from agent');
                    handleDisconnect();
                }
            },
            complete: () => handleDisconnect()
        }));

    } catch (error) {
        console.error('Connection error:', error);
        logEvent('error', `Connection failed: ${error.message}`);
        updateStatus('error', 'Connection failed');
        handleDisconnect();
    }
}


/**
 * UI transition once the call reaches 'connected'.
 */
function onConnected() {
    logEvent('system', 'Connected to agent');
    updateStatus('connected', 'Connected');
    isConnected = true;
    updateButtons();

    // Hide placeholder when connected
    const placeholder = videoContainer.querySelector('.placeholder');
    if (placeholder) {
        placeholder.style.display = 'none';
    }
}


/**
 * Disconnect from the agent.
 */
async function disconnect() {
    if (!isConnected && !call) {
        logEvent('system', 'Not connected');
        return;
    }

    logEvent('system', 'Disconnecting...');
    updateStatus('disconnecting', 'Disconnecting...');

    try {
        if (call) {
            await call.hangup();
        }
    } catch (error) {
        console.error('Disconnect error:', error);
    }

    handleDisconnect();
}


/**
 * Clean up after disconnect (deduped; unsubscribes all RxJS subscriptions).
 */
function handleDisconnect() {
    if (teardownDone) return;
    teardownDone = true;

    subscriptions.forEach(s => { try { s.unsubscribe(); } catch (e) {} });
    subscriptions = [];

    if (client) {
        try { client.disconnect(); } catch (e) {}
        client = null;
    }
    call = null;
    isConnected = false;
    remoteVideoEl = null;
    lastRemoteSig = '';

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
// Buttons are wired via inline onclick= in index.html (connect/disconnect are
// module-global functions), so no addEventListener here.

// Log startup
logEvent('system', 'Application loaded');
logEvent('system', 'Ready to connect to SignalWire AI agent');

// EventSource manager for SSE
let eventSource = null;
let subscribers = new Set();
let currentMetrics = null;
let isConnected = false;

export function connectEventSource() {
  // Prevent multiple simultaneous connection attempts
  if (eventSource && (eventSource.readyState === EventSource.CONNECTING || eventSource.readyState === EventSource.OPEN)) {
    console.log('[SSE] Already connected or connecting');
    return;
  }

  const url = `/api/metrics`;

  try {
    console.log('[SSE] Connecting to', url);
    eventSource = new EventSource(url);

    eventSource.onopen = () => {
      isConnected = true;
      console.log('[SSE] Connected');
      notifySubscribers({ type: 'connected' });
    };

    eventSource.onmessage = (event) => {
      try {
        currentMetrics = JSON.parse(event.data);
        notifySubscribers({ type: 'metrics', data: currentMetrics });
      } catch (error) {
        console.error('[SSE] Failed to parse metrics:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('[SSE] Connection error', error);
      isConnected = false;
      notifySubscribers({ type: 'disconnected' });

      // EventSource automatically reconnects, but if it's closed we should clean up
      if (eventSource.readyState === EventSource.CLOSED) {
        eventSource = null;

        // Reconnect if we still have subscribers
        if (subscribers.size > 0) {
          console.log('[SSE] Connection closed, reconnecting in 2s...');
          setTimeout(connectEventSource, 2000);
        }
      }
    };
  } catch (error) {
    console.error('[SSE] Failed to create EventSource:', error);
    if (subscribers.size > 0) {
      setTimeout(connectEventSource, 2000);
    }
  }
}

function notifySubscribers(message) {
  subscribers.forEach(callback => {
    try {
      callback(message);
    } catch (error) {
      console.error('Error in subscriber callback:', error);
    }
  });
}

export function subscribe(callback) {
  subscribers.add(callback);

  // If we're already connected, send current state immediately
  if (isConnected) {
    callback({ type: 'connected' });
    if (currentMetrics) {
      callback({ type: 'metrics', data: currentMetrics });
    }
  } else if (subscribers.size === 1) {
    // First subscriber, establish connection
    connectEventSource();
  }

  // Return unsubscribe function
  return () => {
    subscribers.delete(callback);

    // If no more subscribers, close the connection
    if (subscribers.size === 0) {
      if (eventSource) {
        console.log('[SSE] Closing connection (no subscribers)');
        eventSource.close();
        eventSource = null;
      }
      isConnected = false;
    }
  };
}

export function getCurrentMetrics() {
  return currentMetrics;
}

export function isWebSocketConnected() {
  return isConnected;
}

// Vite HMR support - EventSource handles reconnection automatically
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    console.log('[SSE] HMR update, preserving connection');
  });
}

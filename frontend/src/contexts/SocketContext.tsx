// Shared Socket.IO connection for the app. Backend emits:
//   - 'process_status_change' { id: string, state: string, ... }
//   - 'pipeline_update' { processes: PipelineProcess[] }
//   - 'connected' { status: 'ok' }
//
// Components that need live updates should call useSocketEvent(evt, handler)
// or useSocket() for the raw socket.

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

// Match the api.ts URL derivation but strip /api and use socket.io path.
// Under OOD (/pun/sys/<app>/ or /rnode/<host>/<port>/) the socket path
// must be prefixed with the same segment so Apache's reverse proxy routes it.
function getSocketConfig(): { url: string; path: string } {
  const pathname = window.location.pathname;

  const oodMatch = pathname.match(/^(\/pun\/sys\/[^/]+)/);
  if (oodMatch) {
    return { url: window.location.origin, path: `${oodMatch[1]}/socket.io` };
  }

  const nodeMatch = pathname.match(/^(\/(?:rnode|node)\/[^/]+\/\d+)/);
  if (nodeMatch) {
    return { url: window.location.origin, path: `${nodeMatch[1]}/socket.io` };
  }

  // Local dev: same origin, default socket.io path
  return { url: window.location.origin, path: '/socket.io' };
}

interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketContextValue>({ socket: null, connected: false });

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const { url, path } = getSocketConfig();
    const s = io(url, {
      path,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = s;

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));

    return () => {
      s.removeAllListeners();
      s.disconnect();
      socketRef.current = null;
    };
  }, []);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, connected }}>
      {children}
    </SocketContext.Provider>
  );
};

/** Access the shared socket. Returns null until the first connect. */
export const useSocket = (): SocketContextValue => useContext(SocketContext);

/**
 * Subscribe to a specific server event for the lifetime of the calling component.
 * Handler is re-bound whenever it changes; unsubscribes cleanly on unmount.
 */
export function useSocketEvent<T = any>(event: string, handler: (payload: T) => void) {
  const { socket } = useSocket();
  useEffect(() => {
    if (!socket) return;
    socket.on(event, handler);
    return () => {
      socket.off(event, handler);
    };
  }, [socket, event, handler]);
}

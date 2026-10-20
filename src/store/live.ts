import { create } from 'zustand';
import type { LiveSnapshot } from '../../shared/types';
import { api, ensureSession, isDesktopRuntime, liveSocketUrl } from '../api';

interface LiveState {
  snapshot: LiveSnapshot | null;
  socketConnected: boolean;
  paused: boolean;
  pausedAt: number | null;
  pendingSnapshot: LiveSnapshot | null;
  pausedUpdates: number;
  lastMessageAt: number;
  connect: () => void;
  setPaused: (paused: boolean) => void;
}

let socket: WebSocket | null = null;
let started = false;
let retryTimer: number | null = null;
let desktopPollTimer: number | null = null;

function applySnapshot(snapshot: LiveSnapshot): void {
  const state = useLive.getState();
  if (state.paused) {
    useLive.setState({
      pendingSnapshot: snapshot,
      pausedUpdates: state.pausedUpdates + 1,
      lastMessageAt: Date.now(),
    });
  } else {
    useLive.setState({ snapshot, lastMessageAt: Date.now() });
  }
}

async function pollDesktop(): Promise<void> {
  try {
    const snapshot = await api<LiveSnapshot>('/api/live');
    useLive.setState({ socketConnected: true });
    applySnapshot(snapshot);
  } catch {
    useLive.setState({ socketConnected: false });
  }
}

function startDesktopPolling(): void {
  if (desktopPollTimer !== null) return;
  void pollDesktop();
  desktopPollTimer = window.setInterval(() => void pollDesktop(), 1000);
}

function openSocket(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  try {
    socket = new WebSocket(liveSocketUrl());
  } catch {
    scheduleRetry();
    return;
  }
  socket.onopen = () => {
    useLive.setState({ socketConnected: true });
  };
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data) as { type?: string; data?: LiveSnapshot };
      if (message.type !== 'live' || !message.data) return;
      applySnapshot(message.data);
    } catch {
      // 忽略无法解析的推送
    }
  };
  socket.onclose = () => {
    useLive.setState({ socketConnected: false });
    socket = null;
    scheduleRetry();
  };
  socket.onerror = () => {
    socket?.close();
  };
}

function scheduleRetry(): void {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void ensureSession()
      .catch(() => {})
      .finally(() => openSocket());
  }, 2000);
}

export const useLive = create<LiveState>((set, get) => ({
  snapshot: null,
  socketConnected: false,
  paused: false,
  pausedAt: null,
  pendingSnapshot: null,
  pausedUpdates: 0,
  lastMessageAt: 0,
  connect: () => {
    if (started) return;
    started = true;
    if (isDesktopRuntime()) {
      startDesktopPolling();
      return;
    }
    openSocket();
  },
  setPaused: (paused) => {
    if (paused) {
      const state = get();
      set({
        paused: true,
        pausedAt: Date.now(),
        pendingSnapshot: state.snapshot,
        pausedUpdates: 0,
      });
      return;
    }
    const state = get();
    set({
      paused: false,
      pausedAt: null,
      snapshot: state.pendingSnapshot ?? state.snapshot,
      pendingSnapshot: null,
      pausedUpdates: 0,
    });
  },
}));

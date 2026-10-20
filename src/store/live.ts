import { create } from 'zustand';
import type { LiveSnapshot } from '../../shared/types';
import { ensureSession, liveSocketUrl } from '../api';

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
      const state = useLive.getState();
      if (state.paused) {
        useLive.setState({
          pendingSnapshot: message.data,
          pausedUpdates: state.pausedUpdates + 1,
          lastMessageAt: Date.now(),
        });
      } else {
        useLive.setState({ snapshot: message.data, lastMessageAt: Date.now() });
      }
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

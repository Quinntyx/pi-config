/**
 * ipc.ts — UNIX domain socket IPC for autopilot.
 *
 * Primary process runs an AutopilotServer that:
 *   - broadcasts monotonic-sequence agent_start / agent_settled events to the
 *     connected Pilot client, and
 *   - receives start_turn_ok requests from the Pilot and exposes a one-shot
 *     turn-allowance token to the Primary's input gate.
 *
 * Pilot process runs an AutopilotClient that:
 *   - connects to the socket, parses the newline-delimited JSON stream,
 *   - tracks the highest seq seen, and
 *   - offers waitForEvent(type, predicate, timeout) for tmux_start_turn's
 *     two-phase correlation, plus send() to push start_turn_ok.
 *
 * Wire format: one JSON object per line, UTF-8, \n-terminated.
 *   { "type": "agent_start" | "agent_settled", "seq": <number>, "ts": <number> }
 *   { "type": "start_turn_ok", "ts": <number> }
 *
 * See ARCHITECTURE.md §3, §5.
 */

import { createServer, type Server, type Socket } from "node:net";
import { connect } from "node:net";
import { unlinkSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Shared wire types
// ---------------------------------------------------------------------------

export type BroadcastEventType = "agent_start" | "agent_settled";
export type RequestEventType = "start_turn_ok";

export interface BroadcastEvent {
  type: BroadcastEventType;
  seq: number;
  ts: number;
}
export interface RequestEvent {
  type: RequestEventType;
  ts: number;
}
export type WireEvent = BroadcastEvent | RequestEvent;

/** Parse one line of the wire stream. Returns null for blank/garbage lines. */
function parseLine(line: string): WireEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as WireEvent;
  } catch {
    return null;
  }
}

/** Serialize an event for the wire (no trailing newline). */
function serialize(ev: WireEvent): string {
  return JSON.stringify(ev);
}

// ---------------------------------------------------------------------------
// AutopilotServer (Primary side)
// ---------------------------------------------------------------------------

/** Listener invoked when the Pilot requests start_turn_ok. */
export type StartTurnOkListener = () => void;

export class AutopilotServer {
  private server: Server | null = null;
  private client: Socket | null = null;
  private seq = 0;
  private readonly startTurnOkListeners = new Set<StartTurnOkListener>();

  /** Start listening on `sockPath`. Unlinks any stale socket first. */
  start(sockPath: string): void {
    if (this.server) return;
    // Defensive: clear a stale socket from a crashed previous Primary.
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch {
      // ignore — bind() will surface a real error if the path is unusable
    }
    const server = createServer((socket) => {
      // Single-client protocol: keep the most recent connection.
      if (this.client) {
        try { this.client.destroy(); } catch { /* best-effort */ }
      }
      this.client = socket;
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const ev = parseLine(line);
          if (ev && ev.type === "start_turn_ok") {
            this.fireStartTurnOk();
          }
        }
      });
      socket.on("error", () => { /* client dropped; await reconnect */ });
      socket.on("close", () => {
        if (this.client === socket) this.client = null;
      });
    });
    server.on("error", () => { /* surfaced via listen callback semantics */ });
    server.listen(sockPath);
    this.server = server;
  }

  /** Broadcast an agent_start / agent_settled event with a fresh seq. */
  broadcast(type: BroadcastEventType): void {
    this.seq += 1;
    const ev: BroadcastEvent = { type, seq: this.seq, ts: Date.now() };
    const line = serialize(ev) + "\n";
    if (this.client) {
      try { this.client.write(line); } catch { /* client gone; drop event */ }
    }
  }

  /** Register a listener for Pilot start_turn_ok requests. Returns an unsubscribe. */
  onStartTurnOk(listener: StartTurnOkListener): () => void {
    this.startTurnOkListeners.add(listener);
    return () => { this.startTurnOkListeners.delete(listener); };
  }

  private fireStartTurnOk(): void {
    for (const l of this.startTurnOkListeners) {
      try { l(); } catch { /* listener errors must not break the server */ }
    }
  }

  /** Stop the server and remove the socket file. Safe to call repeatedly. */
  close(sockPath?: string): void {
    if (this.client) {
      try { this.client.destroy(); } catch { /* best-effort */ }
      this.client = null;
    }
    if (this.server) {
      try { this.server.close(); } catch { /* best-effort */ }
      this.server = null;
    }
    if (sockPath) {
      try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* best-effort */ }
    }
    this.startTurnOkListeners.clear();
  }
}

// ---------------------------------------------------------------------------
// AutopilotClient (Pilot side)
// ---------------------------------------------------------------------------

export interface WaitForOptions {
  /** Timeout in milliseconds. Rejects with a TimeoutError on expiry. */
  timeoutMs: number;
  /** Optional abort signal to cancel the wait early. */
  signal?: AbortSignal;
}

/** Error thrown when waitForEvent times out. */
export class WaitForTimeoutError extends Error {
  constructor(public readonly eventType: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for ${eventType}`);
    this.name = "WaitForTimeoutError";
  }
}

/** Error thrown when the client disconnects while waiting. */
export class ClientClosedError extends Error {
  constructor(public readonly eventType: string) {
    super(`IPC client closed while waiting for ${eventType}`);
    this.name = "ClientClosedError";
  }
}

export class AutopilotClient {
  private socket: Socket | null = null;
  private lastSeq = 0;
  private closed = false;
  private pendingBuf = "";
  /** Listeners keyed by event type, each with a predicate filter. */
  private readonly waiters = new Map<
    string,
    Array<{ predicate: (e: BroadcastEvent) => boolean; resolve: (e: BroadcastEvent) => void; reject: (e: Error) => void }>
  >();

  /** Highest seq observed from the server so far. */
  get lastObservedSeq(): number {
    return this.lastSeq;
  }

  /** Connect to the server at `sockPath`. Resolves once connected. */
  connect(sockPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) return resolve();
      const socket = connect(sockPath, () => resolve());
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        this.pendingBuf += chunk;
        let nl: number;
        while ((nl = this.pendingBuf.indexOf("\n")) !== -1) {
          const line = this.pendingBuf.slice(0, nl);
          this.pendingBuf = this.pendingBuf.slice(nl + 1);
          this.handleLine(line);
        }
      });
      socket.on("error", (err) => {
        if (!this.socket) reject(err);
        this.failWaiters(new ClientClosedError("(connect error)"));
      });
      socket.on("close", () => {
        this.failWaiters(new ClientClosedError("(any)"));
        if (!this.closed) this.closed = true;
      });
      this.socket = socket;
    });
  }

  private handleLine(line: string): void {
    const ev = parseLine(line);
    if (!ev) return;
    if (ev.type === "start_turn_ok") return; // Pilot never receives these
    // BroadcastEvent
    if (ev.seq > this.lastSeq) this.lastSeq = ev.seq;
    const list = this.waiters.get(ev.type);
    if (!list || list.length === 0) return;
    // Resolve all waiters whose predicate matches; remove them.
    const remaining: typeof list = [];
    for (const w of list) {
      try {
        if (w.predicate(ev)) {
          w.resolve(ev);
        } else {
          remaining.push(w);
        }
      } catch {
        remaining.push(w);
      }
    }
    if (remaining.length) this.waiters.set(ev.type, remaining);
    else this.waiters.delete(ev.type);
  }

  private failWaiters(err: Error): void {
    for (const [, list] of this.waiters) {
      for (const w of list) {
        try { w.reject(err); } catch { /* best-effort */ }
      }
    }
    this.waiters.clear();
  }

  /**
   * Wait for a broadcast event of `type` matching `predicate`.
   * Only events with seq > the predicate-relevant baseline should match;
   * callers encode that in the predicate (e.g. (e) => e.seq > beforeSeq).
   */
  waitForEvent(
    type: BroadcastEventType,
    predicate: (e: BroadcastEvent) => boolean,
    opts: WaitForOptions,
  ): Promise<BroadcastEvent> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.closed) {
        return reject(new ClientClosedError(type));
      }
      const entry = { predicate, resolve, reject };
      const list = this.waiters.get(type) ?? [];
      list.push(entry);
      this.waiters.set(type, list);

      const timer = setTimeout(() => {
        // Remove this waiter and reject.
        const cur = this.waiters.get(type) ?? [];
        const next = cur.filter((w) => w !== entry);
        if (next.length) this.waiters.set(type, next);
        else this.waiters.delete(type);
        reject(new WaitForTimeoutError(type, opts.timeoutMs));
      }, opts.timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        const cur = this.waiters.get(type) ?? [];
        const next = cur.filter((w) => w !== entry);
        if (next.length) this.waiters.set(type, next);
        else this.waiters.delete(type);
        reject(new ClientClosedError(type));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      // Clear the timeout when resolved/rejected via the waiter path.
      const origResolve = entry.resolve;
      const origReject = entry.reject;
      entry.resolve = (e) => { clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener("abort", onAbort); origResolve(e); };
      entry.reject = (e) => { clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener("abort", onAbort); origReject(e); };
    });
  }

  /** Send a request event (e.g. start_turn_ok) to the server. */
  send(ev: RequestEvent): void {
    if (!this.socket) throw new Error("IPC client not connected");
    this.socket.write(serialize(ev) + "\n");
  }

  /** Close the client. Safe to call repeatedly. */
  close(): void {
    this.closed = true;
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* best-effort */ }
      this.socket = null;
    }
    this.failWaiters(new ClientClosedError("(close)"));
  }
}
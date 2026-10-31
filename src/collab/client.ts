import type { Vec } from '../core/geometry';
import { Molecule } from '../core/molecule';
import { applyPatch, diffMolecules, isEmptyPatch, type Patch } from '../core/patch';
import type { ClientMessage, PeerInfo, ServerMessage } from './protocol';

export type CollabStatus = 'connecting' | 'live' | 'offline';

export interface CollabHooks {
  /** The drawing was rebuilt with other people's changes. */
  onRemoteChange(): void;
  onPeers(peers: PeerInfo[]): void;
  onStatus(status: CollabStatus): void;
  /** The server turned down one of our changes (it has been taken back). */
  onReject(reason: string): void;
  /** Whether the drawing may be rebuilt now; not in the middle of a gesture. */
  canRebuild(): boolean;
  onJoin?(peer: PeerInfo): void;
  onLeave?(peer: PeerInfo): void;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Keeps one shared drawing in step with its room on the server.
 *
 * The drawing on screen is always the server's copy with our own unconfirmed
 * changes replayed on top. When someone else's change arrives it goes into
 * the server's copy and ours are replayed again, so every browser applies
 * every change in the server's order and they all end up with the same
 * drawing. Changes made while offline wait and go when the connection
 * comes back.
 */
export class Collab {
  status: CollabStatus = 'connecting';
  me: PeerInfo | null = null;
  readonly peers = new Map<string, PeerInfo>();
  private ws: WebSocket | null = null;
  private readonly server = new Molecule();
  private pending: { seq: number; patch: Patch }[] = [];
  private seq = 0;
  private attempts = 0;
  /** Changes from others not yet shown, waiting for a pause in our own gestures. */
  private stale = false;
  private closed = false;
  private retry: Timer | null = null;
  private presenceTimer: Timer | null = null;
  private presenceSent = 0;
  private presenceNext: { cursor: [number, number] | null; selection: number[] } = { cursor: null, selection: [] };

  constructor(
    readonly room: string,
    private readonly mol: Molecule,
    private readonly hooks: CollabHooks,
    private name: string,
    private readonly endpoint: string,
  ) {
    this.connect();
  }

  /** Our changes the server hasn't confirmed yet. */
  get unconfirmed(): number {
    return this.pending.length;
  }

  /** Share a change that has already been made to the drawing. */
  send(patch: Patch): void {
    if (isEmptyPatch(patch)) return;
    const seq = ++this.seq;
    this.pending.push({ seq, patch });
    this.raw({ t: 'patch', seq, patch });
  }

  /** Where our pointer is (model space) and what we have selected; sent at most 20 times a second. */
  presence(cursor: Vec | null, selection: Iterable<number>): void {
    const round = (v: number) => Math.round(v * 1000) / 1000;
    this.presenceNext = { cursor: cursor ? [round(cursor.x), round(cursor.y)] : null, selection: [...selection] };
    if (this.presenceTimer) return;
    const wait = Math.max(0, 50 - (Date.now() - this.presenceSent));
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.presenceSent = Date.now();
      this.raw({ t: 'presence', ...this.presenceNext });
    }, wait);
  }

  rename(name: string): void {
    this.name = name;
    if (this.me) this.me.name = name;
    this.raw({ t: 'name', name });
  }

  /** Show other people's changes, unless a gesture is under way (then this waits to be called again). */
  settle(): void {
    if (!this.stale || !this.hooks.canRebuild()) return;
    this.stale = false;
    const view = Molecule.fromJSON(this.server.toJSON());
    for (const p of this.pending) applyPatch(view, p.patch);
    this.mol.load(view.toJSON());
    this.hooks.onRemoteChange();
  }

  leave(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.ws?.close();
    this.ws = null;
    this.peers.clear();
  }

  private connect(): void {
    this.setStatus('connecting');
    const ws = new WebSocket(`${this.endpoint}?room=${encodeURIComponent(this.room)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.raw({ t: 'hello', name: this.name });
    };
    ws.onmessage = (e) => {
      try {
        this.receive(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // Ignore anything unreadable.
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      this.peers.clear();
      this.hooks.onPeers([]);
      this.setStatus('offline');
      this.retry = setTimeout(() => this.connect(), Math.min(15000, 500 * 2 ** this.attempts++));
    };
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        this.me = msg.you;
        this.server.load(msg.doc);
        this.peers.clear();
        for (const p of msg.peers) this.peers.set(p.id, p);
        // Send again whatever wasn't confirmed before (applying a change twice
        // is harmless). In a room with nothing in it yet (a new one, or one
        // the server lost in a restart), what's on screen becomes its drawing.
        const unsent = this.pending.map((p) => p.patch);
        this.pending = [];
        if (this.server.isEmpty && !unsent.length && !this.mol.isEmpty) unsent.push(diffMolecules(this.server.toJSON(), this.mol.toJSON()));
        for (const patch of unsent) this.send(patch);
        this.stale = true;
        this.settle();
        this.setStatus('live');
        this.hooks.onPeers(this.list());
        return;
      }
      case 'patch':
        applyPatch(this.server, msg.patch);
        this.stale = true;
        this.settle();
        return;
      case 'ack': {
        const i = this.pending.findIndex((p) => p.seq === msg.seq);
        if (i < 0) return;
        applyPatch(this.server, this.pending[i].patch);
        this.pending.splice(i, 1);
        return;
      }
      case 'reject': {
        this.pending = this.pending.filter((p) => p.seq !== msg.seq);
        this.stale = true;
        this.settle();
        this.hooks.onReject(msg.reason);
        return;
      }
      case 'join':
        this.peers.set(msg.peer.id, msg.peer);
        this.hooks.onJoin?.(msg.peer);
        break;
      case 'leave': {
        const peer = this.peers.get(msg.id);
        this.peers.delete(msg.id);
        if (peer) this.hooks.onLeave?.(peer);
        break;
      }
      case 'presence': {
        const peer = this.peers.get(msg.id);
        if (!peer) return;
        peer.cursor = msg.cursor;
        peer.selection = msg.selection;
        break;
      }
      case 'name': {
        const peer = this.peers.get(msg.id);
        if (peer) peer.name = msg.name;
        break;
      }
    }
    this.hooks.onPeers(this.list());
  }

  private list(): PeerInfo[] {
    return [...this.peers.values()];
  }

  private raw(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setStatus(status: CollabStatus): void {
    if (status === this.status && status !== 'connecting') return;
    this.status = status;
    this.hooks.onStatus(status);
  }
}

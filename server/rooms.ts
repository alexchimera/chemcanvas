import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { Molecule, type MoleculeData } from '../src/core/molecule';
import { applyPatch, parsePatch } from '../src/core/patch';
import {
  cleanName,
  COLLAB_PATH,
  PEER_COLORS,
  ROOM_PATTERN,
  type ClientMessage,
  type PeerInfo,
  type ServerMessage,
} from '../src/collab/protocol';

const LIMITS = { atoms: 10000, bonds: 12000, peers: 40, rooms: 5000, payload: 4 * 1024 * 1024, selection: 4000 };
const IDLE_MS = 24 * 60 * 60 * 1000;

interface Client extends PeerInfo {
  ws: WebSocket;
  alive: boolean;
  /** Set by the client's hello; nothing is sent to it before that. */
  ready: boolean;
}

/** One shared drawing and the people looking at it. */
class Room {
  readonly doc = new Molecule();
  readonly clients = new Set<Client>();
  lastUsed = Date.now();
  dirty = false;

  constructor(readonly code: string) {}

  send(to: Client, msg: ServerMessage): void {
    if (to.ws.readyState === to.ws.OPEN) to.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage, except?: Client): void {
    const text = JSON.stringify(msg);
    for (const c of this.clients) if (c !== except && c.ready && c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  }

  peers(except?: Client): PeerInfo[] {
    return [...this.clients].filter((c) => c !== except && c.ready).map(info);
  }
}

const info = (c: Client): PeerInfo => ({ id: c.id, name: c.name, color: c.color, cursor: c.cursor, selection: c.selection });

export interface RoomServer {
  /** Number of rooms held in memory (for tests and logs). */
  readonly size: number;
  close(): void;
}

/**
 * Host shared drawings on an HTTP server: WebSocket upgrades to /collab join
 * a room; anything else (Vite's own hot-reload socket, say) is left alone.
 * With `dataDir`, rooms are saved there and survive restarts.
 */
export function attachRooms(server: Server, opts: { dataDir?: string; log?: (msg: string) => void } = {}): RoomServer {
  const log = opts.log ?? (() => {});
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.payload });
  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });

  const roomFor = (code: string): Room | null => {
    let room = rooms.get(code);
    if (room) return room;
    if (rooms.size >= LIMITS.rooms) return null;
    room = new Room(code);
    if (opts.dataDir) {
      try {
        room.doc.load(JSON.parse(readFileSync(join(opts.dataDir, `${code}.json`), 'utf8')) as MoleculeData);
      } catch {
        // A new room, or nothing saved yet.
      }
    }
    rooms.set(code, room);
    return room;
  };

  const save = (room: Room) => {
    if (!opts.dataDir || !room.dirty) return;
    room.dirty = false;
    const file = join(opts.dataDir, `${room.code}.json`);
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(room.doc.toJSON()));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      log(`could not save room ${room.code}: ${String(err)}`);
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== COLLAB_PATH) return;
    const code = url.searchParams.get('room') ?? '';
    const room = ROOM_PATTERN.test(code) ? roomFor(code) : null;
    if (!room || room.clients.size >= LIMITS.peers) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => admit(room, ws));
  };
  server.on('upgrade', onUpgrade);

  function admit(room: Room, ws: WebSocket): void {
    const used = new Set([...room.clients].map((c) => c.color));
    const client: Client = {
      ws,
      id: crypto.randomUUID().slice(0, 8),
      name: 'Guest',
      color: PEER_COLORS.find((c) => !used.has(c)) ?? PEER_COLORS[room.clients.size % PEER_COLORS.length],
      cursor: null,
      selection: [],
      alive: true,
      ready: false,
    };
    room.clients.add(client);
    room.lastUsed = Date.now();
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data) => handle(room, client, data));
    ws.on('close', () => {
      room.clients.delete(client);
      room.lastUsed = Date.now();
      if (client.ready) room.broadcast({ t: 'leave', id: client.id });
      save(room);
    });
    ws.on('error', () => ws.terminate());
  }

  function handle(room: Room, client: Client, data: RawData): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }
    room.lastUsed = Date.now();
    switch (msg?.t) {
      case 'hello':
        if (client.ready) return;
        client.name = cleanName(msg.name) || 'Guest';
        client.ready = true;
        room.send(client, { t: 'welcome', you: info(client), doc: room.doc.toJSON(), peers: room.peers(client) });
        room.broadcast({ t: 'join', peer: info(client) }, client);
        return;
      case 'name':
        client.name = cleanName(msg.name) || client.name;
        room.broadcast({ t: 'name', id: client.id, name: client.name }, client);
        return;
      case 'presence':
        client.cursor =
          Array.isArray(msg.cursor) && msg.cursor.length === 2 && msg.cursor.every((v) => Number.isFinite(v)) ? [msg.cursor[0], msg.cursor[1]] : null;
        client.selection = Array.isArray(msg.selection) ? msg.selection.filter((id) => Number.isSafeInteger(id)).slice(0, LIMITS.selection) : [];
        room.broadcast({ t: 'presence', id: client.id, cursor: client.cursor, selection: client.selection }, client);
        return;
      case 'patch': {
        if (!client.ready || !Number.isSafeInteger(msg.seq)) return;
        const patch = parsePatch(msg.patch);
        if (!patch) {
          room.send(client, { t: 'reject', seq: msg.seq, reason: 'That change could not be read.' });
          return;
        }
        const added = (list: { before: unknown; after: unknown }[]) => list.filter((c) => c.after && !c.before).length;
        if (room.doc.atoms.size + added(patch.atoms) > LIMITS.atoms || room.doc.bonds.size + added(patch.bonds) > LIMITS.bonds) {
          room.send(client, { t: 'reject', seq: msg.seq, reason: 'This drawing has reached its size limit.' });
          return;
        }
        applyPatch(room.doc, patch);
        room.dirty = true;
        room.send(client, { t: 'ack', seq: msg.seq });
        room.broadcast({ t: 'patch', from: client.id, patch }, client);
        return;
      }
    }
  }

  // Drop connections that stopped answering, save changed rooms, and forget
  // rooms nobody has used for a day.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const c of room.clients) {
        if (!c.alive) c.ws.terminate();
        else {
          c.alive = false;
          c.ws.ping();
        }
      }
      save(room);
      if (room.clients.size === 0 && now - room.lastUsed > IDLE_MS) rooms.delete(room.code);
    }
  }, 25000);
  timer.unref();

  return {
    get size() {
      return rooms.size;
    },
    close() {
      clearInterval(timer);
      server.off('upgrade', onUpgrade);
      for (const room of rooms.values()) {
        for (const c of room.clients) c.ws.terminate();
        save(room);
      }
      wss.close();
    },
  };
}

// Shared drawings end to end: a real room server and several clients over
// real WebSockets, each with its own copy of the drawing.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { attachRooms, type RoomServer } from '../server/rooms';
import { Collab } from '../src/collab/client';
import { taggedIds, type PeerInfo } from '../src/collab/protocol';
import { Molecule } from '../src/core/molecule';
import { applyPatch, diffMolecules, invertPatch, type Patch } from '../src/core/patch';
import { aspirin } from '../src/example';
import { toSmiles } from '../src/io/smiles';

let server: Server;
let rooms: RoomServer;
let endpoint: string;
const open: Collab[] = [];

beforeAll(async () => {
  server = createServer();
  rooms = attachRooms(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
});

afterEach(() => {
  for (const c of open.splice(0)) c.leave();
});

afterAll(() => {
  rooms.close();
  server.close();
});

/** A stand-in for one browser: a drawing kept in step with a room. */
function join(room: string, name: string, start = new Molecule()) {
  const mol = start;
  mol.idSource = taggedIds();
  const seen = { peers: [] as PeerInfo[], rejected: '' };
  const collab = new Collab(
    room,
    mol,
    {
      onRemoteChange: () => {},
      onPeers: (peers) => (seen.peers = peers),
      onStatus: () => {},
      onReject: (reason) => (seen.rejected = reason),
      canRebuild: () => true,
    },
    name,
    endpoint,
  );
  open.push(collab);
  /** Change the drawing and share the change, as the app does on every edit. */
  const edit = (fn: (m: Molecule) => void): Patch => {
    const before = mol.toJSON();
    fn(mol);
    const patch = diffMolecules(before, mol.toJSON());
    collab.send(patch);
    return patch;
  };
  const settled = () => collab.status === 'live' && collab.unconfirmed === 0;
  return { mol, collab, seen, edit, settled };
}

async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const newRoom = () => `t${Math.random().toString(36).slice(2, 10)}`;
const snapshot = (m: Molecule) => {
  const d = m.toJSON();
  return JSON.stringify({ atoms: d.atoms.sort((a, b) => a.id - b.id), bonds: d.bonds.sort((a, b) => a.id - b.id) });
};

describe('shared drawings', () => {
  it('a new room takes the first drawing in it, and the next person sees it', async () => {
    const room = newRoom();
    const ann = join(room, 'Ann', aspirin());
    await until(ann.settled, 'Ann to fill the room');
    const ben = join(room, 'Ben');
    await until(() => ben.mol.atoms.size === 13, 'Ben to get the drawing');
    expect(toSmiles(ben.mol)).toBe(toSmiles(ann.mol));
    await until(() => ann.seen.peers.some((p) => p.name === 'Ben'), 'Ann to see Ben');
    expect(ben.seen.peers.map((p) => p.name)).toEqual(['Ann']);
  });

  it('changes go both ways', async () => {
    const room = newRoom();
    const ann = join(room, 'Ann', aspirin());
    await until(ann.settled, 'Ann');
    const ben = join(room, 'Ben');
    await until(() => ben.mol.atoms.size === 13, 'Ben');
    ann.edit((m) => m.addAtom({ x: 4, y: 4 }, 'Cl'));
    await until(() => ben.mol.atoms.size === 14, 'Ben to see the chlorine');
    const target = [...ben.mol.atoms.keys()][0];
    ben.edit((m) => m.updateAtom(target, { element: 'N' }));
    await until(() => ann.mol.atoms.get(target)?.element === 'N', 'Ann to see the nitrogen');
    expect(snapshot(ann.mol)).toBe(snapshot(ben.mol));
  });

  it('two people changing the same atom at once end up with the same drawing', async () => {
    const room = newRoom();
    const ann = join(room, 'Ann', aspirin());
    await until(ann.settled, 'Ann');
    const ben = join(room, 'Ben');
    await until(() => ben.mol.atoms.size === 13 && ben.settled(), 'Ben');
    const target = [...ann.mol.atoms.keys()][2];
    ann.edit((m) => m.updateAtom(target, { element: 'N' }));
    ben.edit((m) => m.updateAtom(target, { element: 'S' }));
    await until(() => ann.settled() && ben.settled() && snapshot(ann.mol) === snapshot(ben.mol), 'the two copies to agree');
    expect(['N', 'S']).toContain(ann.mol.atoms.get(target)!.element);
  });

  it('atoms added by different people at once never clash', async () => {
    const room = newRoom();
    const ann = join(room, 'Ann', aspirin());
    await until(ann.settled, 'Ann');
    const ben = join(room, 'Ben');
    await until(() => ben.mol.atoms.size === 13 && ben.settled(), 'Ben');
    for (let k = 0; k < 20; k++) {
      ann.edit((m) => m.addAtom({ x: k, y: 10 }));
      ben.edit((m) => m.addAtom({ x: k, y: 12 }));
    }
    await until(() => ann.settled() && ben.settled() && ann.mol.atoms.size === 53 && ben.mol.atoms.size === 53, 'all 40 atoms everywhere');
    expect(snapshot(ann.mol)).toBe(snapshot(ben.mol));
  });

  it('undo takes back only your own change', async () => {
    const room = newRoom();
    const ann = join(room, 'Ann', aspirin());
    await until(ann.settled, 'Ann');
    const ben = join(room, 'Ben');
    await until(() => ben.mol.atoms.size === 13, 'Ben');
    const mine = ann.edit((m) => m.addAtom({ x: 6, y: 0 }, 'Br'));
    ben.edit((m) => m.addAtom({ x: -6, y: 0 }, 'I'));
    await until(() => ann.mol.atoms.size === 15 && ben.mol.atoms.size === 15, 'both atoms everywhere');
    // Ann undoes, as the app does: apply her patch backwards, guarded, and share what took.
    ann.collab.send(applyPatch(ann.mol, invertPatch(mine), true));
    await until(() => ben.mol.atoms.size === 14, 'Ben to lose the bromine');
    const elements = (m: Molecule) => [...m.atoms.values()].map((a) => a.element);
    expect(elements(ben.mol)).toContain('I');
    expect(elements(ben.mol)).not.toContain('Br');
    expect(snapshot(ann.mol)).toBe(snapshot(ben.mol));
  });

  it('changes made while offline go when the connection comes back', async () => {
    const room = newRoom();
    const ann = join(room, 'Ann', aspirin());
    await until(ann.settled, 'Ann');
    const ben = join(room, 'Ben');
    await until(() => ben.mol.atoms.size === 13, 'Ben');
    (ann.collab as unknown as { ws: WebSocket }).ws.close();
    await until(() => ann.collab.status === 'offline', 'Ann to drop');
    ann.edit((m) => m.addAtom({ x: 2, y: 8 }, 'F'));
    expect(ann.collab.unconfirmed).toBe(1);
    await until(() => ben.mol.atoms.size === 14, 'Ben to get the fluorine after Ann reconnects');
    await until(ann.settled, 'Ann to be confirmed');
    expect(snapshot(ann.mol)).toBe(snapshot(ben.mol));
  });

  it('the server turns down a malformed change and the sender takes it back', async () => {
    const room = newRoom();
    const ann = join(room, 'Ann', aspirin());
    await until(ann.settled, 'Ann');
    ann.collab.send({ atoms: [{ id: 5, before: null, after: { id: 5, x: 0, y: 0, element: 'Nope', charge: 0 } }], bonds: [] });
    await until(() => ann.seen.rejected !== '', 'the rejection');
    expect(ann.collab.unconfirmed).toBe(0);
    expect(ann.mol.atoms.size).toBe(13);
  });

  it('shares pointers, selections and names', async () => {
    const room = newRoom();
    const ann = join(room, 'Ann', aspirin());
    await until(ann.settled, 'Ann');
    const ben = join(room, 'Ben');
    await until(() => ben.seen.peers.length === 1, 'Ben to see Ann');
    const id = [...ann.mol.atoms.keys()][0];
    ann.collab.presence({ x: 1.23456, y: -2 }, [id]);
    await until(() => ben.seen.peers[0]?.cursor?.[0] === 1.235, 'Ann\'s pointer at Ben');
    expect(ben.seen.peers[0].selection).toEqual([id]);
    ann.collab.rename('Annie');
    await until(() => ben.seen.peers[0]?.name === 'Annie', 'the new name');
    ann.collab.leave();
    await until(() => ben.seen.peers.length === 0, 'Ann to leave');
  });

  it('refuses bad room codes', async () => {
    const port = (server.address() as AddressInfo).port;
    const refused = await new Promise<boolean>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/collab?room=NO!`);
      ws.onopen = () => done(false);
      ws.onerror = () => done(true);
    });
    expect(refused).toBe(true);
    expect(rooms.size).toBeGreaterThan(0);
  });
});

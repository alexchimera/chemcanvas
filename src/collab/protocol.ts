import type { MoleculeData } from '../core/molecule';
import type { Patch } from '../core/patch';

// Messages between the browser and the room server, as JSON over a WebSocket
// at /collab?room=<code>. The server keeps each room's drawing and the order
// edits happened in; browsers apply edits straight away and send them as
// patches, which the server applies, acknowledges, and passes on.

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
  /** Pointer position in model space, or null when it's off the canvas. */
  cursor: [number, number] | null;
  selection: number[];
}

export type ClientMessage =
  | { t: 'hello'; name: string }
  | { t: 'name'; name: string }
  | { t: 'patch'; seq: number; patch: Patch }
  | { t: 'presence'; cursor: [number, number] | null; selection: number[] };

export type ServerMessage =
  | { t: 'welcome'; you: PeerInfo; doc: MoleculeData; peers: PeerInfo[] }
  | { t: 'patch'; from: string; patch: Patch }
  | { t: 'ack'; seq: number }
  | { t: 'reject'; seq: number; reason: string }
  | { t: 'join'; peer: PeerInfo }
  | { t: 'leave'; id: string }
  | { t: 'presence'; id: string; cursor: [number, number] | null; selection: number[] }
  | { t: 'name'; id: string; name: string };

export const COLLAB_PATH = '/collab';
export const ROOM_PATTERN = /^[a-z0-9]{4,32}$/;
export const NAME_MAX = 32;

/** Easy to read out and type: no 0/o, 1/l/i. */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

const randomInts = (n: number, below: number): number[] =>
  [...crypto.getRandomValues(new Uint32Array(n))].map((v) => v % below);

export function newRoomCode(): string {
  return randomInts(6, ALPHABET.length)
    .map((i) => ALPHABET[i])
    .join('');
}

/** A room code from what someone typed or pasted: "K7X-9QP", "k7x9qp", or a whole link. */
export function readRoomCode(input: string): string | null {
  const text = input.trim();
  let code = text;
  try {
    code = new URL(text).searchParams.get('room') ?? text;
  } catch {
    // Not a link; take it as a code.
  }
  code = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ROOM_PATTERN.test(code) ? code : null;
}

export const cleanName = (name: unknown): string =>
  typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) : '';

const ADJECTIVES = ['Swift', 'Brave', 'Quiet', 'Lucky', 'Bright', 'Clever', 'Gentle', 'Mighty', 'Noble', 'Witty', 'Calm', 'Bold', 'Keen', 'Merry', 'Nimble', 'Sunny'];
const ELEMENTS = ['Argon', 'Boron', 'Carbon', 'Cobalt', 'Copper', 'Helium', 'Iodine', 'Krypton', 'Lithium', 'Neon', 'Nickel', 'Osmium', 'Radon', 'Silver', 'Sodium', 'Xenon', 'Zinc', 'Gallium', 'Indium', 'Iridium'];

export function randomName(): string {
  const [a, e] = randomInts(2, 1 << 30);
  return `${ADJECTIVES[a % ADJECTIVES.length]} ${ELEMENTS[e % ELEMENTS.length]}`;
}

/** Pointer colours, picked in order so people in a room look different; all take white text. */
export const PEER_COLORS = ['#d6336c', '#e8590c', '#2f9e44', '#0c8599', '#7048e8', '#a0522d', '#c2255c', '#5f3dc4'];

/**
 * New-id source for a shared drawing: a random 31-bit tag above a 21-bit
 * counter, so two people adding atoms at once never pick the same id. Ids
 * stay below 2^52, inside JavaScript's exact integers.
 */
export function taggedIds(): () => number {
  const SPAN = 2 ** 21;
  let tag = 0;
  let n = SPAN;
  return () => {
    if (n >= SPAN - 1) {
      tag = 1 + randomInts(1, 2 ** 31 - 1)[0];
      n = 0;
    }
    return tag * SPAN + ++n;
  };
}

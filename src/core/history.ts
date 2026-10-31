import { isEmptyPatch, type Patch } from './patch';

/**
 * Undo and redo as a stack of patches rather than snapshots, so in a shared
 * drawing undo takes back only your own changes.
 */
export class History {
  private past: Patch[] = [];
  private future: Patch[] = [];

  constructor(private readonly limit = 200) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  record(patch: Patch): void {
    if (isEmptyPatch(patch)) return;
    this.past.push(patch);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** The patch to take back (apply it inverted), or null. */
  undo(): Patch | null {
    const patch = this.past.pop() ?? null;
    if (patch) this.future.push(patch);
    return patch;
  }

  /** The patch to apply again, or null. */
  redo(): Patch | null {
    const patch = this.future.pop() ?? null;
    if (patch) this.past.push(patch);
    return patch;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}

import type { TapeEntryV1 } from '../types';

export class TapeStore {
  private entries: TapeEntryV1[] = [];
  private maxEntries: number;

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = Math.max(100, opts?.maxEntries || 5000);
  }

  getLastSeq(): number | null {
    const last = this.entries[this.entries.length - 1];
    return last ? last.seq : null;
  }

  getLastHash(): string | null {
    const last = this.entries[this.entries.length - 1];
    return last ? last.entryHash : null;
  }

  push(entry: TapeEntryV1) {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  all(): TapeEntryV1[] {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }
}


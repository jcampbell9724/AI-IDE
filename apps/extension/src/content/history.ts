export interface PreviewDelta {
  id: string;
  selector: string;
  property: string;
  value: string;
  previousValue: string;
  timestamp: number;
}

interface PreviewBatch {
  id: string;
  deltas: PreviewDelta[];
}

export class PreviewHistory {
  private applied: PreviewBatch[] = [];
  private undone: PreviewBatch[] = [];

  push(deltas: PreviewDelta[]): void {
    if (!deltas.length) return;
    this.applied.push({ id: crypto.randomUUID(), deltas });
    this.undone = [];
  }

  undo(): PreviewDelta[] {
    const batch = this.applied.pop();
    if (batch) this.undone.push(batch);
    return this.snapshot();
  }

  redo(): PreviewDelta[] {
    const batch = this.undone.pop();
    if (batch) this.applied.push(batch);
    return this.snapshot();
  }

  clear(): void {
    this.applied = [];
    this.undone = [];
  }

  snapshot(): PreviewDelta[] {
    return this.applied.flatMap((batch) => batch.deltas);
  }

  state(): { canUndo: boolean; canRedo: boolean } {
    return { canUndo: this.applied.length > 0, canRedo: this.undone.length > 0 };
  }
}

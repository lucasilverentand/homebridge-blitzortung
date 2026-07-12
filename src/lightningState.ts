export interface LightningSnapshot {
  strikeActive: boolean;
  stormActive: boolean;
  lastDistanceKm?: number;
  lastStrikeAt?: Date;
}

export type StateListener = (snapshot: LightningSnapshot) => void;

export class LightningState {
  private strikeTimer?: ReturnType<typeof setTimeout>;
  private stormTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<StateListener>();
  private snapshot: LightningSnapshot = { strikeActive: false, stormActive: false };

  constructor(
    private readonly strikeAlertMilliseconds: number,
    private readonly stormClearMilliseconds: number,
  ) {}

  public current(): LightningSnapshot {
    return { ...this.snapshot };
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.current());
    return () => this.listeners.delete(listener);
  }

  public recordStrike(distance: number, now = new Date()): void {
    if (this.snapshot.strikeActive) {
      this.setSnapshot({ ...this.snapshot, strikeActive: false });
    }
    this.setSnapshot({
      strikeActive: true,
      stormActive: true,
      lastDistanceKm: distance,
      lastStrikeAt: now,
    });

    clearTimeout(this.strikeTimer);
    this.strikeTimer = setTimeout(() => {
      this.setSnapshot({ ...this.snapshot, strikeActive: false });
    }, this.strikeAlertMilliseconds);

    clearTimeout(this.stormTimer);
    this.stormTimer = setTimeout(() => {
      this.setSnapshot({ ...this.snapshot, stormActive: false });
    }, this.stormClearMilliseconds);
  }

  public dispose(): void {
    clearTimeout(this.strikeTimer);
    clearTimeout(this.stormTimer);
    this.listeners.clear();
  }

  private setSnapshot(snapshot: LightningSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener(this.current());
    }
  }
}

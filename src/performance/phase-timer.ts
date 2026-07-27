export interface PhaseTimer {
  end(): void;
}

export const NOOP_PHASE_TIMER: PhaseTimer = {
  end() {},
};

export class ActivePhaseTimer implements PhaseTimer {
  private readonly startTime: number;

  private ended = false;

  constructor(
    private readonly phaseName: string,
    private readonly onEnd: (name: string, durationMs: number) => void
  ) {
    this.startTime = performance.now();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const duration = performance.now() - this.startTime;
    this.onEnd(this.phaseName, duration);
  }
}

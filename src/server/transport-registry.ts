import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface ManagedTransport {
  transport: StreamableHTTPServerTransport;
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  inFlight: number;
}

export interface TransportRegistryOptions {
  maxTransports?: number;
  transportTtlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  autoStart?: boolean;
  schedule?: (cb: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}

export class TransportRegistry {
  private readonly transports = new Map<string, ManagedTransport>();
  private readonly maxTransports: number;
  private readonly transportTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void, ms: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private gcTimer?: unknown;

  constructor(options: TransportRegistryOptions = {}) {
    this.maxTransports = options.maxTransports ?? 100;
    this.transportTtlMs = options.transportTtlMs ?? 30 * 60 * 1000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 1000;
    this.now = options.now ?? Date.now;
    
    this.schedule = options.schedule ?? ((cb, ms) => {
      const timer = setInterval(cb, ms);
      if (timer.unref) timer.unref();
      return timer;
    });
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => {
      clearInterval(handle as any);
    });
    
    if (options.autoStart ?? true) {
      this.start();
    }
  }

  public start(): void {
    if (!this.gcTimer) {
      this.gcTimer = this.schedule(() => this.sweep(), this.sweepIntervalMs);
    }
  }

  public get(sessionId: string): ManagedTransport | undefined {
    return this.transports.get(sessionId);
  }

  public add(sessionId: string, transport: StreamableHTTPServerTransport): void {
    this.transports.set(sessionId, { 
      transport, 
      sessionId, 
      createdAt: this.now(), 
      lastActivityAt: this.now(), 
      inFlight: 0 
    });
    if (this.transports.size > this.maxTransports) {
      this.sweep();
    }
  }

  public remove(sessionId: string): void {
    this.transports.delete(sessionId);
  }

  public markActive(sessionId: string): void {
    const mt = this.transports.get(sessionId);
    if (mt) { 
      mt.inFlight++; 
      mt.lastActivityAt = this.now(); 
    }
  }

  public markIdle(sessionId: string): void {
    const mt = this.transports.get(sessionId);
    if (mt && mt.inFlight > 0) {
      mt.inFlight--;
    }
  }

  public touch(sessionId: string): void {
    const mt = this.transports.get(sessionId);
    if (mt && mt.inFlight === 0) {
      mt.lastActivityAt = this.now();
    }
  }

  public stop(): void {
    if (this.gcTimer) {
      this.cancelSchedule(this.gcTimer);
      this.gcTimer = undefined;
    }
  }

  public closeAll(): void {
    for (const mt of this.transports.values()) {
      try { mt.transport.close(); } catch {}
    }
    this.transports.clear();
  }

  public shutdown(): void {
    this.stop();
    this.closeAll();
  }

  public sweep(): void {
    const currentTime = this.now();
    for (const [sid, mt] of this.transports) {
      if (mt.inFlight > 0) continue; // never close active requests
      if (currentTime - mt.lastActivityAt > this.transportTtlMs) {
        try { mt.transport.close(); } catch {}
        this.transports.delete(sid);
      }
    }
    
    if (this.transports.size > this.maxTransports) {
      const sorted = [...this.transports.entries()]
        .filter(([, mt]) => mt.inFlight === 0)
        .sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt);
        
      for (const [sid] of sorted.slice(0, sorted.length - this.maxTransports)) {
        try { this.transports.get(sid)?.transport.close(); } catch {}
        this.transports.delete(sid);
      }
    }
  }
}


import { describe, it, expect, beforeEach } from 'vitest';
import { TransportRegistry } from './transport-registry.js';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

describe('TransportRegistry', () => {
  let currentTime: number;
  let registry: TransportRegistry;
  let fakes: StreamableHTTPServerTransport[];

  const createFakeTransport = () => ({
    close: () => {},
  } as unknown as StreamableHTTPServerTransport);

  beforeEach(() => {
    currentTime = 10000;
    fakes = [createFakeTransport(), createFakeTransport(), createFakeTransport()];
    registry = new TransportRegistry({
      now: () => currentTime,
      autoStart: false,
      maxTransports: 2,
      transportTtlMs: 5000,
      sweepIntervalMs: 1000,
    });
  });

  it('sessão ociosa expira', () => {
    registry.add('s1', fakes[0]);
    expect(registry.get('s1')).toBeDefined();
    
    // Advance time beyond TTL
    currentTime += 6000;
    registry.sweep();
    
    expect(registry.get('s1')).toBeUndefined();
  });

  it('sessão ativa não expira', () => {
    registry.add('s1', fakes[0]);
    registry.markActive('s1');
    
    // Advance time beyond TTL
    currentTime += 6000;
    registry.sweep();
    
    // Still exists because inFlight > 0
    expect(registry.get('s1')).toBeDefined();
    expect(registry.get('s1')?.inFlight).toBe(1);
  });

  it('excesso remove a sessão ociosa mais antiga', () => {
    registry.add('s1', fakes[0]);
    currentTime += 1000;
    registry.add('s2', fakes[1]);
    
    // Max is 2, adding 3rd should evict oldest (s1)
    currentTime += 1000;
    registry.add('s3', fakes[2]);
    
    expect(registry.get('s1')).toBeUndefined(); // evicted
    expect(registry.get('s2')).toBeDefined();
    expect(registry.get('s3')).toBeDefined();
  });

  it('excesso não remove inFlight > 0', () => {
    registry.add('s1', fakes[0]); // Oldest
    registry.markActive('s1'); // But active!
    
    currentTime += 1000;
    registry.add('s2', fakes[1]);
    
    currentTime += 1000;
    registry.add('s3', fakes[2]);
    
    // s1 was active, so s2 should be evicted instead
    expect(registry.get('s1')).toBeDefined();
    expect(registry.get('s2')).toBeUndefined(); // evicted
    expect(registry.get('s3')).toBeDefined();
  });

  it('markIdle não deixa valor negativo', () => {
    registry.add('s1', fakes[0]);
    registry.markIdle('s1');
    registry.markIdle('s1');
    expect(registry.get('s1')?.inFlight).toBe(0);
  });

  it('erro ao fechar uma sessão não bloqueia as demais', () => {
    const errorTransport = createFakeTransport();
    errorTransport.close = () => { throw new Error('Close failed'); };
    
    registry.add('s1', errorTransport);
    currentTime += 1000;
    registry.add('s2', fakes[0]);
    
    currentTime += 6000;
    registry.sweep(); // Both should be expired. s1 throws, but s2 should still be removed.
    
    expect(registry.get('s1')).toBeUndefined();
    expect(registry.get('s2')).toBeUndefined();
  });

  it('stop() cancela o scheduler', () => {
    let cancelled = false;
    const r = new TransportRegistry({
      schedule: () => 'handle',
      cancelSchedule: () => { cancelled = true; },
      autoStart: true,
    });
    r.stop();
    expect(cancelled).toBe(true);
  });

  it('closeAll() esvazia o registry', () => {
    registry.add('s1', fakes[0]);
    registry.add('s2', fakes[1]);
    registry.closeAll();
    expect(registry.get('s1')).toBeUndefined();
    expect(registry.get('s2')).toBeUndefined();
  });
});

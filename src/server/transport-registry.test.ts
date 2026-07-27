import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
    assert.ok(registry.get('s1'));

    // Advance time beyond TTL
    currentTime += 6000;
    registry.sweep();

    assert.equal(registry.get('s1'), undefined);
  });

  it('sessão ativa não expira', () => {
    registry.add('s1', fakes[0]);
    registry.markActive('s1');

    // Advance time beyond TTL
    currentTime += 6000;
    registry.sweep();

    // Still exists because inFlight > 0
    assert.ok(registry.get('s1'));
    assert.equal(registry.get('s1')?.inFlight, 1);
  });

  it('excesso remove a sessão ociosa mais antiga', () => {
    registry.add('s1', fakes[0]);
    currentTime += 1000;
    registry.add('s2', fakes[1]);

    // Max is 2, adding 3rd should evict oldest (s1)
    currentTime += 1000;
    registry.add('s3', fakes[2]);

    assert.equal(registry.get('s1'), undefined); // evicted
    assert.ok(registry.get('s2'));
    assert.ok(registry.get('s3'));
  });

  it('excesso não remove inFlight > 0', () => {
    registry.add('s1', fakes[0]); // Oldest
    registry.markActive('s1'); // But active!

    currentTime += 1000;
    registry.add('s2', fakes[1]);

    currentTime += 1000;
    registry.add('s3', fakes[2]);

    // s1 was active, so s2 should be evicted instead
    assert.ok(registry.get('s1'));
    assert.equal(registry.get('s2'), undefined); // evicted
    assert.ok(registry.get('s3'));
  });

  it('markIdle não deixa valor negativo', () => {
    registry.add('s1', fakes[0]);
    registry.markIdle('s1');
    registry.markIdle('s1');
    assert.equal(registry.get('s1')?.inFlight, 0);
  });

  it('erro ao fechar uma sessão não bloqueia as demais', () => {
    const errorTransport = createFakeTransport();
    errorTransport.close = () => { throw new Error('Close failed'); };

    registry.add('s1', errorTransport);
    currentTime += 1000;
    registry.add('s2', fakes[0]);

    currentTime += 6000;
    registry.sweep(); // Both should be expired. s1 throws, but s2 should still be removed.

    assert.equal(registry.get('s1'), undefined);
    assert.equal(registry.get('s2'), undefined);
  });

  it('stop() cancela o scheduler', () => {
    let cancelled = false;
    const r = new TransportRegistry({
      schedule: () => 'handle',
      cancelSchedule: () => { cancelled = true; },
      autoStart: true,
    });
    r.stop();
    assert.equal(cancelled, true);
  });

  it('closeAll() esvazia o registry', () => {
    registry.add('s1', fakes[0]);
    registry.add('s2', fakes[1]);
    registry.closeAll();
    assert.equal(registry.get('s1'), undefined);
    assert.equal(registry.get('s2'), undefined);
  });
});

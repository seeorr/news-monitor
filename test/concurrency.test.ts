import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, mapConcurrent, sleep, withDeadline } from "../src/lib/concurrency.ts";

afterEach(() => vi.useRealTimers());

describe("concurrencia limitada y cancelación", () => {
  it("mantiene tres trabajadores y recoge cada resultado una vez", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const work = mapConcurrent(Array.from({ length: 17 }, (_, i) => i), 3, async (i) => {
      peak = Math.max(peak, ++active);
      await sleep(10);
      active--;
      return i * 2;
    });
    await vi.runAllTimersAsync();
    expect(await work).toEqual(Array.from({ length: 17 }, (_, i) => i * 2));
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it("aborta una tarea que ignora la señal sin bloquear a las demás", async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    const result = withDeadline((signal) => {
      observed = signal;
      return new Promise<never>(() => {});
    }, 100);
    const assertion = expect(result).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(observed?.aborted).toBe(true);
  });

  it("espera las escrituras ya iniciadas cuando falla una de ellas", async () => {
    vi.useFakeTimers();
    const completed: number[] = [];
    const work = mapConcurrent([1, 2, 3, 4], 2, async (i) => {
      await sleep(i === 1 ? 10 : 40);
      completed.push(i);
      if (i === 1) throw new Error("storage failed");
      return i;
    });
    const assertion = expect(work).rejects.toThrow("storage failed");
    await vi.runAllTimersAsync();
    await assertion;
    expect(completed).toEqual([1, 2]);
  });

  it("espacia todas las peticiones SEC por 150 ms sin ráfagas", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const wait = createRateLimiter(150);
    const starts: number[] = [];
    const requests = Promise.all(Array.from({ length: 15 }, async () => {
      await wait();
      starts.push(Date.now());
    }));
    await vi.runAllTimersAsync();
    await requests;
    expect(starts).toEqual(Array.from({ length: 15 }, (_, i) => i * 150));
    for (const start of starts) expect(starts.filter((t) => t >= start && t < start + 1_000).length).toBeLessThanOrEqual(7);
  });
});

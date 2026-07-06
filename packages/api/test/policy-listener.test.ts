import { describe, expect, it } from "vitest";
import {
  POLICY_ACTIVATED_CHANNEL,
  startPolicyActivationListener,
  type ListenClient,
} from "../src/modules/policy/listener";

/** Flush pending microtasks/immediates so the listener's async connect settles. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeClient implements ListenClient {
  handlers: Record<string, ((arg: unknown) => void)[]> = {};
  connected = false;
  ended = false;
  queries: string[] = [];
  failConnect = false;

  on(event: string, cb: (arg: never) => void): unknown {
    (this.handlers[event] ??= []).push(cb as (arg: unknown) => void);
    return this;
  }
  removeAllListeners(): void {
    this.handlers = {};
  }
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("connect failed");
    this.connected = true;
  }
  async query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    return {};
  }
  async end(): Promise<void> {
    this.ended = true;
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
}

/** A manual reconnect scheduler: captures the callback so the test fires it. */
function manualScheduler() {
  let scheduled: { fn: () => void; ms: number } | null = null;
  return {
    schedule: (fn: () => void, ms: number) => {
      scheduled = { fn, ms };
      return { cancel: () => (scheduled = null) };
    },
    get pending() {
      return scheduled;
    },
    fire() {
      const s = scheduled;
      scheduled = null;
      s?.fn();
    },
  };
}

describe("policy activation listener", () => {
  it("dispatches activation notifications (and ignores others) to onActivated", async () => {
    const fake = new FakeClient();
    const seen: string[] = [];
    const listener = startPolicyActivationListener({
      createClient: () => fake,
      onActivated: (tenantId) => seen.push(tenantId),
    });
    await tick();

    expect(fake.connected).toBe(true);
    expect(fake.queries).toContain(`LISTEN ${POLICY_ACTIVATED_CHANNEL}`);

    fake.emit("notification", { channel: POLICY_ACTIVATED_CHANNEL, payload: "tenant-x" });
    fake.emit("notification", { channel: "some_other_channel", payload: "nope" });
    fake.emit("notification", { channel: POLICY_ACTIVATED_CHANNEL, payload: undefined });

    expect(seen).toEqual(["tenant-x"]);
    await listener.stop();
  });

  it("reconnects after a connection error, resetting to a fresh LISTEN", async () => {
    const clients: FakeClient[] = [];
    const sched = manualScheduler();
    const listener = startPolicyActivationListener({
      createClient: () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      onActivated: () => {},
      scheduleReconnect: sched.schedule,
      reconnectBaseMs: 500,
    });
    await tick();
    expect(clients).toHaveLength(1);

    // A dropped connection schedules a reconnect (first delay = base).
    clients[0]!.emit("error", new Error("connection reset"));
    await tick();
    expect(clients[0]!.ended).toBe(true);
    expect(sched.pending?.ms).toBe(500);

    // Firing the reconnect builds a fresh client that re-establishes LISTEN.
    sched.fire();
    await tick();
    expect(clients).toHaveLength(2);
    expect(clients[1]!.connected).toBe(true);
    expect(clients[1]!.queries).toContain(`LISTEN ${POLICY_ACTIVATED_CHANNEL}`);

    await listener.stop();
  });

  it("retries when the initial connect fails", async () => {
    const clients: FakeClient[] = [];
    const sched = manualScheduler();
    const listener = startPolicyActivationListener({
      createClient: () => {
        const c = new FakeClient();
        c.failConnect = clients.length === 0; // first attempt fails, second succeeds
        clients.push(c);
        return c;
      },
      onActivated: () => {},
      scheduleReconnect: sched.schedule,
    });
    await tick();
    expect(clients[0]!.connected).toBe(false);
    expect(sched.pending).not.toBeNull();

    sched.fire();
    await tick();
    expect(clients[1]!.connected).toBe(true);

    await listener.stop();
  });

  it("stop() cancels a pending reconnect and does not reconnect on later events", async () => {
    const clients: FakeClient[] = [];
    const sched = manualScheduler();
    const listener = startPolicyActivationListener({
      createClient: () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      onActivated: () => {},
      scheduleReconnect: sched.schedule,
    });
    await tick();

    await listener.stop();
    expect(clients[0]!.ended).toBe(true);

    // An 'end' after stop must not schedule a reconnect.
    clients[0]!.emit("end", undefined);
    await tick();
    expect(sched.pending).toBeNull();
    expect(clients).toHaveLength(1);
  });
});

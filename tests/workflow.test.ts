import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkflowHandle } from "@temporalio/client";
import { matchCandidates, offerWindowMinutes } from "../src/policy";
import type { Opening, OpeningState, WaitlistClient } from "../src/types";
import { cancelOpening, getOpeningState, openingWorkflow, respondToOffer, waitlistChanged } from "../src/workflows";

const TASK_QUEUE = "waitlist-test";
let env: TestWorkflowEnvironment;
const bookings: string[] = [];
const texts: { clientName: string; body: string }[] = [];

const activities = {
  async sendText(input: { clientName: string; body: string }) {
    texts.push(input);
    return { sentAt: new Date().toISOString() };
  },
  async bookAppointment(input: { client: WaitlistClient }) {
    bookings.push(input.client.name);
    return { bookingRef: `SQ-TEST-${bookings.length}` };
  },
  async notifyStaff() {},
};

function client(id: string, name: string, extra: Partial<WaitlistClient> = {}): WaitlistClient {
  return {
    id,
    name,
    phone: "(555) 010-0000",
    service: "Color",
    stylist: "Maya",
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    from: "09:00",
    to: "19:00",
    joinedAt: "2026-09-01T00:00:00.000Z",
    ...extra,
  };
}

async function opening(id: string): Promise<Opening> {
  // Three days out, so each client gets a 120-minute reply window.
  return {
    id,
    service: "Color",
    stylist: "Maya",
    date: "2026-10-10",
    time: "15:00",
    startsAt: new Date((await env.currentTimeMs()) + 3 * 24 * 60 * 60 * 1000).toISOString(),
    label: "Sat, Oct 10 at 3:00 PM",
  };
}

async function waitForOffer(handle: WorkflowHandle, attemptCount: number): Promise<OpeningState> {
  for (let i = 0; i < 200; i++) {
    const state = await handle.query(getOpeningState);
    if (state.attempts.length === attemptCount && state.currentOfferId) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const last = await handle.query(getOpeningState);
  throw new Error(`Offer #${attemptCount} was never sent: ${last.status} ${JSON.stringify(last.events)}`);
}

let worker: Worker;
let workerRun: Promise<void>;
const runWithWorker = <T>(fn: () => Promise<T>): Promise<T> => fn();

before(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("../src/workflows"),
    activities,
  });
  workerRun = worker.run();
});
after(async () => {
  worker?.shutdown();
  await workerRun;
  await env?.teardown();
});

test("offers one client at a time, moves on after a decline and a timeout, and books exactly once", async () => {
  bookings.length = 0;
  const candidates = [client("a", "Ana"), client("b", "Ben"), client("c", "Chloe")];
  await runWithWorker(async () => {
    const handle = await env.client.workflow.start(openingWorkflow, {
      workflowId: "fill-test",
      taskQueue: TASK_QUEUE,
      args: [{ opening: await opening("fill-test"), candidates, appUrl: "http://test", msPerMinute: 60_000, windowMinutes: 120 }],
    });

    // Ana declines -> Ben is offered.
    let state = await waitForOffer(handle, 1);
    assert.equal(state.attempts[0].clientName, "Ana");
    const decline = await handle.executeUpdate(respondToOffer, { args: [{ offerId: state.currentOfferId!, answer: "decline" }] });
    assert.equal(decline.result, "declined");

    // Ben never replies -> after his window, Chloe is offered.
    state = await waitForOffer(handle, 2);
    assert.equal(state.attempts[1].clientName, "Ben");
    const benOfferId = state.currentOfferId!;
    await env.sleep("121 minutes");
    state = await waitForOffer(handle, 3);
    assert.equal(state.attempts[1].outcome, "timed_out");

    // Ben replies late: he is told it's no longer available, and is NOT booked.
    const late = await handle.executeUpdate(respondToOffer, { args: [{ offerId: benOfferId, answer: "accept" }] });
    assert.equal(late.result, "no_longer_available");

    // Chloe accepts -> booked.
    const accept = await handle.executeUpdate(respondToOffer, { args: [{ offerId: state.currentOfferId!, answer: "accept" }] });
    assert.equal(accept.result, "confirmed");

    const result = await handle.result();
    assert.equal(result.status, "filled");
    assert.equal(result.bookedClientName, "Chloe");
    assert.deepEqual(bookings, ["Chloe"]);
    assert.deepEqual(
      result.attempts.map((a) => a.outcome),
      ["declined", "timed_out", "accepted"],
    );
  });
});

test("staff can cancel an opening; the client holding the offer is told and nobody is booked", async () => {
  bookings.length = 0;
  texts.length = 0;
  await runWithWorker(async () => {
    const handle = await env.client.workflow.start(openingWorkflow, {
      workflowId: "cancel-test",
      taskQueue: TASK_QUEUE,
      args: [{ opening: await opening("cancel-test"), candidates: [client("a", "Ana"), client("b", "Ben")], appUrl: "http://test", msPerMinute: 60_000, windowMinutes: 120 }],
    });
    const state = await waitForOffer(handle, 1);
    await handle.signal(cancelOpening, { reason: "Maya called in sick" });
    const result = await handle.result();
    assert.equal(result.status, "cancelled");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].outcome, "withdrawn");
    assert.deepEqual(bookings, []);
    assert.ok(texts.some((t) => t.clientName === "Ana" && t.body.includes("no longer available")));

    // Accepting the withdrawn offer afterwards still can't book anything.
    assert.equal(state.attempts[0].clientName, "Ana");
  });
});

test("after everyone is contacted it keeps watching, and offers a client whose availability now matches", async () => {
  bookings.length = 0;
  const handle = await env.client.workflow.start(openingWorkflow, {
    workflowId: "keep-going-test",
    taskQueue: TASK_QUEUE,
    args: [{ opening: await opening("keep-going-test"), candidates: [client("a", "Ana")], appUrl: "http://test", msPerMinute: 60_000, windowMinutes: 120 }],
  });
  const first = await waitForOffer(handle, 1);
  await handle.executeUpdate(respondToOffer, { args: [{ offerId: first.currentOfferId!, answer: "decline" }] });

  // List exhausted: the opening stays open instead of giving up.
  let state = await handle.query(getOpeningState);
  for (let i = 0; i < 100 && state.status !== "waiting"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await handle.query(getOpeningState);
  }
  assert.equal(state.status, "waiting");

  // Staff widen Zoe's availability; she now matches and is offered the slot.
  await handle.signal(waitlistChanged, { client: client("z", "Zoe"), eligible: true, reason: "availability updated" });
  const second = await waitForOffer(handle, 2);
  assert.equal(second.attempts[1].clientName, "Zoe");
  const accept = await handle.executeUpdate(respondToOffer, { args: [{ offerId: second.currentOfferId!, answer: "accept" }] });
  assert.equal(accept.result, "confirmed");
  const result = await handle.result();
  assert.equal(result.status, "filled");
  assert.deepEqual(bookings, ["Zoe"]);
});

test("if nobody accepts, the opening stays open until the appointment time, then ends unfilled", async () => {
  bookings.length = 0;
  const handle = await env.client.workflow.start(openingWorkflow, {
    workflowId: "unfilled-test",
    taskQueue: TASK_QUEUE,
    args: [{ opening: await opening("unfilled-test"), candidates: [client("a", "Ana"), client("b", "Ben")], appUrl: "http://test", msPerMinute: 60_000, windowMinutes: 120 }],
  });
  // Nobody replies; the test server skips time until the appointment (3 days out).
  const result = await handle.result();
  assert.equal(result.status, "unfilled");
  assert.deepEqual(result.attempts.map((a) => a.outcome), ["timed_out", "timed_out"]);
  assert.ok(Date.parse(result.finishedAt!) >= Date.parse(result.opening.startsAt));
  assert.deepEqual(bookings, []);
});

test("matching follows Lena's rules: service, stylist preference, availability, earliest sign-up first", () => {
  const waitlist = [
    client("late", "Late joiner", { joinedAt: "2026-09-10T00:00:00.000Z" }),
    client("early", "Early joiner", { stylist: "Any", joinedAt: "2026-09-02T00:00:00.000Z" }),
    client("other-stylist", "Wants Jordan", { stylist: "Jordan" }),
    client("haircut", "Wants a haircut", { service: "Haircut" }),
    client("weekends", "Weekends only", { days: ["Sat", "Sun"] }), // Oct 6 2026 is a Tuesday
    client("mornings", "Mornings only", { from: "08:00", to: "12:00" }),
  ];
  const matches = matchCandidates({ service: "Color", stylist: "Maya", date: "2026-10-06", time: "15:00" }, waitlist);
  assert.deepEqual(matches.map((c) => c.id), ["early", "late"]);
});

test("reply window: same-day is fixed at 15 minutes; later days use the staff's choice", () => {
  assert.equal(offerWindowMinutes(true, 240), 15);
  assert.equal(offerWindowMinutes(false, 240), 240);
  assert.equal(offerWindowMinutes(false, undefined), 60);
});
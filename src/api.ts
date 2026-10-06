import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { LATER_WINDOW_CHOICES, matchCandidates, offerWindowMinutes } from "./policy";
import type { OfferAnswer, OfferReply, Opening, OpeningState, WaitlistClient } from "./types";
import { cancelOpening, getOpeningState, openingWorkflow, removeClient, respondToOffer } from "./workflows";

const TASK_QUEUE = "juniper-waitlist";
const port = Number(process.env.PORT ?? 3000);
const appUrl = process.env.APP_URL ?? `http://localhost:${port}`;
// Demo mode: one "minute" of offer window lasts one second so timeouts can be watched live.
// Set DEMO_SPEED=off for real minutes.
const msPerMinute = process.env.DEMO_SPEED === "off" ? 60_000 : 1_000;

export const SERVICES = ["Haircut", "Color", "Blowout"];
export const STYLISTS = ["Maya", "Jordan", "Priya"];

// --- Waitlist (stands in for the Google Sheet) -------------------------------------------
const seedFile = path.join(process.cwd(), "data", "waitlist.json");
const localFile = path.join(process.cwd(), "data", "waitlist.local.json");
let waitlist: WaitlistClient[] = JSON.parse(
  readFileSync(existsSync(localFile) ? localFile : seedFile, "utf8"),
);
const saveWaitlist = () => writeFileSync(localFile, JSON.stringify(waitlist, null, 2));

// --- Temporal client -----------------------------------------------------------------------
let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

async function runningOpeningIds(): Promise<string[]> {
  const client = await getClient();
  const ids: string[] = [];
  for await (const wf of client.workflow.list({
    query: `WorkflowType = 'openingWorkflow' AND ExecutionStatus = 'Running'`,
  })) {
    ids.push(wf.workflowId);
  }
  return ids;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/config", (_request, response) => {
  response.json({
    services: SERVICES,
    stylists: STYLISTS,
    windowChoices: LATER_WINDOW_CHOICES,
    demoMode: msPerMinute !== 60_000,
  });
});

// --- Waitlist endpoints --------------------------------------------------------------------
app.get("/api/waitlist", (_request, response) => {
  response.json([...waitlist].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)));
});

app.post("/api/waitlist", (request, response) => {
  const { name, phone, service, stylist, days, from, to } = request.body ?? {};
  if (!name || !phone || !SERVICES.includes(service) || !Array.isArray(days) || days.length === 0) {
    response.status(400).json({ error: "Name, mobile, service and at least one day are required." });
    return;
  }
  const entry: WaitlistClient = {
    id: randomUUID().slice(0, 8),
    name,
    phone,
    service,
    stylist: stylist || "Any",
    days,
    from: from || "09:00",
    to: to || "19:00",
    joinedAt: new Date().toISOString(),
  };
  waitlist.push(entry);
  saveWaitlist();
  response.status(201).json(entry);
});

app.delete("/api/waitlist/:id", async (request, response) => {
  const clientId = request.params.id;
  waitlist = waitlist.filter((c) => c.id !== clientId);
  saveWaitlist();
  // Make sure in-progress openings stop considering this person too.
  const client = await getClient();
  for (const id of await runningOpeningIds()) {
    await client.workflow.getHandle(id).signal(removeClient, { clientId });
  }
  response.status(204).end();
});

// --- Openings ------------------------------------------------------------------------------
function parseOpening(body: any): Omit<Opening, "id"> | string {
  const { service, stylist, date, time, startsAt, label } = body ?? {};
  if (!SERVICES.includes(service) || !STYLISTS.includes(stylist)) return "Pick a service and stylist.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !/^\d{2}:\d{2}$/.test(time ?? "")) return "Pick a date and time.";
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) return "Invalid start time.";
  if (Date.parse(startsAt) <= Date.now()) return "That time has already passed.";
  return { service, stylist, date, time, startsAt, label: label || `${date} ${time}` };
}

function isToday(date: string) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return date === `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function windowFor(opening: Pick<Opening, "date">, body: any) {
  const sameDay = isToday(opening.date);
  return { sameDay, windowMinutes: offerWindowMinutes(sameDay, Number(body?.windowMinutes)) };
}

app.post("/api/openings/preview", (request, response) => {
  const parsed = parseOpening(request.body);
  if (typeof parsed === "string") {
    response.status(400).json({ error: parsed });
    return;
  }
  response.json({
    candidates: matchCandidates(parsed, waitlist).map((c) => ({ id: c.id, name: c.name })),
    ...windowFor(parsed, request.body),
  });
});

app.post("/api/openings", async (request, response) => {
  const parsed = parseOpening(request.body);
  if (typeof parsed === "string") {
    response.status(400).json({ error: parsed });
    return;
  }
  // One Workflow ID per slot: if Lena and Carla both post the same opening, Temporal refuses
  // the second one instead of texting the waitlist twice.
  const opening: Opening = { ...parsed, id: `opening-${slug(parsed.stylist)}-${parsed.date}-${parsed.time.replace(":", "")}` };
  const candidates = matchCandidates(opening, waitlist);
  const client = await getClient();
  try {
    await client.workflow.start(openingWorkflow, {
      workflowId: opening.id,
      taskQueue: TASK_QUEUE,
      args: [{ opening, candidates, appUrl, msPerMinute, windowMinutes: windowFor(opening, request.body).windowMinutes }],
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      response.status(409).json({ error: "This opening is already being offered to the waitlist." });
      return;
    }
    throw error;
  }
  response.status(201).json({ id: opening.id, candidates: candidates.length });
});

app.get("/api/openings", async (_request, response) => {
  const client = await getClient();
  const states: OpeningState[] = [];
  for await (const wf of client.workflow.list({ query: `WorkflowType = 'openingWorkflow'`, pageSize: 25 })) {
    try {
      states.push(await client.workflow.getHandle(wf.workflowId, wf.runId).query(getOpeningState));
    } catch {
      // A just-started Workflow may not have run its first task yet; it appears on the next poll.
    }
    if (states.length >= 25) break;
  }
  states.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  response.json({ openings: states, now: new Date().toISOString() });
});

app.post("/api/openings/:id/cancel", async (request, response) => {
  const client = await getClient();
  const reason = String(request.body?.reason || "Appointment or stylist no longer available");
  await client.workflow.getHandle(request.params.id).signal(cancelOpening, { reason });
  response.status(202).json({ accepted: true });
});

// --- Client offer link (no account needed) -----------------------------------------------
app.get("/api/offers/:openingId/:offerId", async (request, response) => {
  const client = await getClient();
  const state = await client.workflow.getHandle(request.params.openingId).query(getOpeningState);
  const attempt = state.attempts.find((a) => a.offerId === request.params.offerId);
  if (!attempt) {
    response.status(404).json({ error: "We couldn't find this offer." });
    return;
  }
  // Only share this client's own offer, never anyone else's details.
  response.json({
    clientName: attempt.clientName,
    service: state.opening.service,
    stylist: state.opening.stylist,
    label: state.opening.label,
    expiresAt: attempt.expiresAt,
    outcome: attempt.outcome,
    open: state.status === "offering" && state.currentOfferId === attempt.offerId,
    now: new Date().toISOString(),
  });
});

app.post("/api/offers/:openingId/:offerId", async (request, response) => {
  const answer = request.body?.answer as OfferAnswer;
  if (answer !== "accept" && answer !== "decline") {
    response.status(400).json({ error: "Answer must be accept or decline." });
    return;
  }
  const client = await getClient();
  const reply: OfferReply = await client.workflow
    .getHandle(request.params.openingId)
    .executeUpdate(respondToOffer, { args: [{ offerId: request.params.offerId, answer }] });
  response.json(reply);
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});

app.listen(port, () => console.log(`Juniper Salon waitlist is available at ${appUrl}`));

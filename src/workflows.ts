import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  proxyActivities,
  setHandler,
  uuid4,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  Attempt,
  OfferAnswer,
  OfferReply,
  OpeningInput,
  OpeningState,
  TextMessage,
  WaitlistClient,
} from "./types";

const { sendText, bookAppointment, notifyStaff } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});

// Staff: what is happening with this opening right now?
export const getOpeningState = defineQuery<OpeningState>("getOpeningState");
// Staff: the appointment or stylist is no longer available — stop offering it.
export const cancelOpening = defineSignal<[{ reason: string }]>("cancelOpening");
// Staff changed the waitlist (added a client, edited availability, removed someone).
// `eligible` says whether this client now matches this opening.
export const waitlistChanged = defineSignal<[{ client: WaitlistClient; eligible: boolean; reason: string }]>(
  "waitlistChanged",
);
// Client: tapped Accept or Decline on the offer link. An Update so they get an immediate,
// authoritative answer ("you're booked" vs "already taken").
export const respondToOffer = defineUpdate<OfferReply, [{ offerId: string; answer: OfferAnswer }]>(
  "respondToOffer",
);

// One Workflow per opening. It offers the slot to ONE matching client at a time, so two
// clients can never both accept. It moves on automatically when someone declines or the reply
// window runs out, and keeps going — including clients who become eligible later — until
// someone accepts, staff cancel, or the appointment time passes.
export async function openingWorkflow(input: OpeningInput): Promise<OpeningState> {
  const { opening, appUrl, msPerMinute, windowMinutes } = input;
  const startsAtMs = Date.parse(opening.startsAt);
  const clients = new Map<string, WaitlistClient>(input.candidates.map((c) => [c.id, c]));
  const ineligible = new Map<string, string>(); // clientId -> reason
  let cancelled = false;
  let answer: OfferAnswer | undefined;
  let staffToldListExhausted = false;

  const state: OpeningState = {
    opening,
    status: "offering",
    startedAt: new Date().toISOString(),
    queue: input.candidates.map((c) => ({ clientId: c.id, clientName: c.name })),
    attempts: [],
    events: [],
    messages: [],
    msPerMinute,
  };
  const log = (text: string) => state.events.push({ at: new Date().toISOString(), text });
  const text = async (client: WaitlistClient, kind: TextMessage["kind"], body: string, link?: string) => {
    const { sentAt } = await sendText({ to: client.phone, clientName: client.name, body });
    state.messages.push({ at: sentAt, to: client.phone, clientName: client.name, kind, body, link });
  };
  const isOpen = () => state.status === "offering" || state.status === "waiting";
  const isFinished = () => !isOpen() && state.status !== "booking";
  const msUntilStart = () => startsAtMs - Date.now();
  const bookingReply = (): OfferReply =>
    state.status === "filled"
      ? { result: "confirmed", message: `You're booked for ${opening.label} with ${opening.stylist}. See you then!` }
      : { result: "no_longer_available", message: "Sorry, we couldn't complete this booking." };

  setHandler(getOpeningState, () => state);

  setHandler(cancelOpening, ({ reason }) => {
    if (!isOpen()) {
      log(`Cancel request ignored: opening is already ${state.status}.`);
      return;
    }
    cancelled = true;
    state.cancelReason = reason;
    log(`Staff cancelled the opening: ${reason}`);
  });

  setHandler(waitlistChanged, ({ client, eligible, reason }) => {
    if (!isOpen()) return;
    clients.set(client.id, client);
    const alreadyContacted = state.attempts.some((a) => a.clientId === client.id);
    const queued = state.queue.some((q) => q.clientId === client.id);
    if (eligible) {
      ineligible.delete(client.id);
      if (queued) {
        // Keep the queue entry; their details (e.g. name) may have changed.
      } else if (!alreadyContacted) {
        state.queue.push({ clientId: client.id, clientName: client.name });
        state.queue.sort((a, b) => clients.get(a.clientId)!.joinedAt.localeCompare(clients.get(b.clientId)!.joinedAt));
        log(`${client.name} now matches (${reason}) and was added to the queue.`);
      }
    } else {
      ineligible.set(client.id, reason);
      if (queued) {
        state.queue = state.queue.filter((q) => q.clientId !== client.id);
        log(`${client.name} no longer matches (${reason}) and won't be contacted.`);
      }
    }
  });

  setHandler(
    respondToOffer,
    async ({ offerId, answer: reply }): Promise<OfferReply> => {
      const attempt = state.attempts.find((a) => a.offerId === offerId);
      if (!attempt) return { result: "unknown_offer", message: "We couldn't find this offer." };
      const client = clients.get(attempt.clientId)!;

      // Repeat tap after accepting: report the booking result.
      if (attempt.outcome === "accepted") {
        await condition(isFinished);
        return bookingReply();
      }

      // The only reply that can change anything: from the client currently holding the offer.
      if (state.currentOfferId === offerId && state.status === "offering" && !answer && !cancelled) {
        answer = reply;
        if (reply === "decline") {
          return { result: "declined", message: "No problem — you're still on our waitlist." };
        }
        await condition(isFinished);
        return bookingReply();
      }

      // Late or stale reply: the offer has moved on. It can never claim the opening.
      log(`Late reply from ${client.name} (${reply}) — told the opening is no longer available.`);
      if (reply === "accept") {
        await text(
          client,
          "no_longer_available",
          `Thanks ${client.name}! Unfortunately the ${opening.service} opening on ${opening.label} is no longer available. You're still on our waitlist.`,
        );
      }
      return {
        result: "no_longer_available",
        message: "Sorry, this opening is no longer available. You're still on our waitlist.",
      };
    },
  );

  log(
    `Opening posted: ${opening.service} with ${opening.stylist}, ${opening.label}. ${state.queue.length} matching client(s), ${windowMinutes} min each to reply.`,
  );

  while (!cancelled && msUntilStart() > 0) {
    // Everyone matching has been contacted: keep watching for newly eligible clients
    // (added to the list or availability edited) until the appointment time.
    if (state.queue.length === 0) {
      state.status = "waiting";
      if (!staffToldListExhausted) {
        staffToldListExhausted = true;
        log("Everyone who matches has been contacted. Watching for new matches until the appointment time.");
        await notifyStaff({ note: `${opening.label} ${opening.service} is still open; everyone matching has been contacted.` });
      }
      await condition(() => state.queue.length > 0 || cancelled, Math.max(1, msUntilStart()));
      if (state.status === "waiting") state.status = "offering";
      continue;
    }

    const next = state.queue.shift()!;
    const client = clients.get(next.clientId)!;
    // Never hold the offer past the appointment time.
    const waitMs = Math.max(1, Math.min(windowMinutes * msPerMinute, msUntilStart()));

    const offerId = uuid4();
    const link = `${appUrl}/offer.html?w=${encodeURIComponent(opening.id)}&o=${offerId}`;
    await text(
      client,
      "offer",
      `Hi ${client.name}, Juniper Salon has an opening: ${opening.service} with ${opening.stylist}, ${opening.label}. Reply within ${windowMinutes} min: ${link}`,
      link,
    );
    const attempt: Attempt = {
      offerId,
      clientId: client.id,
      clientName: client.name,
      sentAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + waitMs).toISOString(),
      windowMinutes,
      outcome: "pending",
    };
    state.attempts.push(attempt);
    state.currentOfferId = offerId;
    answer = undefined;
    log(`Offered to ${client.name}; holding it for ${windowMinutes} min.`);

    await condition(() => answer !== undefined || cancelled || ineligible.has(client.id), waitMs);
    attempt.resolvedAt = new Date().toISOString();

    if (answer === "accept") {
      attempt.outcome = "accepted";
      state.status = "booking";
      log(`${client.name} accepted. Booking in Square…`);
      const { bookingRef } = await bookAppointment({ opening, client });
      await text(
        client,
        "confirmation",
        `You're booked! ${opening.service} with ${opening.stylist}, ${opening.label}. Ref ${bookingRef}. Reply to this number if anything changes.`,
      );
      state.status = "filled";
      state.bookingRef = bookingRef;
      state.bookedClientName = client.name;
      log(`Filled by ${client.name} (${bookingRef}).`);
    } else if (answer === "decline") {
      attempt.outcome = "declined";
      log(`${client.name} declined.`);
    } else if (cancelled) {
      attempt.outcome = "withdrawn";
      await text(
        client,
        "no_longer_available",
        `Sorry ${client.name}, the ${opening.service} opening on ${opening.label} is no longer available. You're still on our waitlist.`,
      );
    } else if (ineligible.has(client.id)) {
      attempt.outcome = "removed";
      log(`${client.name} no longer matches (${ineligible.get(client.id)}) while holding the offer — moving on.`);
    } else {
      attempt.outcome = "timed_out";
      log(`${client.name} didn't reply in ${windowMinutes} min — moving to the next person.`);
    }
    state.currentOfferId = undefined;
    if (state.status === "filled") break;
  }

  if (state.status !== "filled") {
    if (cancelled) {
      state.status = "cancelled";
    } else {
      state.status = "unfilled";
      state.unfilledReason = "The appointment time arrived without anyone accepting.";
      log(state.unfilledReason);
      await notifyStaff({ note: `${opening.label} ${opening.service} with ${opening.stylist} was not filled.` });
    }
  }

  state.finishedAt = new Date().toISOString();
  if (state.status === "filled") {
    state.timeToFillMs = Date.parse(state.finishedAt) - Date.parse(state.startedAt);
  }
  await condition(allHandlersFinished);
  return state;
}

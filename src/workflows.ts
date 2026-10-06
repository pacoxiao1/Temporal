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
import { OFFER_CUTOFF_MINUTES } from "./policy";
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
// Staff: a client asked to be taken off the waitlist.
export const removeClient = defineSignal<[{ clientId: string }]>("removeClient");
// Client: tapped Accept or Decline on the offer link. An Update so they get an immediate,
// authoritative answer ("you're booked" vs "already taken").
export const respondToOffer = defineUpdate<OfferReply, [{ offerId: string; answer: OfferAnswer }]>(
  "respondToOffer",
);

// One Workflow per opening. It offers the slot to ONE matching client at a time, so two
// clients can never both accept, and it moves on automatically when someone declines or
// the reply window runs out.
export async function openingWorkflow(input: OpeningInput): Promise<OpeningState> {
  const { opening, candidates, appUrl, msPerMinute, windowMinutes } = input;
  const startsAtMs = Date.parse(opening.startsAt);
  const removed = new Set<string>();
  let cancelled = false;
  let answer: OfferAnswer | undefined;

  const state: OpeningState = {
    opening,
    status: "offering",
    startedAt: new Date().toISOString(),
    queue: candidates.map((c) => ({ clientId: c.id, clientName: c.name })),
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
  const isFinished = () => !["offering", "booking"].includes(state.status);
  const bookingReply = (): OfferReply =>
    state.status === "filled"
      ? { result: "confirmed", message: `You're booked for ${opening.label} with ${opening.stylist}. See you then!` }
      : { result: "no_longer_available", message: "Sorry, we couldn't complete this booking." };

  setHandler(getOpeningState, () => state);

  setHandler(cancelOpening, ({ reason }) => {
    if (state.status !== "offering") {
      log(`Cancel request ignored: opening is already ${state.status}.`);
      return;
    }
    cancelled = true;
    state.cancelReason = reason;
    log(`Staff cancelled the opening: ${reason}`);
  });

  setHandler(removeClient, ({ clientId }) => {
    removed.add(clientId);
    const queued = state.queue.find((q) => q.clientId === clientId);
    if (queued) log(`${queued.clientName} was removed from the waitlist and will not be contacted.`);
    state.queue = state.queue.filter((q) => q.clientId !== clientId);
  });

  setHandler(
    respondToOffer,
    async ({ offerId, answer: reply }): Promise<OfferReply> => {
      const attempt = state.attempts.find((a) => a.offerId === offerId);
      if (!attempt) return { result: "unknown_offer", message: "We couldn't find this offer." };
      const client = candidates.find((c) => c.id === attempt.clientId)!;

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

      // Late or stale reply: the offer has moved on. Tell them kindly; never double-book.
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
    `Opening posted: ${opening.service} with ${opening.stylist}, ${opening.label}. ${candidates.length} matching client(s), ${windowMinutes} min each to reply.`,
  );

  while (state.queue.length > 0 && !cancelled) {
    const next = state.queue.shift()!;
    const client = candidates.find((c) => c.id === next.clientId)!;

    const minutesUntilStart = (startsAtMs - Date.now()) / 60_000;
    const minutesUntilCutoff = minutesUntilStart - OFFER_CUTOFF_MINUTES;
    if (minutesUntilCutoff <= 0) {
      state.status = "expired";
      log("Too close to the appointment time to keep offering.");
      break;
    }
    const waitMs = Math.min(windowMinutes * msPerMinute, minutesUntilCutoff * 60_000);

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

    await condition(() => answer !== undefined || cancelled || removed.has(client.id), waitMs);
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
    } else if (removed.has(client.id)) {
      attempt.outcome = "removed";
      log(`${client.name} was removed from the waitlist while holding the offer.`);
    } else {
      attempt.outcome = "timed_out";
      log(`${client.name} didn't reply in ${windowMinutes} min — moving to the next person.`);
    }
    state.currentOfferId = undefined;
    if (state.status === "filled") break;
  }

  if (state.status === "offering") {
    if (cancelled) {
      state.status = "cancelled";
    } else {
      state.status = "unfilled";
      log("Nobody else on the waitlist matches. Staff alerted.");
      await notifyStaff({ note: `No one took ${opening.service} with ${opening.stylist}, ${opening.label}.` });
    }
  } else if (state.status === "expired") {
    await notifyStaff({ note: `Stopped offering ${opening.label}: too close to start time.` });
  }

  state.finishedAt = new Date().toISOString();
  if (state.status === "filled") {
    state.timeToFillMs = Date.parse(state.finishedAt) - Date.parse(state.startedAt);
  }
  await condition(allHandlersFinished);
  return state;
}

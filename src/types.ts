// A client on the "let me know if something earlier opens" list (replaces the Google Sheet).
export type WaitlistClient = {
  id: string;
  name: string;
  phone: string;
  service: string;
  stylist: string; // a stylist's name, or "Any"
  days: string[]; // e.g. ["Mon", "Tue"]
  from: string; // "09:00"
  to: string; // "17:00"
  joinedAt: string; // ISO timestamp; earlier joiners are offered first
};

// A cancelled appointment that has become an open slot.
export type Opening = {
  id: string;
  service: string;
  stylist: string;
  date: string; // "2026-10-06" (salon local date)
  time: string; // "15:00" (salon local time)
  startsAt: string; // ISO timestamp of the same moment
  label: string; // "Tue, Oct 6 at 3:00 PM"
};

export type OpeningInput = {
  opening: Opening;
  candidates: WaitlistClient[]; // already filtered and ordered by the matching rules
  appUrl: string; // base URL used to build the client's accept/decline link
  windowMinutes: number; // how long each client holds the offer before it moves on
  msPerMinute: number; // 60000 in real life; smaller in demo mode so timeouts are watchable
};

export type OpeningStatus =
  | "offering" // someone is holding the offer
  | "waiting" // everyone matching was contacted; watching for new matches until start time
  | "booking"
  | "filled"
  | "unfilled" // the appointment time arrived without anyone accepting
  | "cancelled";

export type AttemptOutcome =
  | "pending"
  | "accepted"
  | "declined"
  | "timed_out"
  | "withdrawn"
  | "removed";

export type Attempt = {
  offerId: string;
  clientId: string;
  clientName: string;
  sentAt: string;
  expiresAt: string;
  windowMinutes: number;
  outcome: AttemptOutcome;
  resolvedAt?: string;
};

export type TimelineEvent = { at: string; text: string };

export type TextMessage = {
  at: string;
  to: string;
  clientName: string;
  kind: "offer" | "confirmation" | "no_longer_available";
  body: string;
  link?: string;
};

export type OpeningState = {
  opening: Opening;
  status: OpeningStatus;
  startedAt: string;
  finishedAt?: string;
  timeToFillMs?: number;
  currentOfferId?: string;
  queue: { clientId: string; clientName: string }[];
  attempts: Attempt[];
  events: TimelineEvent[];
  messages: TextMessage[];
  bookedClientName?: string;
  bookingRef?: string;
  cancelReason?: string;
  unfilledReason?: string;
  msPerMinute: number;
};

export type OfferAnswer = "accept" | "decline";

export type OfferReply = {
  result: "confirmed" | "declined" | "no_longer_available" | "unknown_offer";
  message: string;
};

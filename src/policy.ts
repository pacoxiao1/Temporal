// Pure business rules shared by the API and the Workflow (no I/O, so Workflow-safe).
import type { Opening, WaitlistClient } from "./types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Lena's rule: same-day openings get 15 minutes per person. For tomorrow or later there is
// no fixed rule yet, so staff choose the window when they post the opening.
export const SAME_DAY_WINDOW_MINUTES = 15;
export const LATER_WINDOW_CHOICES = [30, 60, 120, 240];

export function offerWindowMinutes(sameDay: boolean, staffChosenMinutes?: number): number {
  if (sameDay) return SAME_DAY_WINDOW_MINUTES;
  return LATER_WINDOW_CHOICES.includes(staffChosenMinutes ?? NaN) ? staffChosenMinutes! : 60;
}

export function dayOfWeek(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return DAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

// Lena's rule: same service, stylist preference fits, availability fits; earliest joiner first.
export function matchCandidates(
  opening: Pick<Opening, "service" | "stylist" | "date" | "time">,
  waitlist: WaitlistClient[],
): WaitlistClient[] {
  const day = dayOfWeek(opening.date);
  return waitlist
    .filter(
      (client) =>
        client.service === opening.service &&
        (client.stylist === "Any" || client.stylist === opening.stylist) &&
        client.days.includes(day) &&
        client.from <= opening.time &&
        opening.time < client.to,
    )
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

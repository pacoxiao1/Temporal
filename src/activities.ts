// Side effects live in Activities so Temporal can retry them without re-running Workflow logic.
// For the prototype, texting and booking are SIMULATED: they log instead of calling Twilio / Square.
import { randomUUID } from "node:crypto";
import type { Opening, WaitlistClient } from "./types";

export async function sendText(input: {
  to: string;
  clientName: string;
  body: string;
}): Promise<{ sentAt: string }> {
  console.log(`[simulated SMS] to ${input.clientName} (${input.to}): ${input.body}`);
  return { sentAt: new Date().toISOString() };
}

export async function bookAppointment(input: {
  opening: Opening;
  client: WaitlistClient;
}): Promise<{ bookingRef: string }> {
  // Production: create the booking in Square for this client and slot.
  const bookingRef = `SQ-${randomUUID().slice(0, 8).toUpperCase()}`;
  console.log(
    `[simulated Square] booked ${input.client.name} for ${input.opening.service} with ${input.opening.stylist}, ${input.opening.label} (${bookingRef})`,
  );
  return { bookingRef };
}

export async function notifyStaff(input: { note: string }): Promise<void> {
  console.log(`[simulated staff alert] ${input.note}`);
}

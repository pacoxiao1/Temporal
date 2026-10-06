# Evidence

One real run of the prototype (all client data is fictional; demo speed, so 15 minutes = 15 s).

A same-day **Color with Maya** opening was posted. Three clients matched, in sign-up order:

1. **Ana, Ben, Chloe** each declined in turn. Each was offered the slot only after the previous
   person answered.
2. The list ran out, so the opening switched to **waiting for new matches** (staff alerted) instead
   of giving up. It stays open until the appointment time.
3. Staff **edited Dev Shah's availability** on the waitlist. He now matched, so he was queued and
   offered the slot automatically.
4. **Ana replied "yes" late.** She was told the opening was no longer available and was **not** booked.
5. **Dev accepted.** The booking was made and a confirmation text was sent. Re-posting the same slot
   afterwards is refused ("already filled").

| File | Shows |
| --- | --- |
| `temporal-ui-workflow-completed.jpg` | Temporal Web UI: Workflow ID `opening-maya-2026-10-05-2330`, status **Completed**, task queue, input. |
| `temporal-ui-event-history.jpg` | Compact event history: `respondToOffer` **Updates** (declines, Ana's late reply, Dev's accept), 15-second **Timers**, `notifyStaff` when the list ran out, the long Timer waiting until the appointment time, the `waitlistChanged` **Signal** from the availability edit, then `bookAppointment` and the confirmation `sendText`. |
| `staff-opening-history.jpg` | Lena's view of the same opening: each client's result and the full timeline. |
| `staff-reports.jpg` | Reports: fill rate, median time to fill, clients contacted per fill, per-service breakdown, and the finished openings (one filled, one not filled when its time arrived, one cancelled by staff). |

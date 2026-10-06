# Juniper Salon: last-minute opening filler

When a client cancels at the last minute, staff post the open slot. The app finds waitlisted
clients who match it and texts them **one at a time**, earliest sign-up first. Each client gets
an accept/decline link. If they decline or don't answer in time, the next person is offered the
slot automatically, so two clients can never claim the same opening. It keeps going until
someone accepts or the appointment time arrives, including clients who start to match later
because staff edited their availability.

Built on Temporal: **each opening is one durable Workflow.**

## Run it

Requirements: Node.js 20+ and Docker Desktop (running).

```bash
npm install && npm run dev
```

(In Windows PowerShell 5, run `npm install` and then `npm run dev`.)

- App (staff dashboard): <http://localhost:3000>
- Temporal Web UI: <http://localhost:8233>

`npm run stop` stops the Temporal container. `npm test` runs the Workflow tests (no Docker needed).
`npm run typecheck` checks TypeScript.

> **Demo speed is on by default:** one minute of a reply window lasts one second, so a same-day
> offer times out after 15 s. Run with `DEMO_SPEED=off` for real minutes.
>
> **Windows note:** if the Worker fails with `SWC native addon: validate cache root ... DACL`,
> point SWC at a folder only you can write to and set `SWC_NATIVE_BINDING_CACHE` to it
> (for example `%USERPROFILE%\.swc-cache` with inheritance removed).

## 3-minute demo

1. In **Post an opening**, keep *Color with Maya* and today's date. The preview lists the
   matching clients in the order they'll be offered (Ana → Ben → Chloe), each with 15 minutes.
2. Click **Start offering**. Ana's text appears under **Client phones**.
3. Do nothing. After 15 s, Ana shows **Timed out** and Ben is texted automatically.
4. Click **Open Ben's offer link** and choose **No thanks**. Chloe is texted immediately.
5. Open Chloe's link and choose **Yes, book it**. The opening shows **Filled**, with the booking
   reference and the time it took to fill.
6. Try a stale link (e.g. Ana's): it says the opening is no longer available. Nobody is double-booked.
7. **Keep going until the appointment time:** post another opening and decline everyone. It shows
   **Waiting for new matches** instead of giving up. On the waitlist, click **Edit** on Dev Shah,
   set his stylist to *Any* and his hours to cover the slot, and **Save**. He's offered the slot
   automatically.
8. Post a *tomorrow* opening: staff pick the reply window (30 min to 4 h). Use **Cancel opening**
   and the client holding the offer is told it's gone.
9. Scroll to **Reports**: fill rate, median time to fill, clients contacted per fill, by service.
10. Open <http://localhost:8233> and click the `opening-…` Workflow to see every text, timer, signal
    and reply.

## How it maps to Lena's needs

| Lena said | Prototype |
| --- | --- |
| "Make it reliably move to the next eligible person without double-booking." | One Workflow per opening, offering one client at a time. Only the client currently holding the offer can accept; late or stale replies get "no longer available". |
| Match on service, stylist preference and availability; earliest joiner first. | `src/policy.ts` `matchCandidates` |
| Same-day: 15 minutes, then move on automatically. Tomorrow or later: staff set the window. | `offerWindowMinutes`; a durable Temporal timer per offer |
| Clear text, easy accept/decline, no account or phone call. | Text with a personal link → `offer.html` with two buttons |
| See service, stylist, date, time, who holds the offer, accepted/declined/timed out, who's next. | Staff dashboard (live) |
| Afterwards: who was contacted, outcomes, how long it took. | Per-opening table + full history |
| "Better reporting on which openings get filled and how long they take." | **Reports**: fill rate, median/avg time to fill, clients contacted per fill, cancelled count, per service; list of finished openings |
| "Staff could adjust a client's availability without digging through the sheet." | **Edit** on each waitlist entry (stylist, days, hours). Running openings are signalled, so a client who now matches is queued and one who no longer matches is skipped. |
| "A late reply should not claim the opening if it has already moved on." | Only the current holder's reply counts; late replies get "no longer available". |
| "Keep contacting eligible people until someone accepts or the opening time passes." | No fixed number of attempts. When the list runs out, the opening waits for new matches (durable timer to the start time), then ends **Not filled**. |
| Staff can stop it if the appointment or stylist becomes unavailable. | **Cancel opening** → Signal; the holder is texted |
| Lena and Carla both work the list and lose track of who was contacted. | Workflow ID = stylist + date + time: posting a slot that's already being offered, or already filled, is refused. |
| Clients ask to be removed. | Removing someone also signals running openings to skip them. |

## Temporal design

- **Workflow** `openingWorkflow` (`src/workflows.ts`): the offer loop for one slot. It waits on
  `condition(reply || cancelled, window)`, a durable timer that survives Worker or server restarts.
  When everyone matching has been contacted, it waits (another durable timer, up to the start time)
  for newly eligible clients. Offers are never held past the appointment time.
- **Update** `respondToOffer`: the client's accept/decline. The client gets an immediate,
  authoritative answer (`confirmed` / `declined` / `no_longer_available`), decided inside the
  single-threaded Workflow, so two acceptances can't both win.
- **Signals** `cancelOpening` and `waitlistChanged` (client added, availability edited, or removed):
  staff actions.
- **Query** `getOpeningState`: powers the dashboard and the client page.
- **Activities** (`src/activities.ts`): `sendText`, `bookAppointment`, `notifyStaff`, retried
  automatically by Temporal.

## Simulated vs. real

| Simulated in this prototype | Production next step |
| --- | --- |
| Text messages (shown in "Client phones", logged by the Worker) | Twilio (or similar) SMS from the salon number, plus inbound reply handling |
| Booking (`SQ-…` reference) | Square Appointments API booking |
| Waitlist (`data/waitlist.json`; edits saved to `data/waitlist.local.json`) | Import from the Google Sheet / Square customer list |
| No staff login; runs locally | Staff authentication, signed offer links, hosting |

Not handled yet: clients replying with questions or asking for a different time (they're told to
call or text the salon), and stylist schedules being read automatically from Square.

## Repository map

- `src/workflows.ts`: opening Workflow, Signals, Update, Query
- `src/activities.ts`: simulated SMS, booking and staff alert
- `src/policy.ts`: matching and reply-window rules (shared, deterministic)
- `src/api.ts`: Express API and Temporal Client
- `src/worker.ts`: Worker on the `juniper-waitlist` task queue
- `public/`: staff dashboard (`index.html`) and client offer page (`offer.html`)
- `tests/workflow.test.ts`: time-skipping tests (decline → timeout → accept, late reply, cancel, matching)
- `evidence/`: Temporal Web UI screenshots from a real run

# Evidence

One real run of the prototype (all client data is fictional).

A same-day **Color with Maya** opening was posted. Three clients matched, in sign-up order:

1. **Ana Ruiz:** didn't reply; her 15-minute window expired (15 s at demo speed).
2. **Ben Okafor:** didn't reply either and timed out. He then tapped "accept" late and was told
   the opening was no longer available. He was **not** booked.
3. **Chloe Park:** accepted. The booking was made and a confirmation text was sent.

| File | Shows |
| --- | --- |
| `temporal-ui-workflow-completed.jpg` | Temporal Web UI: Workflow ID `opening-maya-2026-10-05-2315`, status **Completed**, input (opening + matching clients) and result (`status: "filled"`, every attempt). |
| `temporal-ui-event-history.jpg` | Compact event history: `sendText` activities, the two 15-second **Timers** that moved the offer on, Ben's late `respondToOffer` Update (`no_longer_available`), Chloe's Update (`confirmed`), then `bookAppointment`. |
| `staff-dashboard.jpg` | Lena's view of the same opening (Ana timed out → Ben timed out → Chloe accepted, filled in 43 s), plus a second opening cancelled by staff. |

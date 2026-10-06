const params = new URLSearchParams(location.search);
const base = `/api/offers/${encodeURIComponent(params.get("w"))}/${encodeURIComponent(params.get("o"))}`;
const card = document.querySelector("#offer");
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let offer;
let skewMs = 0;
let finalMessage;

function render() {
  if (finalMessage) {
    card.innerHTML = finalMessage;
    return;
  }
  const details = `<h1 class="offer-title">${esc(offer.service)} with ${esc(offer.stylist)}</h1>
    <p class="offer-when">${esc(offer.label)}</p>`;
  if (!offer.open) {
    const text =
      offer.outcome === "accepted"
        ? "You're booked. See you then!"
        : offer.outcome === "declined"
          ? "Thanks for letting us know. You're still on our waitlist."
          : "Sorry, this opening is no longer available. You're still on our waitlist.";
    card.innerHTML = `${details}<p class="result">${text}</p>`;
    return;
  }
  const left = Math.max(0, Date.parse(offer.expiresAt) - (Date.now() + skewMs));
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  card.innerHTML = `<p>Hi ${esc(offer.clientName.split(" ")[0])}, an earlier appointment opened up for you:</p>
    ${details}
    <p class="muted">We're holding it for you for <strong>${mins}:${String(secs).padStart(2, "0")}</strong>.</p>
    <div class="actions">
      <button data-answer="accept">Yes, book it</button>
      <button data-answer="decline" class="secondary">No thanks</button>
    </div>`;
}

async function load() {
  const response = await fetch(base);
  const body = await response.json();
  if (!response.ok) {
    finalMessage = `<p>${esc(body.error)}</p>`;
  } else {
    offer = body;
    skewMs = Date.parse(body.now) - Date.now();
  }
  render();
}

card.addEventListener("click", async (event) => {
  const answer = event.target.dataset?.answer;
  if (!answer) return;
  finalMessage = `<p class="muted">Sending your answer…</p>`;
  render();
  const response = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  const reply = await response.json();
  const icon = reply.result === "confirmed" ? "✓" : "";
  finalMessage = `<h1 class="offer-title">${esc(offer.service)} with ${esc(offer.stylist)}</h1>
    <p class="offer-when">${esc(offer.label)}</p>
    <p class="result ${esc(reply.result)}">${icon} ${esc(reply.message ?? reply.error)}</p>`;
  render();
});

load().catch(() => (card.innerHTML = "<p>Sorry, we couldn't load this offer.</p>"));
setInterval(() => offer && render(), 1000);
setInterval(() => !finalMessage && load().catch(() => {}), 3000);

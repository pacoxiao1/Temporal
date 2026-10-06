const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATUS_TEXT = {
  offering: "Offering",
  booking: "Booking…",
  filled: "Filled",
  unfilled: "Not filled",
  cancelled: "Cancelled",
  expired: "Stopped (too close)",
};
const OUTCOME_TEXT = {
  pending: "Holding offer",
  accepted: "Accepted",
  declined: "Declined",
  timed_out: "Timed out",
  withdrawn: "Withdrawn (cancelled)",
  removed: "Removed from list",
};

let clockSkewMs = 0; // server time minus browser time, for countdowns
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? response.statusText);
  return body;
}

// ---- Post an opening ----------------------------------------------------------------------
function openingFromForm() {
  const data = Object.fromEntries(new FormData($("#opening-form")));
  if (!data.date || !data.time) return null;
  const start = new Date(`${data.date}T${data.time}`);
  const label = start.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return { ...data, startsAt: start.toISOString(), label: label.replace(/,([^,]*)$/, " at$1") };
}

async function updatePreview() {
  const opening = openingFromForm();
  if (!opening) return;
  try {
    const { candidates, windowMinutes, sameDay } = await api("/api/openings/preview", { method: "POST", body: opening });
    $("#window").disabled = sameDay;
    $("#window-hint").textContent = sameDay
      ? "Same-day opening: fixed at 15 minutes per client."
      : "Tomorrow or later: choose how long each client has.";
    $("#preview").innerHTML = candidates.length
      ? `<strong>${candidates.length} match${candidates.length > 1 ? "es" : ""}</strong>, offered in this order:
         <ol>${candidates.map((c) => `<li>${esc(c.name)}</li>`).join("")}</ol>
         <span class="muted small">Each gets ${windowMinutes} min to reply.</span>`
      : `<strong>No waitlist matches</strong> for this service, stylist and time.`;
    $("#opening-error").textContent = "";
  } catch (error) {
    $("#preview").textContent = error.message;
  }
}

$("#opening-form").addEventListener("change", updatePreview);
$("#opening-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/openings", { method: "POST", body: openingFromForm() });
    $("#opening-error").textContent = "";
    await refreshOpenings();
  } catch (error) {
    $("#opening-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// ---- Openings list -----------------------------------------------------------------------
function renderOpening(o) {
  const now = Date.now() + clockSkewMs;
  const current = o.attempts.find((a) => a.offerId === o.currentOfferId);
  const elapsed = (o.finishedAt ? Date.parse(o.finishedAt) : now) - Date.parse(o.startedAt);
  let headline = "";
  if (o.status === "filled") headline = `Booked by <strong>${esc(o.bookedClientName)}</strong> · ${esc(o.bookingRef)} · filled in ${duration(o.timeToFillMs)}`;
  else if (current) {
    const left = Math.max(0, Date.parse(current.expiresAt) - now);
    headline = `Now offered to <strong>${esc(current.clientName)}</strong> · ${duration(left)} left to reply`;
  } else if (o.status === "unfilled") headline = "Everyone matching was contacted. Nobody took it.";
  else if (o.status === "cancelled") headline = `Cancelled: ${esc(o.cancelReason)}`;
  else if (o.status === "expired") headline = "Stopped: too close to the appointment time.";
  else headline = "Starting…";

  const rows = o.attempts
    .map((a) => {
      const took = a.resolvedAt ? duration(Date.parse(a.resolvedAt) - Date.parse(a.sentAt)) : "";
      return `<tr><td>${esc(a.clientName)}</td><td><span class="outcome ${a.outcome}">${OUTCOME_TEXT[a.outcome]}</span></td>
        <td class="muted">${time(a.sentAt)}</td><td class="muted">${took}</td></tr>`;
    })
    .join("");
  const queued = o.status === "offering" && o.queue.length ? `<p class="small muted">Next up: ${o.queue.map((q) => esc(q.clientName)).join(" → ")}</p>` : "";
  const canCancel = o.status === "offering";

  return `<article class="opening ${o.status}">
    <div class="opening-head">
      <div>
        <h3>${esc(o.opening.service)} with ${esc(o.opening.stylist)}</h3>
        <p class="muted">${esc(o.opening.label)} · open for ${duration(elapsed)}</p>
      </div>
      <span class="pill ${o.status}">${STATUS_TEXT[o.status]}</span>
    </div>
    <p>${headline}</p>
    ${rows ? `<table><thead><tr><th>Client</th><th>Result</th><th>Texted</th><th>Took</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    ${queued}
    <details><summary>Full history</summary><ul class="events">${o.events
      .map((e) => `<li><span class="muted">${time(e.at)}</span> ${esc(e.text)}</li>`)
      .join("")}</ul><p class="small muted">Workflow ID: ${esc(o.opening.id)}</p></details>
    ${canCancel ? `<button class="secondary" data-cancel="${esc(o.opening.id)}">Cancel opening</button>` : ""}
  </article>`;
}

function renderStats(openings) {
  const done = openings.filter((o) => !["offering", "booking"].includes(o.status));
  const filled = openings.filter((o) => o.status === "filled");
  const avg = filled.length ? filled.reduce((sum, o) => sum + o.timeToFillMs, 0) / filled.length : 0;
  $("#stats").innerHTML = `
    <div><strong>${openings.length - done.length}</strong><span>active</span></div>
    <div><strong>${filled.length}/${done.length}</strong><span>filled</span></div>
    <div><strong>${filled.length ? duration(avg) : "–"}</strong><span>avg time to fill</span></div>`;
}

function renderMessages(openings) {
  const messages = openings
    .flatMap((o) => o.messages)
    .sort((a, b) => b.at.localeCompare(a.at));
  if (!messages.length) return;
  $("#messages").innerHTML = `<ul class="texts">${messages
    .map(
      (m) => `<li class="${m.kind}"><div class="small muted">${time(m.at)} → ${esc(m.clientName)} ${esc(m.to)}</div>
        <div>${esc(m.body.replace(m.link ?? "\u0000", "").replace(/:\s*$/, ""))}</div>
        ${m.link ? `<a class="link-button" href="${esc(m.link)}" target="_blank">Open ${esc(m.clientName.split(" ")[0])}'s offer link</a>` : ""}</li>`,
    )
    .join("")}</ul>`;
}

let lastOpenings = [];
async function refreshOpenings() {
  const { openings, now } = await api("/api/openings");
  clockSkewMs = Date.parse(now) - Date.now();
  lastOpenings = openings;
  const openDetails = new Set([...document.querySelectorAll("#openings details[open]")].map((d) => d.closest("article").dataset.id));
  $("#openings").innerHTML = openings.length ? openings.map(renderOpening).join("") : `<p class="muted">No openings yet.</p>`;
  document.querySelectorAll("#openings article").forEach((el, i) => {
    el.dataset.id = openings[i].opening.id;
    if (openDetails.has(el.dataset.id)) el.querySelector("details").open = true;
  });
  renderStats(openings);
  renderMessages(openings);
}

$("#openings").addEventListener("click", async (event) => {
  const id = event.target.dataset?.cancel;
  if (!id) return;
  const reason = prompt("Why is this opening no longer available?", "Stylist is no longer available");
  if (reason === null) return;
  await api(`/api/openings/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason } });
  await refreshOpenings();
});

// ---- Waitlist ----------------------------------------------------------------------------
async function refreshWaitlist() {
  const list = await api("/api/waitlist");
  $("#waitlist").innerHTML = `<ul class="waitlist">${list
    .map(
      (c) => `<li><div><strong>${esc(c.name)}</strong> <span class="muted small">${esc(c.phone)}</span><br />
        <span class="small">${esc(c.service)} · ${c.stylist === "Any" ? "any stylist" : esc(c.stylist)} ·
        ${c.days.length === 7 ? "any day" : esc(c.days.join(", "))} ${esc(c.from)}–${esc(c.to)}</span></div>
        <button class="link" data-remove="${esc(c.id)}" title="Remove from waitlist">Remove</button></li>`,
    )
    .join("")}</ul>`;
}

$("#waitlist").addEventListener("click", async (event) => {
  const id = event.target.dataset?.remove;
  if (!id || !confirm("Remove this client from the waitlist?")) return;
  await api(`/api/waitlist/${id}`, { method: "DELETE" });
  await Promise.all([refreshWaitlist(), updatePreview()]);
});

$("#waitlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = Object.fromEntries(form);
  body.days = form.getAll("days");
  try {
    await api("/api/waitlist", { method: "POST", body });
    event.target.reset();
    await Promise.all([refreshWaitlist(), updatePreview()]);
  } catch (error) {
    alert(error.message);
  }
});

// ---- Setup ------------------------------------------------------------------------------
async function init() {
  const config = await api("/api/config");
  const options = (values) => values.map((v) => `<option>${esc(v)}</option>`).join("");
  $("#service").innerHTML = options(config.services);
  $("#stylist").innerHTML = options(config.stylists);
  $("#window").innerHTML = config.windowChoices
    .map((m) => `<option value="${m}" ${m === 60 ? "selected" : ""}>${m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}</option>`)
    .join("");
  $("#wl-service").innerHTML = options(config.services);
  $("#wl-stylist").innerHTML = options(["Any", ...config.stylists]);
  $("#wl-days").innerHTML = DAYS.map((d) => `<label><input type="checkbox" name="days" value="${d}" checked /> ${d}</label>`).join("");
  $("#demo-note").hidden = !config.demoMode;
  $("#service").value = "Color";

  // Default to a same-day slot about two hours out, on a quarter hour.
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  $("#opening-form").date.value = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  $("#opening-form").time.value = `${pad(start.getHours())}:${pad(start.getMinutes())}`;

  await Promise.all([refreshWaitlist(), updatePreview(), refreshOpenings()]);
  setInterval(() => refreshOpenings().catch(console.error), 1000);
}

init().catch((error) => {
  $("#openings").innerHTML = `<p class="error">Can't reach the app: ${esc(error.message)}</p>`;
});

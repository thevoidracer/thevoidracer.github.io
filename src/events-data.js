// Team event calendar. Used to be a hand-curated data/events.json file
// (Nitro Type doesn't publish a per-team event/tournament schedule the way
// its season dates are public); now events live in the `events` table
// (see schema.sql), writable by a verified team's real captain straight
// from that team's Events page (src/client/app.js's renderCaptainManager),
// so this module just queries that table instead of reading a file.
//
// This is still only the BUILD-TIME (or server.js per-request) snapshot,
// rendered for a fast first paint and for anyone without JavaScript -
// src/client/app.js re-fetches live on page load so a change a captain
// just made is visible immediately, not just after the next site rebuild.

// Pending (hasn't started), Active (happening now), or Ended - computed
// fresh against the current time rather than stored, so it's always
// accurate as of whenever the page was generated/requested.
function eventStatus(ev, now = new Date()) {
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (now < start) return "pending";
  if (now > end) return "ended";
  return "active";
}

// Events for a given team tag, newest-starting first.
async function eventsForTeam(pool, tag) {
  const now = new Date();
  const { rows } = await pool.query(
    `select title, description, start_stamp as start, end_stamp as end
     from events where team_tag = $1 order by start_stamp desc`,
    [tag]
  );
  return rows.map((ev) => ({ ...ev, status: eventStatus(ev, now) }));
}

module.exports = { eventsForTeam, eventStatus };

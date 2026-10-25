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

// Every event across every tracked team, for the site-wide Events viewer
// (see theme.js's eventsViewerBody) - a captain/admin still schedules
// events from their OWN Team Admin page (same as always), but with 130+
// teams tracked there was no single place to see what's happening across
// all of them without visiting each team's page one at a time. Ordered
// live-first (soonest-ending live event first), then upcoming (soonest-
// starting first), then recently-ended last (most-recently-ended first) -
// computed with a CASE on the current time rather than stored, same
// "always accurate as of whenever this was generated" approach as
// eventStatus above.
async function allEvents(pool) {
  const now = new Date();
  const { rows } = await pool.query(
    `select e.title, e.description, e.start_stamp as start, e.end_stamp as end,
            e.team_tag, t.display_name as team_name, t.tag_color as team_color, t.team_emoji as team_emoji
     from events e
     join teams t on t.tag = e.team_tag
     order by
       case
         when now() between e.start_stamp and e.end_stamp then 0
         when e.start_stamp > now() then 1
         else 2
       end,
       case when now() between e.start_stamp and e.end_stamp then e.end_stamp end asc,
       case when e.start_stamp > now() then e.start_stamp end asc,
       case when e.end_stamp <= now() then e.end_stamp end desc`
  );
  return rows.map((ev) => ({ ...ev, status: eventStatus(ev, now) }));
}

module.exports = { eventsForTeam, allEvents, eventStatus };

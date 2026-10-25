// Team tournament calendar + standings - the schema and ownership model
// are identical to src/events-data.js's events (see team_tournaments in
// schema.sql), with one addition: each tournament also gets a standings
// table computed from the racer_points ledger (see
// queryTournamentStandings in leaderboard-data.js). Kept as its own module
// rather than folded into events-data.js since the standings half pulls in
// leaderboard-data.js, which events has no reason to depend on.
const { eventStatus } = require("./events-data");
const { queryTournamentStandings } = require("./leaderboard-data");

// Tournaments for a given team tag, newest-starting first - same shape
// events-data.js's eventsForTeam returns, plus `id` (tournaments need it to
// look up each one's standings and, client-side, to delete by id - events
// never exposed one because nothing client-side needed to target a single
// event row by id until now).
async function tournamentsForTeam(pool, tag) {
  const now = new Date();
  const { rows } = await pool.query(
    `select id, title, description, start_stamp as start, end_stamp as end
     from team_tournaments where team_tag = $1 order by start_stamp desc`,
    [tag]
  );
  return rows.map((t) => ({ ...t, status: eventStatus(t, now) }));
}

// { [tournamentId]: standingsRows } for every tournament passed in - one
// query per tournament (there's no indexed way to window-aggregate several
// different [start,end] ranges in a single grouped query), but a team only
// ever has a handful of tournaments at once, so this stays cheap.
async function standingsForTournaments(pool, teamTag, tournaments) {
  const byId = {};
  for (const t of tournaments) {
    byId[t.id] = await queryTournamentStandings(pool, teamTag, t.start, t.end);
  }
  return byId;
}

module.exports = { tournamentsForTeam, standingsForTournaments };

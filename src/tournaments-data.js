// Team tournament brackets - a captain-scheduled, multi-round single-
// elimination bracket (Seeding, Round of 64, ... Championship) spanning
// one or more participating teams (see team_tournaments/tournament_teams/
// tournament_rounds in schema.sql). Nothing about seeding or who won a
// round is stored: buildBracket recomputes the whole thing live, every
// time, straight from the racer_points ledger - the same "derive it live"
// approach queryRacerPoints/queryTeamPoints in leaderboard-data.js already
// use for every other board on this site. That means a tournament's
// bracket always reflects the latest sync automatically, with no seeding/
// advancement state that could ever drift out of sync with the real data.
const { eventStatus } = require("./events-data");

// The fixed round template StarTrack's own tournament feature uses -
// Seeding (no elimination, just a window to rank entrants) followed by
// however many of the elimination rounds the captain configures. `size`
// is how many entrants ENTER that round (so Round of 64 has 32 matches,
// Championship's 2 entrants decide the one match that crowns a winner).
const BRACKET_ROUNDS = [
  { key: "seeding", order: 0, label: "Seeding", size: null },
  { key: "r64", order: 1, label: "Round of 64", size: 64 },
  { key: "r32", order: 2, label: "Round of 32", size: 32 },
  { key: "r16", order: 3, label: "Sweet 16", size: 16 },
  { key: "r8", order: 4, label: "Elite 8", size: 8 },
  { key: "r4", order: 5, label: "Final 4", size: 4 },
  { key: "championship", order: 6, label: "Championship", size: 2 },
];

const SCORING_FIELDS = {
  points: "Points",
  races: "Races",
  avg_speed: "Avg speed",
  accuracy: "Accuracy",
};

// Tournaments owned by (created by) this team, each with its participant
// teams and round schedule attached. "Owned by" only decides who can edit
// it (see schema.sql's RLS) - the entrants themselves can come from any of
// the tournament's participant teams, not just this one.
async function tournamentsForTeam(pool, tag) {
  const { rows } = await pool.query(
    `select id, title, description, start_stamp as start, end_stamp as end,
            scoring_field, qualifying_races
     from team_tournaments where team_tag = $1 order by start_stamp desc`,
    [tag]
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [{ rows: teamRows }, { rows: roundRows }] = await Promise.all([
    pool.query(`select tournament_id, team_tag from tournament_teams where tournament_id = any($1::bigint[])`, [ids]),
    pool.query(
      `select tournament_id, round_key, round_order, label, start_stamp as start, end_stamp as end
       from tournament_rounds where tournament_id = any($1::bigint[]) order by round_order`,
      [ids]
    ),
  ]);
  const teamsById = {};
  teamRows.forEach((r) => {
    (teamsById[r.tournament_id] = teamsById[r.tournament_id] || []).push(r.team_tag);
  });
  const roundsById = {};
  roundRows.forEach((r) => {
    (roundsById[r.tournament_id] = roundsById[r.tournament_id] || []).push(r);
  });
  const now = new Date();
  return rows.map((t) => ({
    ...t,
    teams: teamsById[t.id] || [tag],
    rounds: roundsById[t.id] || [],
    status: eventStatus(t, now),
  }));
}

function scoreFor(row, field) {
  const v = row ? row[field] : null;
  return v == null ? 0 : Number(v);
}

// Every eligible racer (from the given team tags) with their aggregate
// stats over [startStamp, endStamp] - zero-filled (via the left join) for
// anyone who raced nothing in that window, so they still show up as a
// legitimate (if scoreless) entrant rather than being silently dropped.
// Same races-weighted avg_speed/accuracy formula queryTeamPoints uses.
async function queryEntrantScores(pool, teamTags, startStamp, endStamp) {
  if (!teamTags.length) return [];
  const { rows } = await pool.query(
    `select r.nt_user_id, r.username, r.display_name, r.team_tag, r.car_id, r.car_hue_angle,
            coalesce(sum(rp.points), 0) as points,
            coalesce(sum(rp.races_delta), 0) as races,
            round(
              sum(rp.races_delta * rp.avg_speed) filter (where rp.avg_speed is not null)
              / nullif(sum(rp.races_delta) filter (where rp.avg_speed is not null), 0)
            , 1) as avg_speed,
            round(
              sum(rp.races_delta * rp.accuracy) filter (where rp.accuracy is not null)
              / nullif(sum(rp.races_delta) filter (where rp.accuracy is not null), 0)
            , 2) as accuracy
     from racers r
     left join racer_points rp
       on rp.nt_user_id = r.nt_user_id
      and rp.captured_at >= $2
      and rp.captured_at <= least($3::timestamptz, now())
     where r.team_tag = any($1::text[])
     group by r.nt_user_id, r.username, r.display_name, r.team_tag, r.car_id, r.car_hue_angle`,
    [teamTags, startStamp, endStamp]
  );
  return rows;
}

// Same aggregate, scoped to a specific set of nt_user_ids rather than a
// team - used to score one round's matches without pulling in every other
// racer on the participating teams.
async function queryEntrantScoresByIds(pool, ntUserIds, startStamp, endStamp) {
  if (!ntUserIds.length) return [];
  const { rows } = await pool.query(
    `select r.nt_user_id,
            coalesce(sum(rp.points), 0) as points,
            coalesce(sum(rp.races_delta), 0) as races,
            round(
              sum(rp.races_delta * rp.avg_speed) filter (where rp.avg_speed is not null)
              / nullif(sum(rp.races_delta) filter (where rp.avg_speed is not null), 0)
            , 1) as avg_speed,
            round(
              sum(rp.races_delta * rp.accuracy) filter (where rp.accuracy is not null)
              / nullif(sum(rp.races_delta) filter (where rp.accuracy is not null), 0)
            , 2) as accuracy
     from racers r
     left join racer_points rp
       on rp.nt_user_id = r.nt_user_id
      and rp.captured_at >= $2
      and rp.captured_at <= least($3::timestamptz, now())
     where r.nt_user_id = any($1::bigint[])
     group by r.nt_user_id`,
    [ntUserIds, startStamp, endStamp]
  );
  return rows;
}

// Standard single-elimination seeding order - seed 1 and seed N (the
// weakest qualifier) share a bracket half, not 1v2/3v4 - so the top seeds
// can only meet in later rounds. E.g. size 8 -> [1,8,4,5,2,7,3,6] (1-based
// seed numbers). Returns 0-based indexes into a seed-ranked entrant array,
// in bracket-slot order.
function standardSeedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const len = order.length * 2 + 1;
    const next = [];
    for (const s of order) next.push(s, len - s);
    order = next;
  }
  return order.map((s) => s - 1);
}

// One match's outcome. A bye (only one side ever showed up - the bracket
// size exceeded how many racers actually qualified) always resolves
// immediately, independent of timing. Otherwise nothing is decided until
// the round's own end_stamp has passed - live scores can flip right up to
// the close, so no winner (and nothing for the next round to advance) is
// shown before then, even if one side is ahead.
function resolveMatch(a, b, byId, field, qualifying, started, ended) {
  if (!a && !b) return { a: null, b: null, winner: null, status: "empty" };
  if (a && !b) return { a, b: null, winner: a, status: "bye" };
  if (!a && b) return { a: null, b, winner: b, status: "bye" };
  if (!started) return { a, b, winner: null, status: "upcoming" };

  const rowA = byId[a.nt_user_id] || { races: 0 };
  const rowB = byId[b.nt_user_id] || { races: 0 };
  const qualA = Number(rowA.races || 0) >= qualifying;
  const qualB = Number(rowB.races || 0) >= qualifying;
  const scoreA = qualA ? scoreFor(rowA, field) : 0;
  const scoreB = qualB ? scoreFor(rowB, field) : 0;
  const a2 = { ...a, score: scoreA, races: Number(rowA.races || 0), qualified: qualA };
  const b2 = { ...b, score: scoreB, races: Number(rowB.races || 0), qualified: qualB };

  if (!ended) return { a: a2, b: b2, winner: null, status: "live" };
  if (scoreA === scoreB) return { a: a2, b: b2, winner: null, status: "tied" };
  return { a: a2, b: b2, winner: scoreA > scoreB ? a2 : b2, status: "final" };
}

// The whole bracket for one tournament: seeds the entrant pool from the
// Seeding round's window (ranked by the tournament's chosen scoring field,
// filtered by its qualifying-races minimum), pairs them in standard
// seeding order, then walks each elimination round in sequence, scoring
// every match from that round's own window and advancing winners (null
// until a round ends) into the next round. Returns null if the tournament
// has no Seeding round or no elimination rounds configured yet (schedule
// still incomplete).
async function buildBracket(pool, tournament) {
  const rounds = (tournament.rounds || []).slice().sort((x, y) => x.round_order - y.round_order);
  const seedingRound = rounds.find((r) => r.round_key === "seeding");
  const elimRounds = rounds.filter((r) => r.round_key !== "seeding");
  if (!seedingRound || !elimRounds.length) return null;

  const template = BRACKET_ROUNDS.find((b) => b.key === elimRounds[0].round_key);
  const bracketSize = template && template.size ? template.size : 2 ** elimRounds.length;
  const field = SCORING_FIELDS[tournament.scoring_field] ? tournament.scoring_field : "points";
  const qualifying = tournament.qualifying_races || 0;
  const teamTags = tournament.teams && tournament.teams.length ? tournament.teams : [];

  const now = new Date();
  const seedingOpen = new Date(seedingRound.start).getTime() <= now.getTime();
  const seedPool = seedingOpen
    ? (await queryEntrantScores(pool, teamTags, seedingRound.start, seedingRound.end))
        .filter((row) => Number(row.races) >= qualifying)
        .sort((a, b) => scoreFor(b, field) - scoreFor(a, field))
        .slice(0, bracketSize)
    : [];

  const order = standardSeedOrder(bracketSize);
  let ordered = order.map((seedIdx) => (seedPool[seedIdx] ? { ...seedPool[seedIdx], seed: seedIdx + 1 } : null));

  const roundsOut = [];
  for (const round of elimRounds) {
    const started = new Date(round.start).getTime() <= now.getTime();
    const ended = new Date(round.end).getTime() <= now.getTime();
    const ids = started ? ordered.filter(Boolean).map((e) => e.nt_user_id) : [];
    const scoreRows = ids.length ? await queryEntrantScoresByIds(pool, ids, round.start, round.end) : [];
    const byId = {};
    scoreRows.forEach((r) => {
      byId[r.nt_user_id] = r;
    });

    const matches = [];
    for (let i = 0; i < ordered.length; i += 2) {
      matches.push(resolveMatch(ordered[i], ordered[i + 1] || null, byId, field, qualifying, started, ended));
    }
    roundsOut.push({ round, matches });
    ordered = matches.map((m) => m.winner);
  }

  return { bracketSize, seeded: seedingOpen, roundsOut };
}

async function bracketsForTournaments(pool, tournaments) {
  const byId = {};
  for (const t of tournaments) {
    byId[t.id] = await buildBracket(pool, t);
  }
  return byId;
}

module.exports = {
  BRACKET_ROUNDS,
  SCORING_FIELDS,
  tournamentsForTeam,
  bracketsForTournaments,
};

// Shared leaderboard queries, used by both build.js (static site) and
// server.js (local preview) so the two never compute rankings differently
// - only the surrounding page (pageShell call) differs between them.
//
// Every board here sums the racer_points ledger (see schema.sql). Most are
// filtered to a rolling time window ("now() - interval"), not a calendar-
// aligned bucket (midnight-to-midnight, etc) - rolling windows sidestep
// timezone edge cases and are simpler to verify: "last 24 hours" always
// means exactly that. "seasonal" is the one exception: it uses Nitro
// Type's own real season boundary (see src/season.js and the `seasons`
// table) rather than a rolling duration, since that's a real, dated
// period NT itself publishes - not one we'd be inventing.
const RANGE_INTERVALS = {
  hourly: "1 hour",
  daily: "1 day",
  weekly: "7 days",
  monthly: "30 days",
  // Not a real "forever" - just long enough to include every row, since
  // racer_points only ever holds rows from after this feature shipped.
  alltime: "100 years",
};

const BUILT_RANGES = ["hourly", "daily", "weekly", "monthly", "seasonal", "alltime"];

// Nitro Type's currently active season (latest by start date), with its
// end clipped to now() so a season that has already ended stops growing.
// Null if src/season.js hasn't synced one yet.
async function currentSeasonBounds(pool) {
  const { rows } = await pool.query(
    `select season_id, name, start_stamp, least(end_stamp, now()) as end_bound, end_stamp
     from seasons
     order by start_stamp desc
     limit 1`
  );
  return rows[0] || null;
}

// Builds the WHERE clause + params for a range: seasonal uses the real
// season's absolute [start, end] bounds; everything else is a rolling
// "now() - interval" window. paramOffset lets the caller's own params
// (already using $1, $2, ...) come first.
function rangeFilter(range, season, paramOffset) {
  if (range === "seasonal") {
    if (!season) return null; // no season synced yet - caller returns empty
    return {
      clause: `rp.captured_at >= $${paramOffset + 1} and rp.captured_at <= $${paramOffset + 2}`,
      params: [season.start_stamp, season.end_bound],
    };
  }
  return {
    clause: `rp.captured_at >= now() - $${paramOffset + 1}::interval`,
    params: [RANGE_INTERVALS[range]],
  };
}

// teamTag (optional) scopes this to one team's own racers - used by the
// per-team Tracker page (src/theme.js's trackerBody) so it can reuse the
// exact same points ledger and rolling/season windows as the site-wide
// leaderboard instead of a separate query path.
async function queryRacerPoints(pool, range, season, teamTag) {
  const filter = rangeFilter(range, season, 0);
  if (!filter) return [];
  let clause = filter.clause;
  let params = filter.params;
  if (teamTag) {
    params = [...params, teamTag];
    clause += ` and r.team_tag = $${params.length}`;
  }
  const { rows } = await pool.query(
    `select r.username, r.display_name, r.team_tag, t.tag_color,
            r.car_id, r.car_hue_angle,
            sum(rp.points) as points,
            sum(rp.races_delta) as races,
            s.avg_speed, s.top_speed, s.accuracy
     from racer_points rp
     join racers r on r.nt_user_id = rp.nt_user_id
     join teams t on t.tag = r.team_tag
     left join lateral (
       select * from racer_stats rs where rs.nt_user_id = r.nt_user_id
       order by captured_at desc limit 1
     ) s on true
     where ${clause}
     group by r.username, r.display_name, r.team_tag, t.tag_color, r.car_id, r.car_hue_angle, s.avg_speed, s.top_speed, s.accuracy
     having sum(rp.points) > 0
     order by points desc
     limit 100`,
    params
  );
  return rows;
}

// Ranges shown on a team's own Tracker page - reuses the same keys/windows
// as the site-wide leaderboard (see RANGE_INTERVALS/currentSeasonBounds
// above) so "Season" here and "Seasonal" there never disagree.
const TRACKER_RANGES = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "seasonal", label: "Season" },
  { key: "alltime", label: "All-Time" },
];

async function loadTeamTracker(pool, tag) {
  const season = await currentSeasonBounds(pool);
  const byRange = {};
  for (const range of TRACKER_RANGES) {
    byRange[range.key] = await queryRacerPoints(pool, range.key, season, tag);
  }
  return { byRange, season };
}

// Team WPM/Accuracy are races-weighted averages over the window (each
// sync's rate counted once per race it covered), computed with FILTER so
// rows written before racer_points had avg_speed/accuracy (never
// backfilled) are excluded from the average instead of nulling it out -
// while still counting fully toward races/points.
async function queryTeamPoints(pool, range, season) {
  const filter = rangeFilter(range, season, 0);
  if (!filter) return [];
  const { rows } = await pool.query(
    `select t.tag, t.display_name, t.tag_color, t.team_emoji,
            sum(rp.points) as points,
            sum(rp.races_delta) as races,
            count(distinct rp.nt_user_id) as racer_count,
            round(
              sum(rp.races_delta * rp.avg_speed) filter (where rp.avg_speed is not null)
              / nullif(sum(rp.races_delta) filter (where rp.avg_speed is not null), 0)
            , 1) as avg_speed,
            round(
              sum(rp.races_delta * rp.accuracy) filter (where rp.accuracy is not null)
              / nullif(sum(rp.races_delta) filter (where rp.accuracy is not null), 0)
            , 2) as accuracy
     from racer_points rp
     join teams t on t.tag = rp.team_tag
     where ${filter.clause}
     group by t.tag, t.display_name, t.tag_color, t.team_emoji
     having sum(rp.points) > 0
     order by points desc`,
    filter.params
  );
  return rows;
}

// { racers: { hourly: [...], ... }, teams: { ... }, season: {...}|null } -
// the exact shape theme.js's leaderboardsBody() expects. `season` is
// passed through so the Seasonal panel can show its real name/dates.
async function loadLeaderboardData(pool) {
  const season = await currentSeasonBounds(pool);
  const racers = {};
  const teams = {};
  for (const range of BUILT_RANGES) {
    racers[range] = await queryRacerPoints(pool, range, season);
    teams[range] = await queryTeamPoints(pool, range, season);
  }
  return { racers, teams, season };
}

module.exports = {
  RANGE_INTERVALS,
  BUILT_RANGES,
  TRACKER_RANGES,
  currentSeasonBounds,
  queryRacerPoints,
  queryTeamPoints,
  loadLeaderboardData,
  loadTeamTracker,
};

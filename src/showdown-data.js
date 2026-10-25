// Team vs. team head-to-head "Showdown" events (see `showdowns` in
// schema.sql). A captain or admin schedules one against any other tracked
// team for a start/end window from their Team Admin page (team_a_tag is
// always the organizing side - team_b doesn't need to agree, same as how
// a captain can enter another team into their own tournament without that
// team's opt-in). The score itself is never stored - like every other
// board on this site it's recomputed live from the `racer_points` ledger
// every time the page is built/requested, scoped to just that window and
// those two teams. Modeled on Startrack's own Showdown feature (inspected
// live for the concept via Claude in Chrome, not scraped), but built on
// data TypeTrack already has for every one of its 130+ tracked teams
// rather than a hand-configured allies list - any two tracked teams can
// have a Showdown, not just ones you've pre-declared as allies.

// Fixed set, same four signals the Tournaments feature already lets a
// captain score rounds by (see SCORING_FIELDS in app.js) - no per-showdown
// customization, since the whole point is a quick, standard head-to-head.
const SHOWDOWN_CATEGORIES = [
  { key: "races", label: "Races" },
  { key: "avg_speed", label: "Avg speed" },
  { key: "accuracy", label: "Accuracy" },
  { key: "points", label: "Points" },
];

// Scheduled (hasn't started), Live (happening now), or Final - computed
// fresh against the current time rather than stored, same pattern as
// events-data.js's eventStatus.
function showdownStatus(sd, now = new Date()) {
  const start = new Date(sd.start_stamp);
  const end = new Date(sd.end_stamp);
  if (now < start) return "pending";
  if (now > end) return "ended";
  return "active";
}

// Same races-weighted avg_speed/accuracy formula as leaderboard-data.js's
// queryTeamPoints, just scoped to an arbitrary [start, end) window instead
// of one of the site's fixed named ranges - a showdown's window is
// whatever its creator picked when they set it up, not Hourly/Daily/etc.
async function queryTeamWindowStats(pool, teamTag, startStamp, endStamp) {
  const { rows } = await pool.query(
    `select
       coalesce(sum(rp.races_delta), 0) as races,
       coalesce(sum(rp.points), 0) as points,
       round(
         sum(rp.races_delta * rp.avg_speed) filter (where rp.avg_speed is not null)
         / nullif(sum(rp.races_delta) filter (where rp.avg_speed is not null), 0)
       , 1) as avg_speed,
       round(
         sum(rp.races_delta * rp.accuracy) filter (where rp.accuracy is not null)
         / nullif(sum(rp.races_delta) filter (where rp.accuracy is not null), 0)
       , 2) as accuracy
     from racer_points rp
     where rp.team_tag = $1 and rp.captured_at >= $2 and rp.captured_at < $3`,
    [teamTag, startStamp, endStamp]
  );
  const row = rows[0] || {};
  return {
    races: Number(row.races || 0),
    points: Number(row.points || 0),
    avg_speed: row.avg_speed == null ? null : Number(row.avg_speed),
    accuracy: row.accuracy == null ? null : Number(row.accuracy),
  };
}

// 1 point per category to whichever team is strictly ahead. A tie, or a
// category where either team has no qualifying data at all (e.g. no races
// with a recorded avg_speed in the window), awards neither side a point -
// same "no number is better than a misleading one" spirit used elsewhere
// on this site, rather than crowning a winner off of a coin flip.
function scoreCategories(statsA, statsB) {
  return SHOWDOWN_CATEGORIES.map((cat) => {
    const a = statsA[cat.key];
    const b = statsB[cat.key];
    let winner = null;
    if (a != null && b != null) {
      if (a > b) winner = "a";
      else if (b > a) winner = "b";
    }
    return { key: cat.key, label: cat.label, valueA: a, valueB: b, winner };
  });
}

function totalScore(categories) {
  let a = 0;
  let b = 0;
  for (const c of categories) {
    if (c.winner === "a") a++;
    else if (c.winner === "b") b++;
  }
  return { a, b };
}

// Full computed view of one showdown row - the public page and the Team
// Admin tab both call this rather than duplicating the scoring logic.
// Scores are shown live at every stage (Scheduled/Live/Final) rather than
// withheld until the window ends - unlike a tournament bracket there's no
// "wrong" intermediate state to flip-flop on here, just a running tally
// that's allowed to keep moving until the window closes.
async function computeShowdown(pool, sd) {
  const [statsA, statsB] = await Promise.all([
    queryTeamWindowStats(pool, sd.team_a_tag, sd.start_stamp, sd.end_stamp),
    queryTeamWindowStats(pool, sd.team_b_tag, sd.start_stamp, sd.end_stamp),
  ]);
  const categories = scoreCategories(statsA, statsB);
  const score = totalScore(categories);
  return { ...sd, status: showdownStatus(sd), statsA, statsB, categories, score };
}

// Every showdown on the site, newest-starting first - the data for the
// one site-wide Showdown page (see theme.js's showdownsBody). Unlike
// Events/Tournaments there's no per-team page for these, since a showdown
// always involves two teams and isn't really "owned" by just one side.
async function allShowdowns(pool) {
  const { rows } = await pool.query(
    `select s.id, s.team_a_tag, s.team_b_tag, s.title, s.start_stamp, s.end_stamp,
            ta.display_name as team_a_name, ta.tag_color as team_a_color, ta.team_emoji as team_a_emoji,
            tb.display_name as team_b_name, tb.tag_color as team_b_color, tb.team_emoji as team_b_emoji
     from showdowns s
     join teams ta on ta.tag = s.team_a_tag
     join teams tb on tb.tag = s.team_b_tag
     order by s.start_stamp desc`
  );
  return Promise.all(rows.map((sd) => computeShowdown(pool, sd)));
}

module.exports = {
  SHOWDOWN_CATEGORIES,
  showdownStatus,
  queryTeamWindowStats,
  scoreCategories,
  totalScore,
  computeShowdown,
  allShowdowns,
};

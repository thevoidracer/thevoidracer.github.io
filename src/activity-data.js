// Team activity: an hourly view of the last 24 hours, built from the same
// racer_points ledger every other board on this site already sums (see
// leaderboard-data.js) - no separate tracking table, just the existing
// "one row per sync per racer" history grouped into hour-sized buckets
// instead of one grand total, so a captain can see *when* the team races,
// not just how much. Modeled on Startrack's own Activity page, but built
// from this project's own data rather than scraping theirs.

// generate_series provides every hour slot (including ones with zero
// races) so a quiet hour shows as a real zero bar in the chart rather than
// being silently skipped - the left join then sums whatever racer_points
// rows actually fall in each bucket.
async function teamActivity(pool, tag) {
  const { rows: hourRows } = await pool.query(
    `select h as hour, coalesce(sum(rp.races_delta), 0) as races
     from generate_series(
       date_trunc('hour', now() - interval '23 hours'),
       date_trunc('hour', now()),
       interval '1 hour'
     ) h
     left join racer_points rp
       on rp.team_tag = $1
      and date_trunc('hour', rp.captured_at) = h
     group by h
     order by h`,
    [tag]
  );

  // Races-weighted avg_speed/accuracy - the same formula queryTeamPoints/
  // queryEntrantScores use elsewhere - so "who's been racing" here is
  // scored the same honest way as the Tracker and the Tournaments bracket.
  const { rows: racerRows } = await pool.query(
    `select r.nt_user_id, r.username, r.display_name, r.car_id, r.car_hue_angle,
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
     from racers r
     left join racer_points rp
       on rp.nt_user_id = r.nt_user_id
      and rp.captured_at >= now() - interval '24 hours'
     where r.team_tag = $1
     group by r.nt_user_id, r.username, r.display_name, r.car_id, r.car_hue_angle
     having coalesce(sum(rp.races_delta), 0) > 0
     order by races desc`,
    [tag]
  );

  const totalRaces = hourRows.reduce((sum, h) => sum + Number(h.races), 0);
  let busiestHour = null;
  let busiestCount = -1;
  for (const h of hourRows) {
    const races = Number(h.races);
    if (races > busiestCount) {
      busiestCount = races;
      busiestHour = h.hour;
    }
  }

  return {
    hours: hourRows,
    racers: racerRows,
    totalRaces,
    activeRacers: racerRows.length,
    busiestHour: totalRaces > 0 ? busiestHour : null,
  };
}

module.exports = { teamActivity };

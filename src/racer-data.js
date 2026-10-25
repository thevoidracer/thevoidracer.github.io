// A single racer's identity + latest synced snapshot - the data the
// per-racer stats page's hero needs. Points/races across every window
// come from leaderboard-data.js's loadRacerWindows, same ledger as every
// other board on this site, just scoped to this one person.
async function loadRacerProfile(pool, ntUserId) {
  const { rows } = await pool.query(
    `select r.nt_user_id, r.username, r.display_name, r.role, r.membership, r.joined_at_nt,
            r.car_id, r.car_hue_angle, r.team_tag,
            t.display_name as team_display_name, t.tag_color, t.team_emoji, t.captain_nt_user_id,
            r.squad_id, sq.name as squad_name, sq.color as squad_color,
            s.avg_speed, s.top_speed, s.races, s.accuracy, s.captured_at as stats_captured_at
     from racers r
     join teams t on t.tag = r.team_tag
     left join lateral (
       select * from racer_stats rs where rs.nt_user_id = r.nt_user_id
       order by captured_at desc limit 1
     ) s on true
     left join team_squads sq on sq.id = r.squad_id
     where r.nt_user_id = $1`,
    [ntUserId]
  );
  return rows[0] || null;
}

module.exports = { loadRacerProfile };

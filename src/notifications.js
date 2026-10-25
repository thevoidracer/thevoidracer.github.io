// Auto-detected per-team event feed - modeled on Startrack's Notifications
// page (ntstartrack.org/notifications?tag=...), which shows a daily digest
// of new members and race milestones. Ours works the same way but is
// entirely derived from data we already sync every run (no separate admin
// step, no manual curation): src/ingest.js calls recordNotifications() for
// every racer on every sync, diffing this sync's numbers against the
// racer's previous one. Nothing here is backfilled retroactively - a
// racer's first-ever sync establishes a baseline silently, exactly like
// racer_points, so adding a team to this tracker never floods its feed
// with "fake" milestones for races that happened before we were watching.
const { pool } = require("./db");

// Shared by both milestone kinds. Covers very active veteran racers too
// (NT's own in-game milestones go well past 100k lifetime races).
const MILESTONES = [
  500, 1000, 2500, 5000, 10000, 15000, 20000, 25000, 30000, 40000, 50000,
  75000, 100000, 150000, 200000, 250000, 300000, 400000, 500000, 750000,
  1000000,
];

// Every milestone strictly between `prev` and `curr` (inclusive of curr) -
// a racer who syncs rarely can cross more than one at once, and each still
// deserves its own notification.
function crossedMilestones(prev, curr) {
  if (prev == null || curr == null) return [];
  return MILESTONES.filter((m) => m > prev && m <= curr);
}

async function fetchPreviousTeamTag(userId) {
  const { rows } = await pool.query(`select team_tag from racers where nt_user_id = $1`, [userId]);
  return rows[0] ? rows[0].team_tag : null;
}

// Cumulative races_delta already recorded for this racer on this specific
// team, BEFORE this sync's row (if any) is inserted - "races for this
// team" per the same honest "since we started tracking" caveat used
// elsewhere on this site (not NT's own lifetime-for-team figure, which
// isn't exposed by its API).
async function fetchPreviousTeamRaces(userId, teamTag) {
  const { rows } = await pool.query(
    `select coalesce(sum(races_delta), 0) as total from racer_points where nt_user_id = $1 and team_tag = $2`,
    [userId, teamTag]
  );
  return Number(rows[0].total);
}

// See team_notification_settings in schema.sql - a captain or admin can
// turn off one of these three kinds for their own team from the Team
// Admin page's Notifications tab. No row for a (team, kind) means
// "enabled" (today's unconfigurable default, from before that table
// existed), so a missing row is NOT treated as disabled.
//
// Cached per (team_tag, kind) for the lifetime of this process - ingest.js
// runs one short-lived sync per invocation and calls recordNotification up
// to a few times per racer, so without this every racer on a team would
// re-query the same handful of settings rows. A setting changed mid-run
// (someone toggling it in another tab while a sync is in flight) simply
// takes effect starting with the NEXT sync, same as any other config read
// once per run elsewhere in this codebase (e.g. team sync_interval_minutes).
const notificationSettingsCache = new Map();

async function isNotificationKindEnabled(teamTag, kind) {
  const cacheKey = `${teamTag}\u0000${kind}`;
  if (notificationSettingsCache.has(cacheKey)) {
    return notificationSettingsCache.get(cacheKey);
  }
  const { rows } = await pool.query(
    `select enabled from team_notification_settings where team_tag = $1 and kind = $2`,
    [teamTag, kind]
  );
  const enabled = rows[0] ? rows[0].enabled : true;
  notificationSettingsCache.set(cacheKey, enabled);
  return enabled;
}

async function recordNotification(teamTag, { kind, userId, dedupKey, headline }) {
  if (!(await isNotificationKindEnabled(teamTag, kind))) return;
  await pool.query(
    `insert into notifications (team_tag, kind, nt_user_id, dedup_key, headline)
     values ($1, $2, $3, $4, $5)
     on conflict (team_tag, dedup_key) do nothing`,
    [teamTag, kind, userId ?? null, dedupKey, headline]
  );
}

// Called once per racer per sync, from ingest.js's ingestTeam loop - after
// upsertRacer/insertRacerStats/recordRacerPoints so the detection reads
// are the "before this sync" baseline. displayName is what shows up in the
// headline; racesPlayed/previousRaces mirror recordRacerPoints' own
// lifetime diff so the two never disagree about what counts as "new".
async function recordNotifications(teamTag, member, { displayName, racesPlayed, previousRaces, previousTeamTag, racesDelta }) {
  const name = displayName || member.username;

  // New member: either genuinely new to this tracker, or just switched
  // onto this team from another one we track. Both are worth a welcome,
  // and the unique (team_tag, dedup_key) constraint means a racer who
  // leaves and later rejoins the SAME team only gets welcomed once -
  // acceptable for v1 (matches Startrack's own one-shot "new member" model).
  if (previousTeamTag !== teamTag) {
    await recordNotification(teamTag, {
      kind: "new_member",
      userId: member.userID,
      dedupKey: `member-${member.userID}`,
      headline: `Welcome to ${teamTag}, ${name}!`,
    });
  }

  for (const m of crossedMilestones(previousRaces, racesPlayed)) {
    await recordNotification(teamTag, {
      kind: "lifetime_milestone",
      userId: member.userID,
      dedupKey: `lifetime-${member.userID}-${m}`,
      headline: `${name} just passed ${m.toLocaleString()} lifetime races!`,
    });
  }

  if (racesDelta > 0) {
    const previousTeamRaces = await fetchPreviousTeamRaces(member.userID, teamTag);
    const newTeamRaces = previousTeamRaces + racesDelta;
    for (const m of crossedMilestones(previousTeamRaces, newTeamRaces)) {
      await recordNotification(teamTag, {
        kind: "team_milestone",
        userId: member.userID,
        dedupKey: `team-${teamTag}-${member.userID}-${m}`,
        headline: `${name} has raced ${m.toLocaleString()} races for ${teamTag}!`,
      });
    }
  }
}

async function queryNotifications(pool, tag, limit = 60) {
  const { rows } = await pool.query(
    `select n.kind, n.headline, n.created_at, r.username as racer_username
     from notifications n
     left join racers r on r.nt_user_id = n.nt_user_id
     where n.team_tag = $1
     order by n.created_at desc
     limit $2`,
    [tag, limit]
  );
  return rows;
}

module.exports = {
  MILESTONES,
  crossedMilestones,
  fetchPreviousTeamTag,
  isNotificationKindEnabled,
  recordNotifications,
  queryNotifications,
};

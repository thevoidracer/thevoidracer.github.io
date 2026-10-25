// Static site generator: queries Supabase once, writes plain HTML into
// site/, which the "Deploy to GitHub Pages" workflow then publishes.
// No server stays running — this script runs on a GitHub Actions schedule
// instead, the same model as the single-team tracker's sync.js + Pages setup.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("./db");
const {
  escapeHtml,
  teamColor,
  textOnColor,
  formatDate,
  NAV_ITEMS,
  MANAGE_NAV_ITEMS,
  teamSidebar,
  comingSoonBody,
  racerRosterRows,
  leaderboardsBody,
  trackerBody,
  activityBody,
  eventsBody,
  tournamentsBody,
  showdownsBody,
  racerStatsBody,
  notificationsBody,
  teamAdminBody,
  pageShell,
  carImageSourceUrl,
  carImageLocalFile,
  nitroTypeTeamHref,
  teamEmojiSuffix,
} = require("./theme");
const { loadLeaderboardData, loadTeamTracker, loadTeamRacerWindows } = require("./leaderboard-data");
const { teamActivity } = require("./activity-data");
const { queryNotifications } = require("./notifications");
const { eventsForTeam } = require("./events-data");
const { tournamentsForTeam, bracketsForTournaments } = require("./tournaments-data");
const { allShowdowns } = require("./showdown-data");
const { accountIndexBody, accountConnectBody, signInBody } = require("./account-pages");

// A section page (teams/<tag>/<key>/index.html) sits one level deeper than
// the roster page, so a racer stats link from one of those needs its own
// "../" out to teams/<tag>/ before going into racer/<id>/.
const SECTION_RACER_HREF = (ntUserId) => `../racer/${ntUserId}/`;

// Built, non-roster sections render their own content from already-queried
// data; a section not in this map still falls back to comingSoonBody.
// Shared with server.js's per-request equivalent so static and live
// preview never render a section differently.
function sectionContent(key, sectionData) {
  if (key === "events") return eventsBody(sectionData.tag, sectionData.events);
  if (key === "tournaments") {
    // A tournament can span several teams, so an entrant's stats page may
    // live under a different team's own directory than this page - route
    // through the site root (teamsHref) rather than assuming "this team".
    const racerHref = (ntUserId, teamTag) => `../../../teams/${String(teamTag).toLowerCase()}/racer/${ntUserId}/`;
    return tournamentsBody(sectionData.tag, sectionData.tournaments, sectionData.brackets, "../../../assets/", racerHref);
  }
  // Section pages (teams/<tag>/<key>/index.html) sit one level deeper than
  // the roster page, so they need their own, one-level-further assetsHref.
  if (key === "trackers") return trackerBody(sectionData.tracker, "../../../assets/", SECTION_RACER_HREF);
  if (key === "activity") return activityBody(sectionData.tag, sectionData.activity, "../../../assets/", SECTION_RACER_HREF);
  if (key === "notifications") return notificationsBody(sectionData.tag, sectionData.notifications);
  if (key === "admin") return teamAdminBody(sectionData.tag, sectionData.captainNtUserId, sectionData.racers || [], sectionData.squads || [], sectionData.allTeams || []);
  return null;
}

const OUT_DIR = path.join(__dirname, "..", "site");

function buildTeamsIndex(teams) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const body = teams.length
    ? `<div class="index-header">
         <div>
           <h1>Browse teams</h1>
           <p class="meta-row">${teams.length} team${teams.length === 1 ? "" : "s"} tracked</p>
         </div>
         <div class="search-box">
           <input id="teamSearch" type="text" placeholder="Search teams…" autocomplete="off">
         </div>
       </div>
       <div class="grid" id="teamGrid">
         ${teams
           .map((t) => {
             const searchKey = `${t.tag} ${t.display_name || ""} ${t.captain_username || ""}`.toLowerCase();
             const badgeBg = teamColor(t.tag, t.tag_color);
             const teamHref = `teams/${encodeURIComponent(t.tag.toLowerCase())}/`;
             return `
             <div class="card" style="--card-accent:${badgeBg}" data-search="${escapeHtml(searchKey)}">
               <div class="top">
                 <a class="tag" href="${teamHref}">[${escapeHtml(t.tag)}]</a>
                 <a class="display-name" href="${nitroTypeTeamHref(t.tag)}" target="_blank" rel="noopener">${escapeHtml(t.display_name || "(unsynced)")}${teamEmojiSuffix(t.team_emoji)}</a>
               </div>
               ${t.captain_username ? `<div class="req-line">Captain: <b>${escapeHtml(t.captain_display_name || t.captain_username)}</b></div>` : ""}
               <div class="req-line">Members: <b>${t.members_count ?? "—"}</b> &nbsp;·&nbsp; Formed: <b>${formatDate(t.nt_created_at)}</b></div>
               ${t.min_races != null || t.min_speed != null
                 ? `<div class="req-line">Min: <b>${t.min_races ?? "—"} races</b> / <b>${t.min_speed ?? "—"} wpm</b></div>`
                 : ""}
               <a class="view-link" href="${teamHref}">View roster</a>
               <div class="footer">${t.last_synced_at ? `Synced ${new Date(t.last_synced_at).toLocaleString()}` : "Not synced yet"}</div>
             </div>`;
           })
           .join("")}
       </div>
       <script>
         (function () {
           var input = document.getElementById("teamSearch");
           var cards = Array.prototype.slice.call(document.querySelectorAll("#teamGrid .card"));
           input.addEventListener("input", function () {
             var q = input.value.trim().toLowerCase();
             cards.forEach(function (card) {
               var match = !q || card.getAttribute("data-search").indexOf(q) !== -1;
               card.style.display = match ? "" : "none";
             });
           });
         })();
       </script>`
    : `<h1>Browse teams</h1>
       <div class="empty">No teams yet — that's expected until the ingestion job adds some.</div>`;

  fs.writeFileSync(
    path.join(OUT_DIR, "index.html"),
    pageShell({ title: "TypeTrack", body, teamsHref: "./", leaderboardsHref: "leaderboards/", active: "teams" })
  );
}

// One racer's own stats page: teams/<tag>/racer/<id>/index.html, depth 2
// (two directories below teams/<tag>/ - see writeTeamSectionPage). `racer`
// is the same row racerRosterRows() already has (identity + latest
// racer_stats snapshot); `windows` is this racer's slice of the team's
// bulk-loaded loadTeamRacerWindows() result.
function buildRacerPage(team, racer, windows) {
  const dir = path.join(OUT_DIR, "teams", team.tag.toLowerCase(), "racer", String(racer.nt_user_id));
  fs.mkdirSync(dir, { recursive: true });
  const prefix = "../../"; // depth 2 -> back up to teams/<tag>/
  const assetsHref = "../../../../assets/";
  const name = racer.display_name || racer.username || "Racer";
  writeTeamSectionPage({
    dir,
    depth: 2,
    activeKey: "racer", // no NAV_ITEMS key matches - sidebar just shows nothing active
    content: racerStatsBody(racer, team, windows, assetsHref, () => prefix),
    crumb: `<a href="${prefix}">← [${team.tag}] roster</a>`,
    title: `[${team.tag}] ${name} — Stats`,
  });
}

function buildTeamPage(team, racers, sectionData) {
  const dir = path.join(OUT_DIR, "teams", team.tag.toLowerCase());
  fs.mkdirSync(dir, { recursive: true });

  const rosterRacerHref = (ntUserId) => `racer/${ntUserId}/`;
  const rows = racerRosterRows(racers, team, "../../assets/", rosterRacerHref);

  const reqBar = `
    <div class="req-bar">
      <div class="req">Members <b>${team.members_count ?? racers.length}</b></div>
      <div class="req">Formed <b>${formatDate(team.nt_created_at)}</b></div>
      <div class="req">Enrollment <b>${escapeHtml(team.enrollment || "—")}</b></div>
      <div class="req">Min races <b>${team.min_races ?? "—"}</b></div>
      <div class="req">Min speed <b>${team.min_speed ?? "—"} wpm</b></div>
      ${team.min_level != null ? `<div class="req">Min level <b>${team.min_level}</b></div>` : ""}
      ${team.discord_invite_url ? `<a class="req discord-invite" href="${escapeHtml(team.discord_invite_url)}" target="_blank" rel="noopener">Join Discord</a>` : ""}
    </div>`;

  const specialReqs = team.other_requirements
    ? `<div class="special-reqs">
         <div class="label">Special requirements</div>
         <div class="text">${escapeHtml(team.other_requirements)}</div>
       </div>`
    : "";

  const heroBg = teamColor(team.tag, team.tag_color);
  const hero = `
    <div class="hero" style="background:${heroBg};color:${textOnColor(heroBg)}">
      <div class="name">[${escapeHtml(team.tag)}] ${escapeHtml(team.display_name || "")}${teamEmojiSuffix(team.team_emoji)}</div>
      <div class="sub">
        ${team.captain_display_name || team.captain_username
          ? `Captain: ${escapeHtml(team.captain_display_name || team.captain_username)} · `
          : ""}${racers.length} racer${racers.length === 1 ? "" : "s"} tracked · last synced ${
        team.last_synced_at ? new Date(team.last_synced_at).toLocaleString() : "never"
      }</div>
    </div>`;

  const roster = `
    ${reqBar}
    ${specialReqs}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Racer</th><th>Joined</th><th>Points</th><th>Races</th><th>Avg speed</th><th>Highest speed</th><th>Accuracy</th><th>Last active</th></tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="8" style="color:var(--muted);">No racers synced yet.</td></tr>`}
        </tbody>
      </table>
    </div>`;

  writeTeamSectionPage({
    dir,
    depth: 0,
    activeKey: "roster",
    content: hero + roster,
    crumb: `<a href="../../">← all teams</a>`,
    title: `[${team.tag}] ${team.display_name || "team"}`,
  });

  // Every sidebar section besides Roster gets its own generated page -
  // real content for a built one (see sectionContent), an honest
  // "coming soon" placeholder otherwise, so the nav never points at a 404.
  const heroForSections = hero; // same hero banner on every section page
  for (const item of [...NAV_ITEMS, ...MANAGE_NAV_ITEMS]) {
    if (item.key === "roster") continue;
    const built = item.built ? sectionContent(item.key, sectionData) : null;
    const sectionDir = path.join(dir, item.key);
    fs.mkdirSync(sectionDir, { recursive: true });
    writeTeamSectionPage({
      dir: sectionDir,
      depth: 1,
      activeKey: item.key,
      content: heroForSections + (built ?? comingSoonBody(item.label)),
      crumb: `<a href="../../../">← all teams</a>`,
      title: `[${team.tag}] ${item.label}`,
    });
  }

  // One stats page per racer (see buildRacerPage) - sectionData.racerWindows
  // is the whole team's bulk-loaded loadTeamRacerWindows() result, sliced
  // per racer here so this doesn't re-query per racer.
  const racerWindows = sectionData.racerWindows;
  for (const racer of racers) {
    const byRange = {};
    for (const range of Object.keys(racerWindows.byRange)) {
      byRange[range] = racerWindows.byRange[range][racer.nt_user_id] || null;
    }
    buildRacerPage(team, racer, { byRange, season: racerWindows.season });
  }
}

// One page, four range tabs x two kinds = eight panels, toggled client-side
// (leaderboardControls' inline script) rather than as separate pages,
// since switching board/range shouldn't reload the page. Only All-Time is
// real data today - the rest are honest "coming soon" panels, same
// pattern as the team sidebar's unbuilt sections.
function buildLeaderboardsPage(data) {
  const dir = path.join(OUT_DIR, "leaderboards");
  fs.mkdirSync(dir, { recursive: true });

  // leaderboards/index.html and teams/<tag>/index.html sit at the same
  // depth (one directory under the site root), so a team page is reached
  // by stepping up one level and back down into teams/.
  const teamHref = (tag) => `../teams/${encodeURIComponent(tag.toLowerCase())}/`;
  const body = leaderboardsBody(data, teamHref, "../assets/");

  fs.writeFileSync(
    path.join(dir, "index.html"),
    pageShell({
      title: "Leaderboards — TypeTrack",
      body,
      crumb: `<a href="../">← all teams</a>`,
      teamsHref: "../",
      leaderboardsHref: "./",
      active: "leaderboards",
    })
  );
}

// Site-wide, same depth as /leaderboards/ (one directory under the site
// root) - a showdown always involves two teams, so it isn't reached
// through any single team's own section like Events/Tournaments are.
function buildShowdownPage(showdowns, teams) {
  const dir = path.join(OUT_DIR, "showdown");
  fs.mkdirSync(dir, { recursive: true });

  const teamHref = (tag) => `../teams/${encodeURIComponent(tag.toLowerCase())}/`;
  const body = showdownsBody(showdowns, teamHref);

  fs.writeFileSync(
    path.join(dir, "index.html"),
    pageShell({
      title: "Showdown — TypeTrack",
      body,
      crumb: `<a href="../">← all teams</a>`,
      teamsHref: "../",
      leaderboardsHref: "../leaderboards/",
      showdownHref: "./",
      active: "showdown",
    })
  );
}

// Account pages (sign up/in + connect-your-Nitro-Type-account) sit at
// site/account/ and site/account/connect/ - same "depth from site root"
// convention as everywhere else in this file, so pageShell's teamsHref
// derives accountHref/assetsHref for them exactly like every other page.
function buildAccountPages() {
  const dir = path.join(OUT_DIR, "account");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    pageShell({
      title: "Your account — TypeTrack",
      body: accountIndexBody({ signInHref: "sign-in/" }),
      crumb: `<a href="../">← all teams</a>`,
      teamsHref: "../",
      leaderboardsHref: "../leaderboards/",
      active: "account",
    })
  );

  const signInDir = path.join(dir, "sign-in");
  fs.mkdirSync(signInDir, { recursive: true });
  fs.writeFileSync(
    path.join(signInDir, "index.html"),
    pageShell({
      title: "Sign in — TypeTrack",
      body: signInBody({ accountHref: "../" }),
      crumb: `<a href="../">← account</a>`,
      teamsHref: "../../",
      leaderboardsHref: "../../leaderboards/",
      active: "account",
    })
  );

  // Kept only so an old /account/connect/ link still lands somewhere
  // sensible - see account-pages.js's accountConnectBody comment.
  const connectDir = path.join(dir, "connect");
  fs.mkdirSync(connectDir, { recursive: true });
  fs.writeFileSync(
    path.join(connectDir, "index.html"),
    pageShell({
      title: "Connect your Nitro Type account — TypeTrack",
      body: accountConnectBody({ accountHref: "../" }),
      crumb: `<a href="../">← account</a>`,
      teamsHref: "../../",
      leaderboardsHref: "../../leaderboards/",
      active: "account",
    })
  );
}

function writeTeamSectionPage({ dir, depth, activeKey, content, crumb, title }) {
  // depth 0 = this page is teams/<tag>/index.html, so "events" lives at
  // ./events/; depth 1 = teams/<tag>/<section>/index.html, so a sibling
  // section lives at ../<key>/ and roster is one level up; depth 2 is a
  // racer's own stats page (teams/<tag>/racer/<id>/index.html), two
  // directories below teams/<tag>/. Generalized via "../".repeat(depth) so
  // a deeper page (depth 2+) computes the same way instead of needing its
  // own special case.
  const prefix = "../".repeat(depth);
  const linkFor = (key) => (key === "roster" ? (depth === 0 ? "./" : prefix) : `${prefix}${key}/`);
  const body = `
    <div class="team-layout">
      ${teamSidebar(activeKey, linkFor)}
      <div class="team-content">${content}</div>
    </div>`;
  const teamsHref = "../".repeat(depth + 2);
  fs.writeFileSync(
    path.join(dir, "index.html"),
    pageShell({ title, body, crumb, teamsHref, leaderboardsHref: `${teamsHref}leaderboards/`, active: "teams" })
  );
}

// Nitro Type's own CDN returns HTTP 503 for a car image requested as a
// cross-site <img> embed (confirmed live: it distinguishes an embedded
// image load - Sec-Fetch-Dest: image - from a same-page fetch() or direct
// navigation, which both succeed), so hotlinking those URLs straight into
// our pages silently fails every time. We download each distinct car
// image once per build instead (a plain server-side fetch - the same kind
// that already works for ingest.js's API calls) and serve it from our own
// site/assets/cars/, which theme.js's carImageUrl points at. A download
// failure for one car just means that one racer's thumbnail quietly stays
// off (carThumb's onerror handles a missing file the same as an unmapped
// carId) - never fails the whole build.
async function downloadCarImages(pool) {
  const { rows } = await pool.query(
    `select distinct car_id, car_hue_angle from racers where car_id is not null`
  );
  const carsDir = path.join(OUT_DIR, "assets", "cars");
  fs.mkdirSync(carsDir, { recursive: true });

  const seen = new Set();
  let downloaded = 0;
  let failed = 0;
  for (const r of rows) {
    const sourceUrl = carImageSourceUrl(r.car_id, r.car_hue_angle);
    const localFile = carImageLocalFile(r.car_id, r.car_hue_angle);
    if (!sourceUrl || !localFile || seen.has(localFile)) continue;
    seen.add(localFile);
    const destPath = path.join(carsDir, localFile);
    if (fs.existsSync(destPath)) continue; // already cached from a previous build
    try {
      const res = await fetch(sourceUrl, {
        headers: { "User-Agent": "nitro-type-team-tracker/0.1 (+https://github.com/thevoidracer/thevoidracer.github.io)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buf);
      downloaded++;
    } catch (err) {
      failed++;
      console.warn(`Car image fetch failed for carId=${r.car_id} hue=${r.car_hue_angle} (${sourceUrl}): ${err.message}`);
    }
  }
  console.log(`Car images: ${downloaded} downloaded, ${failed} failed, ${seen.size - downloaded - failed} already cached.`);
}

async function main() {
  // Ordered the same way the "All-Time" team leaderboard ranks teams
  // (sum of every racer_points row, see leaderboard-data.js's
  // queryTeamPoints) - so a team's position in this list matches its
  // rank there. Teams with no points yet (not synced, or too new to
  // have earned any) sort to the back, alphabetically among themselves.
  const { rows: teams } = await pool.query(
    `select t.tag, t.display_name, t.last_synced_at,
            t.captain_username, t.captain_display_name, t.members_count, t.nt_created_at,
            t.min_races, t.min_speed, t.min_level, t.enrollment, t.other_requirements, t.tag_color,
            t.captain_nt_user_id, t.discord_invite_url, t.team_emoji
     from teams t
     left join (
       select team_tag, sum(points) as points from racer_points group by team_tag
     ) lb on lb.team_tag = t.tag
     order by coalesce(lb.points, 0) desc, t.tag`
  );
  buildTeamsIndex(teams);

  // The shared browser script (auth, connect-account flow, live events +
  // captain manager) is plain static JS - just copy it in, same idea as
  // everything else in this build script writing files into OUT_DIR.
  fs.mkdirSync(path.join(OUT_DIR, "assets"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "client", "app.js"), path.join(OUT_DIR, "assets", "app.js"));
  await downloadCarImages(pool);

  for (const team of teams) {
    const { rows: racers } = await pool.query(
      `select r.nt_user_id, r.username, r.display_name, r.role, r.membership, r.joined_at_nt,
              r.car_id, r.car_hue_angle, r.squad_id, sq.name as squad_name, sq.color as squad_color,
              s.avg_speed, s.top_speed, s.races, s.accuracy, s.captured_at as stats_captured_at,
              fs.races as first_races, fs.avg_speed as first_avg_speed, fs.accuracy as first_accuracy,
              coalesce(tp.races, 0) as tracked_races, coalesce(tp.points, 0) as tracked_points,
              lr.captured_at as last_raced_at
       from racers r
       left join lateral (
         select * from racer_stats rs
         where rs.nt_user_id = r.nt_user_id
         order by captured_at desc limit 1
       ) s on true
       left join lateral (
         select races, avg_speed, accuracy from racer_stats rs2
         where rs2.nt_user_id = r.nt_user_id
         order by captured_at asc limit 1
       ) fs on true
       left join (
         select nt_user_id, sum(races_delta) as races, sum(points) as points
         from racer_points
         where team_tag = $1
         group by nt_user_id
       ) tp on tp.nt_user_id = r.nt_user_id
       left join lateral (
         select captured_at from racer_points rp
         where rp.nt_user_id = r.nt_user_id
         order by captured_at desc limit 1
       ) lr on true
       left join team_squads sq on sq.id = r.squad_id
       where r.team_tag = $1
       order by coalesce(r.display_name, r.username)`,
      [team.tag]
    );
    // One row per squad, with how many of this team's racers currently
    // belong to it - purely for the admin squads list (see theme.js's
    // squadRows); "racers" above already has each racer's own squad_id
    // for the roster badge and the per-racer assignment dropdown.
    const { rows: squads } = await pool.query(
      `select sq.id, sq.name, sq.color,
              count(r.nt_user_id) filter (where r.nt_user_id is not null) as racer_count
       from team_squads sq
       left join racers r on r.squad_id = sq.id
       where sq.team_tag = $1
       group by sq.id, sq.name, sq.color
       order by sq.name`,
      [team.tag]
    );
    const tournaments = await tournamentsForTeam(pool, team.tag);
    const sectionData = {
      tag: team.tag,
      tracker: await loadTeamTracker(pool, team.tag),
      activity: await teamActivity(pool, team.tag),
      notifications: await queryNotifications(pool, team.tag),
      events: await eventsForTeam(pool, team.tag),
      tournaments,
      brackets: await bracketsForTournaments(pool, tournaments),
      captainNtUserId: team.captain_nt_user_id,
      racers,
      squads,
      allTeams: teams,
      racerWindows: await loadTeamRacerWindows(pool, team.tag),
    };
    buildTeamPage(team, racers, sectionData);
  }

  const leaderboardData = await loadLeaderboardData(pool);
  buildLeaderboardsPage(leaderboardData);
  buildShowdownPage(await allShowdowns(pool), teams);
  buildAccountPages();

  console.log(`Built ${teams.length} team page(s) into ${OUT_DIR}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Build failed:", err.message);
  process.exit(1);
});

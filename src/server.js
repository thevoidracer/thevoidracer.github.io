require("dotenv").config();
const path = require("path");
const express = require("express");
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
  racerStatsBody,
  notificationsBody,
  teamAdminBody,
  pageShell,
  nitroTypeTeamHref,
  teamEmojiSuffix,
} = require("./theme");
const { loadLeaderboardData, loadTeamTracker, loadRacerWindows } = require("./leaderboard-data");
const { teamActivity } = require("./activity-data");
const { loadRacerProfile } = require("./racer-data");
const { queryNotifications } = require("./notifications");
const { eventsForTeam } = require("./events-data");
const { tournamentsForTeam, bracketsForTournaments } = require("./tournaments-data");
const { accountIndexBody, accountConnectBody, signInBody } = require("./account-pages");

// Express routes are flat/absolute, so a racer's own stats page URL is
// always just /teams/<tag>/racer/<id> regardless of which team's page
// links to it (unlike build.js's relative paths, which differ by depth).
const racerHrefFor = (tag) => (ntUserId) => `/teams/${encodeURIComponent(tag)}/racer/${ntUserId}`;

// Built, non-roster sections render their own content - async because (unlike
// build.js, which pre-queries everything once per build) each request here
// hits the database live, so Trackers/Notifications can reflect a sync that
// just ran without waiting for the next scheduled rebuild.
async function sectionContent(key, tag, captainNtUserId) {
  if (key === "events") return eventsBody(tag, await eventsForTeam(pool, tag));
  if (key === "tournaments") {
    const tournaments = await tournamentsForTeam(pool, tag);
    const brackets = await bracketsForTournaments(pool, tournaments);
    // A tournament can span several teams, so an entrant's own stats page
    // may live under a different team than this one - take teamTag from
    // the entrant itself rather than assuming the page's own team.
    const racerHref = (ntUserId, teamTag) => `/teams/${encodeURIComponent(teamTag)}/racer/${ntUserId}`;
    return tournamentsBody(tag, tournaments, brackets, "/assets/", racerHref);
  }
  if (key === "trackers") return trackerBody(await loadTeamTracker(pool, tag), "/assets/", racerHrefFor(tag));
  if (key === "activity") return activityBody(tag, await teamActivity(pool, tag), "/assets/", racerHrefFor(tag));
  if (key === "notifications") return notificationsBody(tag, await queryNotifications(pool, tag));
  if (key === "admin") {
    const racers = await pool.query(
      "select nt_user_id, username, display_name, squad_id from racers where team_tag = $1 order by coalesce(display_name, username)",
      [tag]
    );
    const squads = await pool.query(
      `select sq.id, sq.name, sq.color,
              count(r.nt_user_id) filter (where r.nt_user_id is not null) as racer_count
       from team_squads sq
       left join racers r on r.squad_id = sq.id
       where sq.team_tag = $1
       group by sq.id, sq.name, sq.color
       order by sq.name`,
      [tag]
    );
    return teamAdminBody(tag, captainNtUserId, racers.rows, squads.rows);
  }
  return null;
}

// Express routes use fixed absolute paths (unlike build.js's relative,
// depth-aware ones), so the nav hrefs are the same on every page here -
// and pageShell can't derive account/assets from these the way it does
// for build.js's relative paths, so they're spelled out explicitly.
const SITE_NAV = {
  teamsHref: "/teams",
  leaderboardsHref: "/leaderboards",
  accountHref: "/account",
  assetsHref: "/assets/app.js",
};

const app = express();
const PORT = process.env.PORT || 3000;
app.use("/assets", express.static(path.join(__dirname, "client")));

// build.js's static site pre-downloads car thumbnails into site/assets/cars/
// because Nitro Type's CDN returns HTTP 503 for a cross-site <img> embed
// (see build.js's downloadCarImages for the full explanation). This dev
// server has no such pre-downloaded cache, so it proxies each request
// instead: fetch the image server-side (a plain fetch, same as that build
// step, which isn't blocked) and stream it back from our own origin. A
// failed fetch just 404s, which carThumb's onerror already handles the
// same as a missing/unmapped car.
app.get("/assets/cars/:file", async (req, res) => {
  const file = req.params.file;
  // Reverse carImageLocalFile's flattening: "painted-<slug>_small_<hue>.png"
  // -> "painted/<slug>_small_<hue>.png", everything else passes through.
  const slugFile = file.startsWith("painted-") ? `painted/${file.slice("painted-".length)}` : file;
  if (!/^[a-z0-9_]+(\/[a-z0-9_]+)?\.png$/i.test(slugFile)) return res.status(404).end();
  try {
    const upstream = await fetch(`https://www.nitrotype.com/cars/${slugFile}`, {
      headers: { "User-Agent": "nitro-type-team-tracker/0.1 (+https://github.com/thevoidracer/thevoidracer.github.io)" },
    });
    if (!upstream.ok) return res.status(404).end();
    res.type("png").send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(404).end();
  }
});

// Proves the whole stack is wired correctly: app is running AND can reach
// the real database. This is the one thing v0 has to get right before
// anything else gets built on top of it.
app.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query("select now() as db_time");
    res.type("html").send(
      pageShell({
        title: "TypeTrack",
        body: `
          <h1>It's alive.</h1>
          <p class="meta-row">App is running and the database connection works.</p>
          <p class="meta-row">Database time: <strong>${rows[0].db_time}</strong></p>
          <p><a href="/teams">View tracked teams →</a></p>`,
        ...SITE_NAV,
      })
    );
  } catch (err) {
    console.error("Database check failed:", err.message);
    res.status(500).send("App is running, but the database connection failed. Check DATABASE_URL.");
  }
});

// First proof that "team" is a parameter, not a hardcoded value: lists
// whatever teams exist in the database, however many there are (zero,
// until the ingestion job adds some).
app.get("/teams", async (req, res) => {
  try {
    // Ordered the same way the "All-Time" team leaderboard ranks teams
    // (sum of every racer_points row, see leaderboard-data.js's
    // queryTeamPoints) - teams with no points yet sort to the back,
    // alphabetically among themselves.
    const { rows } = await pool.query(
      `select t.tag, t.display_name, t.last_synced_at,
              t.captain_username, t.captain_display_name, t.members_count, t.nt_created_at,
              t.min_races, t.min_speed, t.tag_color, t.team_emoji
       from teams t
       left join (
         select team_tag, sum(points) as points from racer_points group by team_tag
       ) lb on lb.team_tag = t.tag
       order by coalesce(lb.points, 0) desc, t.tag`
    );
    const body = rows.length
      ? `<div class="index-header">
           <div>
             <h1>Browse teams</h1>
             <p class="meta-row">${rows.length} team${rows.length === 1 ? "" : "s"} tracked</p>
           </div>
           <div class="search-box">
             <input id="teamSearch" type="text" placeholder="Search teams…" autocomplete="off">
           </div>
         </div>
         <div class="grid" id="teamGrid">
           ${rows
             .map((t) => {
               const searchKey = `${t.tag} ${t.display_name || ""} ${t.captain_username || ""}`.toLowerCase();
               const badgeBg = teamColor(t.tag, t.tag_color);
               const teamHref = `/teams/${encodeURIComponent(t.tag)}`;
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
      : `<h1>Browse teams</h1><div class="empty">No teams yet — run the ingestion script to add some.</div>`;
    res.type("html").send(pageShell({ title: "Tracked teams", body, crumb: `<a href="/">← back</a>`, ...SITE_NAV, active: "teams" }));
  } catch (err) {
    console.error("Teams query failed:", err.message);
    res.status(500).send("Could not query teams.");
  }
});

// Generic team page — reads by tag, renders whatever is in the database
// for it. No hardcoded team anywhere in this file.
app.get("/teams/:tag", async (req, res) => {
  const tag = req.params.tag.toUpperCase();
  try {
    const team = await pool.query("select * from teams where tag = $1", [tag]);
    if (team.rows.length === 0) {
      return res.status(404).send(`No team with tag "${escapeHtml(tag)}" in the database yet.`);
    }
    const racers = await pool.query(
      `select r.nt_user_id, r.username, r.display_name, r.role, r.membership, r.joined_at_nt,
              r.car_id, r.car_hue_angle, sq.name as squad_name, sq.color as squad_color,
              s.avg_speed, s.top_speed, s.races, s.accuracy
       from racers r
       left join lateral (
         select * from racer_stats rs
         where rs.nt_user_id = r.nt_user_id
         order by captured_at desc limit 1
       ) s on true
       left join team_squads sq on sq.id = r.squad_id
       where r.team_tag = $1
       order by coalesce(r.display_name, r.username)`,
      [tag]
    );
    const t = team.rows[0];
    const rowsHtml = racerRosterRows(racers.rows, t, "/assets/", racerHrefFor(tag));

    const reqBar = `
      <div class="req-bar">
        <div class="req">Members <b>${t.members_count ?? racers.rows.length}</b></div>
        <div class="req">Formed <b>${formatDate(t.nt_created_at)}</b></div>
        <div class="req">Enrollment <b>${escapeHtml(t.enrollment || "—")}</b></div>
        <div class="req">Min races <b>${t.min_races ?? "—"}</b></div>
        <div class="req">Min speed <b>${t.min_speed ?? "—"} wpm</b></div>
        ${t.min_level != null ? `<div class="req">Min level <b>${t.min_level}</b></div>` : ""}
        ${t.discord_invite_url ? `<a class="req discord-invite" href="${escapeHtml(t.discord_invite_url)}" target="_blank" rel="noopener">Join Discord</a>` : ""}
      </div>`;

    const specialReqs = t.other_requirements
      ? `<div class="special-reqs">
           <div class="label">Special requirements</div>
           <div class="text">${escapeHtml(t.other_requirements)}</div>
         </div>`
      : "";

    const heroBg = teamColor(t.tag, t.tag_color);
    const hero = `
      <div class="hero" style="background:${heroBg};color:${textOnColor(heroBg)}">
        <div class="name">[${escapeHtml(t.tag)}] ${escapeHtml(t.display_name || "")}${teamEmojiSuffix(t.team_emoji)}</div>
        <div class="sub">
          ${t.captain_display_name || t.captain_username
            ? `Captain: ${escapeHtml(t.captain_display_name || t.captain_username)} · `
            : ""}${racers.rows.length} racer${racers.rows.length === 1 ? "" : "s"} tracked · last synced ${
          t.last_synced_at ? new Date(t.last_synced_at).toLocaleString() : "never"
        }</div>
      </div>`;

    const roster = `
      ${reqBar}
      ${specialReqs}
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Racer</th><th>Joined</th><th>Avg speed</th><th>Highest speed</th><th>Lifetime races</th><th>Accuracy</th></tr>
          </thead>
          <tbody>
            ${rowsHtml || `<tr><td colspan="6" style="color:var(--muted);">No racers synced yet.</td></tr>`}
          </tbody>
        </table>
      </div>`;

    const linkFor = (key) => (key === "roster" ? `/teams/${encodeURIComponent(tag)}` : `/teams/${encodeURIComponent(tag)}/${key}`);
    const body = `
      <div class="team-layout">
        ${teamSidebar("roster", linkFor)}
        <div class="team-content">${hero}${roster}</div>
      </div>`;

    res.type("html").send(
      pageShell({
        title: `[${t.tag}] ${t.display_name || "team"}`,
        body,
        crumb: `<a href="/teams">← all teams</a>`,
        ...SITE_NAV,
        active: "teams",
      })
    );
  } catch (err) {
    console.error("Team page query failed:", err.message);
    res.status(500).send("Could not load that team.");
  }
});

// Every sidebar section besides Roster - a built one renders real content
// (live-queried, see sectionContent), an unbuilt one gets the same
// "coming soon" placeholder the static site generates, so local preview
// and the deployed site always behave the same way.
app.get("/teams/:tag/:section", async (req, res) => {
  const tag = req.params.tag.toUpperCase();
  const section = req.params.section;
  const item = [...NAV_ITEMS, ...MANAGE_NAV_ITEMS].find((it) => it.key === section);
  if (!item) {
    return res.status(404).send("Not found.");
  }
  try {
    const team = await pool.query("select * from teams where tag = $1", [tag]);
    if (team.rows.length === 0) {
      return res.status(404).send(`No team with tag "${escapeHtml(tag)}" in the database yet.`);
    }
    const t = team.rows[0];
    const sectionHeroBg = teamColor(t.tag, t.tag_color);
    const hero = `
      <div class="hero" style="background:${sectionHeroBg};color:${textOnColor(sectionHeroBg)}">
        <div class="name">[${escapeHtml(t.tag)}] ${escapeHtml(t.display_name || "")}${teamEmojiSuffix(t.team_emoji)}</div>
      </div>`;
    const built = item.built ? await sectionContent(item.key, tag, t.captain_nt_user_id) : null;
    const linkFor = (key) => (key === "roster" ? `/teams/${encodeURIComponent(tag)}` : `/teams/${encodeURIComponent(tag)}/${key}`);
    const body = `
      <div class="team-layout">
        ${teamSidebar(item.key, linkFor)}
        <div class="team-content">${hero}${built ?? comingSoonBody(item.label)}</div>
      </div>`;
    res.type("html").send(
      pageShell({
        title: `[${t.tag}] ${item.label}`,
        body,
        crumb: `<a href="/teams">← all teams</a>`,
        ...SITE_NAV,
        active: "teams",
      })
    );
  } catch (err) {
    console.error("Team section page query failed:", err.message);
    res.status(500).send("Could not load that team.");
  }
});

// One racer's own stats page - identity + latest racer_stats snapshot
// (loadRacerProfile) plus their own points/races/avg speed/accuracy in
// every window this site tracks (loadRacerWindows), same ledger as every
// other board. Linked from the small 📊 icon next to a racer's name
// anywhere one appears (see theme.js's racerNameMarkup).
app.get("/teams/:tag/racer/:id", async (req, res) => {
  const tag = req.params.tag.toUpperCase();
  const ntUserId = Number(req.params.id);
  if (!Number.isInteger(ntUserId)) {
    return res.status(404).send("Not found.");
  }
  try {
    const racer = await loadRacerProfile(pool, ntUserId);
    if (!racer || racer.team_tag !== tag) {
      return res.status(404).send(`No racer with that id on team "${escapeHtml(tag)}".`);
    }
    const team = {
      tag: racer.team_tag,
      display_name: racer.team_display_name,
      tag_color: racer.tag_color,
      team_emoji: racer.team_emoji,
      captain_nt_user_id: racer.captain_nt_user_id,
    };
    const windows = await loadRacerWindows(pool, ntUserId);
    const teamHref = (t) => `/teams/${encodeURIComponent(t)}`;
    const linkFor = (key) => (key === "roster" ? teamHref(tag) : `${teamHref(tag)}/${key}`);
    const body = `
      <div class="team-layout">
        ${teamSidebar("racer", linkFor)}
        <div class="team-content">${racerStatsBody(racer, team, windows, "/assets/", teamHref)}</div>
      </div>`;
    res.type("html").send(
      pageShell({
        title: `[${tag}] ${racer.display_name || racer.username} — Stats`,
        body,
        crumb: `<a href="${teamHref(tag)}">← [${escapeHtml(tag)}] roster</a>`,
        ...SITE_NAV,
        active: "teams",
      })
    );
  } catch (err) {
    console.error("Racer stats page query failed:", err.message);
    res.status(500).send("Could not load that racer.");
  }
});

// Site-wide leaderboards: racers and teams ranked across everything this
// tracker follows (not all of Nitro Type - just the teams we ingest).
// Mirrors build.js's buildLeaderboardsPage via the shared leaderboardsBody
// helper in theme.js so local preview and the deployed static site never
// drift apart.
app.get("/leaderboards", async (req, res) => {
  try {
    const data = await loadLeaderboardData(pool);
    const teamHref = (tag) => `/teams/${encodeURIComponent(tag)}`;
    res.type("html").send(
      pageShell({
        title: "Leaderboards — TypeTrack",
        body: leaderboardsBody(data, teamHref, "/assets/"),
        crumb: `<a href="/teams">← all teams</a>`,
        ...SITE_NAV,
        active: "leaderboards",
      })
    );
  } catch (err) {
    console.error("Leaderboards query failed:", err.message);
    res.status(500).send("Could not load leaderboards.");
  }
});

// Account pages - mirrors build.js's buildAccountPages via the shared
// account-pages.js bodies, same reasoning as leaderboards above.
app.get("/account", (req, res) => {
  res.type("html").send(
    pageShell({
      title: "Your account — TypeTrack",
      body: accountIndexBody({ signInHref: "/account/sign-in" }),
      crumb: `<a href="/teams">← all teams</a>`,
      ...SITE_NAV,
      active: "account",
    })
  );
});

app.get("/account/sign-in", (req, res) => {
  res.type("html").send(
    pageShell({
      title: "Sign in — TypeTrack",
      body: signInBody({ accountHref: "/account" }),
      crumb: `<a href="/account">← account</a>`,
      ...SITE_NAV,
      active: "account",
    })
  );
});

app.get("/account/connect", (req, res) => {
  res.type("html").send(
    pageShell({
      title: "Connect your Nitro Type account — TypeTrack",
      body: accountConnectBody({ accountHref: "/account" }),
      crumb: `<a href="/account">← account</a>`,
      ...SITE_NAV,
      active: "account",
    })
  );
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});

// Shared look for every generated page (build.js's static site and
// server.js's local preview) — one place to change colors/layout instead
// of two copies of the same CSS drifting apart.
//
// Visual language borrowed from ntstartrack.org (the established
// community tool for this exact kind of page): dark panels, Manrope,
// small rounded cards, colored per-team accents, a clean data table.
// Nothing here copies its code, text, or any specific image/asset - just
// the general dark-UI/card/table conventions common to this kind of
// stats dashboard.

const { CAR_SLUGS } = require("./car-catalog.js");

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// A team's optional single emoji (set via its Team Admin Settings tab),
// shown right after its display name - a bare space when there isn't
// one, so callers can always just concatenate this in rather than
// branching themselves.
function teamEmojiSuffix(emoji) {
  return emoji ? ` ${escapeHtml(emoji)}` : "";
}

// Deterministic tag -> hue, so every team gets a stable, distinct accent
// color across visits/builds without storing one in the database.
function hashHue(str) {
  let h = 0;
  for (const ch of String(str)) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return h % 360;
}

// Nitro Type's own API returns a team's real "tagColor" (e.g. "5b52a3") -
// the exact same color shown on the team's actual NT page and the one
// StarTrack uses too. We use that verbatim, as a flat color (not a
// gradient we invented), so there's never any mismatch or confusion with
// the real team color. Only a team we haven't captured tagColor for yet
// falls back to a deterministic hash-based color.
function teamColor(tag, tagColor) {
  if (tagColor) return `#${String(tagColor).replace(/^#/, "")}`;
  return `hsl(${hashHue(tag)} 70% 38%)`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace(/^#/, ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

// A real team color can be light or dark, so the text on top of it (hero
// banner, card badge) has to be chosen per-color instead of hardcoded -
// otherwise a light tagColor would render near-invisible white-on-white.
function textOnColor(color) {
  if (!color.startsWith("#")) return "#ffffff"; // hash fallback is always dark enough
  return relativeLuminance(hexToRgb(color)) > 0.5 ? "#0b1220" : "#ffffff";
}

// Decorative per-racer avatar color (not a claim about team identity) -
// still hash-based since Nitro Type doesn't expose a per-racer color.
function avatarColor(seed) {
  return `hsl(${hashHue(seed)} 85% 65%)`;
}

// carId/hueAngle (from Nitro Type's team API, synced onto racers.car_id/
// car_hue_angle by ingest.js) -> the filename slug Nitro Type's own CDN
// uses for that car, or null if we don't have a slug for this carId
// (car-catalog.js is best-effort, not exhaustive - see its header comment).
function carImageSlugFile(carId, hueAngle) {
  if (carId == null) return null;
  const slug = CAR_SLUGS[carId];
  if (!slug) return null;
  return hueAngle ? `painted/${slug}_small_${hueAngle}.png` : `${slug}_small.png`;
}

// The actual image URL on Nitro Type's own CDN - used only by build.js to
// know what to download (see downloadCarImages). Never embedded directly
// in a page: Nitro Type's CDN returns HTTP 503 for cross-site <img>
// requests (confirmed live - it distinguishes an embedded image load from
// a same-page fetch/direct navigation, classic hotlink protection), so a
// hotlinked <img src="nitrotype.com/..."> silently fails every time. We
// download each car's image once at build time instead and serve it from
// our own site - see carImageUrl below.
function carImageSourceUrl(carId, hueAngle) {
  const file = carImageSlugFile(carId, hueAngle);
  return file ? `https://www.nitrotype.com/cars/${file}` : null;
}

// The locally-cached filename build.js saves a car's image under in
// site/assets/cars/ - flat (no subdirectory) so every page can reach it
// with the same "assets/cars/<name>" relative segment regardless of depth,
// the same convention pageShell already uses for assets/app.js.
function carImageLocalFile(carId, hueAngle) {
  const file = carImageSlugFile(carId, hueAngle);
  return file ? file.replace("painted/", "painted-") : null;
}

// assetsHref is the same "<teamsHref>assets/" prefix pageShell computes
// for app.js (see siteHeader/pageShell's assetsHref), so a car thumbnail
// resolves correctly from any page depth. null if we have no image for
// this racer's current car (unmapped carId, or car-catalog.js just
// doesn't have this one yet).
function carImageUrl(carId, hueAngle, assetsHref) {
  const file = carImageLocalFile(carId, hueAngle);
  return file ? `${assetsHref}cars/${file}` : null;
}

// A small car thumbnail to sit next to a racer's avatar/name, or "" if we
// have no locally-cached image for their current car. onerror="this.remove()"
// means a bad/stale/unmapped carId, or one build.js simply failed to
// download, just quietly omits the picture - never a visible broken-image
// icon - so an incomplete cache is a safe, low-risk thing to ship.
function carThumb(carId, hueAngle, assetsHref) {
  const url = carImageUrl(carId, hueAngle, assetsHref);
  if (!url) return "";
  return `<img class="car-thumb" src="${url}" alt="" loading="lazy" onerror="this.remove()">`;
}

// Bucket accuracy into a color class the same way a tier badge would -
// quick visual signal without requiring the viewer to read every number.
function accuracyClass(accuracy) {
  if (accuracy == null) return "na";
  if (accuracy >= 95) return "good";
  if (accuracy >= 90) return "ok";
  return "low";
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

// Thousands-separated display for every stat column (races, points,
// speeds) - "-" passes through unchanged so existing `?? "-"` fallbacks
// upstream don't need to change, they just get formatted on the way in.
function formatNumber(value) {
  if (value == null || value === "-" || value === "—") return value ?? "-";
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// "officer"/"member"/captain -> a small colored pill, the same visual
// slot a tier badge fills on a roster table: a quick, scannable status
// signal next to each name.
function roleBadge(role, isCaptain) {
  if (isCaptain) return `<span class="role-pill captain">Captain</span>`;
  if (role === "officer") return `<span class="role-pill officer">Officer</span>`;
  return "";
}

function membershipBadge(membership) {
  if (membership === "gold") return `<span class="role-pill gold">Gold</span>`;
  return "";
}

// A racer's squad (see team_squads in schema.sql) - name + captain-picked
// color, same visual slot as roleBadge/membershipBadge but with an
// arbitrary color (inline style, like lb-team-tag) instead of a fixed
// palette, since there's no limit on how many squads a team can make.
function squadBadge(squadName, squadColor) {
  if (!squadName) return "";
  const bg = squadColor || "#29d3ff";
  return `<span class="squad-pill" style="background:${escapeHtml(bg)}22;color:${escapeHtml(bg)};border-color:${escapeHtml(bg)}55;">${escapeHtml(squadName)}</span>`;
}

// Shared by build.js (static) and server.js (local preview) so a team's
// roster rows render identically in both - display_name is what the
// racer currently goes by on Nitro Type; username (often an opaque id
// string NT assigns, not a real handle) is only a fallback for a racer
// this tracker hasn't re-synced since display_name was added.
function racerRosterRows(racers, team, assetsHref = "/assets/", racerHref) {
  return racers
    .map((r) => {
      const name = r.display_name || r.username;
      const initial = (name || "?").slice(0, 1).toUpperCase();
      const accClass = accuracyClass(r.accuracy);
      const accLabel = r.accuracy == null ? "—" : `${r.accuracy}%`;
      const isCaptain = team.captain_username && r.username === team.captain_username;
      return `
        <tr>
          <td class="racer">
            <span class="avatar" style="background:${avatarColor(name || team.tag)}">${escapeHtml(initial)}</span>
            ${carThumb(r.car_id, r.car_hue_angle, assetsHref)}
            ${racerNameMarkup(name, r.username, r.nt_user_id != null && racerHref ? racerHref(r.nt_user_id) : null)}${roleBadge(r.role, isCaptain)}${membershipBadge(r.membership)}${squadBadge(r.squad_name, r.squad_color)}
          </td>
          <td>${formatDate(r.joined_at_nt)}</td>
          <td>${formatNumber(r.avg_speed ?? "-")}</td>
          <td>${formatNumber(r.top_speed ?? "-")}</td>
          <td>${formatNumber(r.races ?? "-")}</td>
          <td><span class="pill ${accClass}">${accLabel}</span></td>
        </tr>`;
    })
    .join("");
}

// Single source of truth for a team page's section sidebar. "roster" is
// the only one with real content right now; everything else gets a
// generated placeholder page (see build.js) so the sidebar shows the
// shape of where this project is headed without faking functionality -
// clicking one of these is honest about not being built yet.
const NAV_ITEMS = [
  { key: "roster", label: "Roster", icon: "\u{1F465}", built: true },
  { key: "events", label: "Events", icon: "\u{1F4C5}", built: true },
  { key: "activity", label: "Activity", icon: "\u{1F4C8}", built: true },
  { key: "tournaments", label: "Tournaments", icon: "\u{1F3C6}", built: true },
  { key: "trackers", label: "Trackers", icon: "\u{1F4CC}", built: true },
  { key: "notifications", label: "Notifications", icon: "\u{1F514}", built: true },
];
const MANAGE_NAV_ITEMS = [
  { key: "admin", label: "Team Admin", icon: "⚙️", built: true },
];

// Builds the sidebar for a given team page. `linkFor(key)` supplies the
// href for each section — the static site (nested directories, relative
// links) and the local Express preview (flat /teams/:tag/:section routes)
// resolve paths completely differently, so each caller passes its own.
function teamSidebar(activeKey, linkFor) {
  const item = (it) => {
    const active = it.key === activeKey ? " active" : "";
    const soon = it.built ? "" : `<span class="soon-tag">Soon</span>`;
    return `<a class="nav-item${active}" href="${linkFor(it.key)}"><span class="nav-icon">${it.icon}</span>${escapeHtml(it.label)}${soon}</a>`;
  };
  return `
    <nav class="team-sidebar">
      ${NAV_ITEMS.map(item).join("")}
      <div class="nav-section-label">Manage</div>
      ${MANAGE_NAV_ITEMS.map(item).join("")}
    </nav>`;
}

function comingSoonBody(label) {
  return `
    <div class="empty" style="padding:48px 28px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px;">Coming soon</div>
      <div>The ${escapeHtml(label)} section isn't built yet — only Roster is live right now.</div>
    </div>`;
}

// Leaderboard time-range boards we show tabs for. Every one sums the
// racer_points ledger over a window (see leaderboard-data.js): a rolling
// "now() - interval" for most, but Seasonal uses Nitro Type's own real
// season boundary (see src/season.js) rather than an invented duration.
// racersLeaderboardTable/teamsLeaderboardTable add an explicit note on the
// Seasonal panel naming that real season and its dates.
const LEADERBOARD_RANGES = [
  { key: "hourly", label: "Hourly", built: true },
  { key: "daily", label: "Daily", built: true },
  { key: "weekly", label: "Weekly", built: true },
  { key: "monthly", label: "Monthly", built: true },
  { key: "seasonal", label: "Seasonal", built: true },
  { key: "alltime", label: "All-Time", built: true },
];

// Shown only on the Seasonal panel, in addition to the normal points-
// formula note. `season` is Nitro Type's own currently-active season (see
// src/season.js / leaderboard-data.js's currentSeasonBounds) - the exact
// name and date range NT itself shows in its site banner, not a window we
// invented. Null only transiently, before the season-sync job has run for
// the first time.
function seasonalNote(season) {
  if (!season) {
    return "Tracks Nitro Type's own current season once it's synced.";
  }
  const fmt = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Tracks Nitro Type's own current season, "${escapeHtml(season.name)}" (${fmt(season.start_stamp)} – ${fmt(season.end_stamp)}).`;
}

function comingSoonLeaderboard(rangeLabel) {
  return `
    <div class="empty" style="padding:40px 24px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px;">Coming soon</div>
      <div>The ${escapeHtml(rangeLabel)} board isn't built yet — Nitro Type's own season
      boundaries aren't something we track, so we'd rather leave this blank than make one up.</div>
    </div>`;
}

// A built range can still have nothing to show (no syncs have found new
// races in that window yet) - different message from "not built at all".
// For Seasonal specifically, "no season synced yet" (season === null) is a
// different, clearer situation than "synced, but no one's earned points in
// it yet" - worth its own message rather than the generic one.
function emptyLeaderboard(kindLabel, rangeLabel, season) {
  if (rangeLabel === "Seasonal" && season === null) {
    return `
      <div class="empty" style="padding:40px 24px;">
        Nitro Type's current season hasn't synced yet — this fills in once the season-sync job runs.
      </div>`;
  }
  return `
    <div class="empty" style="padding:40px 24px;">
      No ${escapeHtml(kindLabel)} earned any points in the ${escapeHtml(rangeLabel)} window yet
      — this fills in as more syncs run.
    </div>`;
}

// data-kind/data-range panel pair, built once per (kind, range) combo so
// the segmented controls below just toggle which one is visible.
function leaderboardPanel(kind, range, innerHtml, visible) {
  return `<div class="lb-panel" data-kind="${kind}" data-range="${range}"${visible ? "" : " hidden"}>${innerHtml}</div>`;
}

function leaderboardControls() {
  const kindBtn = (key, label, active) =>
    `<button type="button" class="seg-btn${active ? " active" : ""}" data-kind="${key}">${escapeHtml(label)}</button>`;
  const rangeBtn = (it, active) =>
    `<button type="button" class="seg-btn${active ? " active" : ""}" data-range="${it.key}">${escapeHtml(it.label)}${it.built ? "" : ` <span class="soon-tag">Soon</span>`}</button>`;
  return `
    <div class="lb-controls">
      <div class="seg" data-role="kind">
        ${kindBtn("racers", "Racers", true)}
        ${kindBtn("teams", "Teams", false)}
      </div>
      <div class="seg" data-role="range">
        ${LEADERBOARD_RANGES.map((it) => rangeBtn(it, it.key === "alltime")).join("")}
      </div>
    </div>
    <script>
      (function () {
        var kindSeg = document.querySelector('.seg[data-role="kind"]');
        var rangeSeg = document.querySelector('.seg[data-role="range"]');
        // Queried fresh inside sync() rather than cached once here: this
        // inline script runs the instant the parser reaches it, before the
        // .lb-panel elements that come AFTER it in the HTML have been
        // parsed yet, so caching them up front would always find none.
        function sync() {
          var kind = kindSeg.querySelector(".seg-btn.active").getAttribute("data-kind");
          var range = rangeSeg.querySelector(".seg-btn.active").getAttribute("data-range");
          var panels = document.querySelectorAll(".lb-panel");
          panels.forEach(function (p) {
            p.hidden = !(p.getAttribute("data-kind") === kind && p.getAttribute("data-range") === range);
          });
        }
        [kindSeg, rangeSeg].forEach(function (seg) {
          seg.addEventListener("click", function (e) {
            var btn = e.target.closest(".seg-btn");
            if (!btn) return;
            Array.prototype.slice.call(seg.querySelectorAll(".seg-btn")).forEach(function (b) {
              b.classList.toggle("active", b === btn);
            });
            sync();
          });
        });
      })();
    </script>`;
}

function rankBadgeClass(rank) {
  if (rank === 1) return " top1";
  if (rank === 2) return " top2";
  if (rank === 3) return " top3";
  return "";
}

// Shared by build.js (static) and server.js (local preview) so the two
// never render the leaderboard tables differently - pure HTML rendering
// from already-queried rows, no DB access here. "Points" is earned race
// by race (see racer_points in schema.sql / ingest.js), not a snapshot
// formula - "Races" here means races tracked since a racer was added to
// this site (or since the window started), not Nitro Type's own lifetime
// racesPlayed figure.
// The real Nitro Type URL for a team, by tag - verified live
// (nitrotype.com/team/<TAG>) rather than guessed, so the team-name link on
// the leaderboard actually resolves.
function nitroTypeTeamHref(tag) {
  return `https://www.nitrotype.com/team/${encodeURIComponent(tag)}`;
}

// The real Nitro Type URL for a racer, by their `username` - verified live
// (clicked a roster name on nitrotype.com/team/<TAG> and read the link's
// real href: /racer/<username>). Nitro Type's API gives each member both a
// "username" (the opaque id-looking string this URL actually needs) and a
// separate "displayName" (the name people recognize) - this must be the
// former, never the latter, or the link 404s.
function nitroTypeRacerHref(username) {
  return `https://www.nitrotype.com/racer/${encodeURIComponent(username)}`;
}

// A racer's display name, wrapped as a link to their real Nitro Type
// profile, plus a small "stats" icon linking to this site's own per-racer
// page (see theme.js's racerStatsBody) - used everywhere a racer's name is
// rendered in a table row (roster, leaderboards, tracker, activity,
// tournament brackets) so both links are always one click away from the
// name, not buried in a menu. `statsHref` is a pre-built URL string (or
// null/undefined to omit the stats icon), computed by the caller - the
// static site's relative paths and the Express preview's absolute routes
// resolve completely differently, and the site-wide leaderboard spans
// several teams' own racer pages, so there's no single formula this helper
// could apply itself. The Nitro Type link is omitted too if `username`
// (the opaque id Nitro Type's own URLs need, not the display name) isn't
// available in that particular row's query.
function racerNameMarkup(name, username, statsHref) {
  const label = escapeHtml(name || "?");
  const nameHtml = username
    ? `<a href="${nitroTypeRacerHref(username)}" target="_blank" rel="noopener" title="View on Nitro Type">${label}</a>`
    : label;
  const statsHtml = statsHref
    ? ` <a class="stats-link" href="${statsHref}" title="${label}'s stats on TypeTrack">📊</a>`
    : "";
  return `${nameHtml}${statsHtml}`;
}

// teamHref(tag) -> this site's own team page URL. Supplied by the caller
// (build.js/server.js) because the static site's relative paths and the
// Express preview's absolute routes resolve completely differently - same
// pattern as teamSidebar's linkFor.
function racersLeaderboardTable(rows, rangeLabel, teamHref, season, assetsHref = "/assets/") {
  if (!rows.length) {
    return emptyLeaderboard("racers", rangeLabel, season);
  }
  const body = rows
    .map((r, i) => {
      const rank = i + 1;
      const name = r.display_name || r.username;
      const tagBg = teamColor(r.team_tag, r.tag_color);
      const accClass = accuracyClass(r.accuracy);
      const accLabel = r.accuracy == null ? "—" : `${r.accuracy}%`;
      // This board spans every tracked team, so a racer's stats page lives
      // under their own team's directory - teamHref(tag) already gives
      // that team's page URL from wherever this leaderboard is rendered.
      const statsHref = r.nt_user_id != null ? `${teamHref(r.team_tag).replace(/\/$/, "")}/racer/${r.nt_user_id}/` : null;
      return `
        <tr>
          <td><span class="lb-rank${rankBadgeClass(rank)}">${rank}</span></td>
          <td class="racer">
            <span class="avatar" style="background:${avatarColor(name)}">${escapeHtml((name || "?").slice(0, 1).toUpperCase())}</span>
            ${carThumb(r.car_id, r.car_hue_angle, assetsHref)}
            ${racerNameMarkup(name, r.username, statsHref)}
            <a class="lb-team-tag" href="${teamHref(r.team_tag)}" style="background:${tagBg};color:${textOnColor(tagBg)}">${escapeHtml(r.team_tag)}</a>
          </td>
          <td><span class="points">${formatNumber(r.points)}</span></td>
          <td>${formatNumber(r.races)}</td>
          <td>${formatNumber(r.avg_speed ?? "-")}</td>
          <td>${formatNumber(r.top_speed ?? "-")}</td>
          <td><span class="pill ${accClass}">${accLabel}</span></td>
        </tr>`;
    })
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Racer</th><th>Points</th><th>Races tracked</th><th>Avg speed</th><th>Highest speed</th><th>Accuracy</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="lb-score-note">Points = (avg speed ÷ 2 + accuracy) × races completed since the last sync, earned race by race — not an official Nitro Type stat.${rangeLabel === "Seasonal" ? ` ${seasonalNote(season)}` : ""}</p>`;
}

function teamsLeaderboardTable(rows, rangeLabel, teamHref, season) {
  if (!rows.length) {
    return emptyLeaderboard("teams", rangeLabel, season);
  }
  const body = rows
    .map((t, i) => {
      const rank = i + 1;
      const bg = teamColor(t.tag, t.tag_color);
      return `
        <tr>
          <td><span class="lb-rank${rankBadgeClass(rank)}">${rank}</span></td>
          <td class="racer">
            <span class="avatar" style="background:${bg};color:${textOnColor(bg)}">${escapeHtml((t.tag || "?").slice(0, 1).toUpperCase())}</span>
            <a href="${teamHref(t.tag)}">[${escapeHtml(t.tag)}]</a>
            <a href="${nitroTypeTeamHref(t.tag)}" target="_blank" rel="noopener">${escapeHtml(t.display_name || "")}${teamEmojiSuffix(t.team_emoji)}</a>
          </td>
          <td><span class="points">${formatNumber(t.points)}</span></td>
          <td>${formatNumber(t.races)}</td>
          <td>${formatNumber(t.avg_speed ?? "-")}</td>
          <td>${t.accuracy == null ? "—" : `${t.accuracy}%`}</td>
          <td>${formatNumber(t.racer_count)}</td>
        </tr>`;
    })
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Team</th><th>Points</th><th>Total races</th><th>Team WPM</th><th>Team accuracy</th><th>Racers earning</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="lb-score-note">Points = the sum of every member's points — races completed since joining this tracker × (avg speed ÷ 2 + accuracy). Team WPM/accuracy are races-weighted averages over this window.${rangeLabel === "Seasonal" ? ` ${seasonalNote(season)}` : ""}</p>`;
}

// Builds the full leaderboards page body (controls + all panels) from
// already-queried { racers: {range: rows}, teams: {range: rows} } data
// (see leaderboard-data.js). Shared so build.js and server.js produce
// identical markup; only the surrounding pageShell() call (and teamHref,
// which resolves our own team links differently per entrypoint) differs.
function leaderboardsBody(data, teamHref, assetsHref = "/assets/") {
  const panels = [];
  for (const range of LEADERBOARD_RANGES) {
    const visible = range.key === "alltime";
    if (!range.built) {
      panels.push(leaderboardPanel("racers", range.key, comingSoonLeaderboard(range.label), visible));
      panels.push(leaderboardPanel("teams", range.key, comingSoonLeaderboard(range.label), false));
      continue;
    }
    panels.push(leaderboardPanel("racers", range.key, racersLeaderboardTable(data.racers[range.key] || [], range.label, teamHref, data.season, assetsHref), visible));
    panels.push(leaderboardPanel("teams", range.key, teamsLeaderboardTable(data.teams[range.key] || [], range.label, teamHref, data.season), false));
  }
  return `
    <h1>Leaderboards</h1>
    <p class="meta-row">Ranked across every team this tracker follows — not all of Nitro Type.</p>
    ${leaderboardControls()}
    ${panels.join("")}`;
}

// ---------------------------------------------------------------------
// Tracker: a team's own racers ranked by points, same ledger and windows
// as the site-wide leaderboard (see leaderboard-data.js's loadTeamTracker)
// just scoped to one roster - modeled on Startrack's "Trackers" page.
// ---------------------------------------------------------------------
const TRACKER_RANGES = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "seasonal", label: "Season" },
  { key: "alltime", label: "All-Time" },
];

function trackerTable(rows, rangeLabel, assetsHref = "/assets/", racerHref) {
  if (!rows.length) {
    return `<div class="empty" style="padding:40px 24px;">No one on this team earned any points in the ${escapeHtml(rangeLabel)} window yet — this fills in as more syncs run.</div>`;
  }
  const body = rows
    .map((r, i) => {
      const rank = i + 1;
      const name = r.display_name || r.username;
      const accClass = accuracyClass(r.accuracy);
      const accLabel = r.accuracy == null ? "—" : `${r.accuracy}%`;
      const statsHref = r.nt_user_id != null && racerHref ? racerHref(r.nt_user_id) : null;
      return `
        <tr>
          <td><span class="lb-rank${rankBadgeClass(rank)}">${rank}</span></td>
          <td class="racer">
            <span class="avatar" style="background:${avatarColor(name)}">${escapeHtml((name || "?").slice(0, 1).toUpperCase())}</span>
            ${carThumb(r.car_id, r.car_hue_angle, assetsHref)}
            ${racerNameMarkup(name, r.username, statsHref)}
          </td>
          <td><span class="points">${formatNumber(r.points)}</span></td>
          <td>${formatNumber(r.races)}</td>
          <td>${formatNumber(r.avg_speed ?? "-")}</td>
          <td>${formatNumber(r.top_speed ?? "-")}</td>
          <td><span class="pill ${accClass}">${accLabel}</span></td>
        </tr>`;
    })
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Racer</th><th>Points</th><th>Races</th><th>Avg speed</th><th>Highest speed</th><th>Accuracy</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function trackerControls() {
  return `
    <div class="lb-controls">
      <div class="seg" data-role="trk-range">
        ${TRACKER_RANGES.map((it, i) => `<button type="button" class="seg-btn${i === 0 ? " active" : ""}" data-range="${it.key}">${escapeHtml(it.label)}</button>`).join("")}
      </div>
    </div>
    <script>
      (function () {
        var seg = document.querySelector('.seg[data-role="trk-range"]');
        var panels = document.querySelectorAll(".trk-panel");
        function sync() {
          var range = seg.querySelector(".seg-btn.active").getAttribute("data-range");
          panels.forEach(function (p) { p.hidden = p.getAttribute("data-range") !== range; });
        }
        seg.addEventListener("click", function (e) {
          var btn = e.target.closest(".seg-btn");
          if (!btn) return;
          Array.prototype.slice.call(seg.querySelectorAll(".seg-btn")).forEach(function (b) {
            b.classList.toggle("active", b === btn);
          });
          sync();
        });
      })();
    </script>`;
}

// `data` is loadTeamTracker()'s result: { byRange: {daily:[],...}, season }.
function trackerBody(data, assetsHref = "/assets/", racerHref) {
  const panels = TRACKER_RANGES.map((range, i) => {
    const visible = i === 0;
    const rows = data.byRange[range.key] || [];
    const seasonNote = range.key === "seasonal" ? `<p class="lb-score-note">${seasonalNote(data.season)}</p>` : "";
    return `<div class="trk-panel" data-range="${range.key}"${visible ? "" : " hidden"}>${trackerTable(rows, range.label, assetsHref, racerHref)}${seasonNote}</div>`;
  }).join("");
  return `
    <h2 style="margin:28px 0 14px;">Tracker</h2>
    <p class="meta-row">This team's own racers, ranked by points earned in each window — the same ledger behind the site-wide leaderboard, scoped to just this roster.</p>
    ${trackerControls()}
    ${panels}`;
}

// ---------------------------------------------------------------------
// Activity: an hourly view of the last 24 hours, modeled on Startrack's
// own Activity page but built from this project's own racer_points ledger
// (see activity-data.js) rather than scraping theirs. Timestamps are shown
// in UTC, not the visitor's local time - this is a server-rendered static
// page with no reliable way to know a visitor's timezone at build time,
// and a plainly-labeled UTC hour is more honest than guessing.
// ---------------------------------------------------------------------
function utcHourLabel(stamp) {
  const h = new Date(stamp).getUTCHours();
  return `${String(h).padStart(2, "0")}:00`;
}

function activityChart(hours) {
  const max = Math.max(1, ...hours.map((h) => Number(h.races)));
  const bars = hours
    .map((h, i) => {
      const races = Number(h.races);
      const pct = Math.max(races > 0 ? 4 : 1, Math.round((races / max) * 100));
      const label = utcHourLabel(h.hour);
      // A label under every bar would overlap at 24 columns - show one
      // every 3 hours (8 labels total) and leave the rest blank; the full
      // hour is still in the title tooltip for anyone who hovers.
      const showLabel = i % 3 === 0;
      return `
        <div class="activity-bar" style="--h:${pct}%" title="${label} UTC — ${formatNumber(races)} race${races === 1 ? "" : "s"}">
          <div class="bar"></div>
          <div class="bar-label">${showLabel ? label : ""}</div>
        </div>`;
    })
    .join("");
  return `<div class="activity-chart">${bars}</div>`;
}

function activityRacerRows(rows, assetsHref, racerHref) {
  return rows
    .map((r, i) => {
      const rank = i + 1;
      const name = r.display_name || r.username;
      const accClass = accuracyClass(r.accuracy);
      const accLabel = r.accuracy == null ? "—" : `${r.accuracy}%`;
      const statsHref = r.nt_user_id != null && racerHref ? racerHref(r.nt_user_id) : null;
      return `
        <tr>
          <td><span class="lb-rank${rankBadgeClass(rank)}">${rank}</span></td>
          <td class="racer">
            <span class="avatar" style="background:${avatarColor(name)}">${escapeHtml((name || "?").slice(0, 1).toUpperCase())}</span>
            ${carThumb(r.car_id, r.car_hue_angle, assetsHref)}
            ${racerNameMarkup(name, r.username, statsHref)}
          </td>
          <td>${formatNumber(r.races)}</td>
          <td><span class="points">${formatNumber(r.points)}</span></td>
          <td>${formatNumber(r.avg_speed ?? "-")}</td>
          <td><span class="pill ${accClass}">${accLabel}</span></td>
        </tr>`;
    })
    .join("");
}

// `activity` is activity-data.js's teamActivity() result:
// { hours, racers, totalRaces, activeRacers, busiestHour }.
function activityBody(tag, activity, assetsHref = "/assets/", racerHref) {
  const { hours, racers, totalRaces, activeRacers, busiestHour } = activity;

  const statBar = `
    <div class="req-bar">
      <div class="req">Races (24h) <b>${formatNumber(totalRaces)}</b></div>
      <div class="req">Active racers <b>${formatNumber(activeRacers)}</b></div>
      <div class="req">Busiest hour <b>${busiestHour != null ? `${utcHourLabel(busiestHour)} UTC` : "—"}</b></div>
    </div>`;

  const chart = totalRaces
    ? activityChart(hours)
    : `<div class="empty" style="padding:40px 24px;">No races tracked in the last 24 hours yet — this fills in as syncs run.</div>`;

  const table = racers.length
    ? `<div class="table-wrap">
         <table>
           <thead>
             <tr><th>#</th><th>Racer</th><th>Races</th><th>Points</th><th>Avg speed</th><th>Accuracy</th></tr>
           </thead>
           <tbody>${activityRacerRows(racers, assetsHref, racerHref)}</tbody>
         </table>
       </div>`
    : `<div class="empty" style="padding:40px 24px;">No one on this team raced in the last 24 hours yet.</div>`;

  return `
    <h1>Activity</h1>
    <p class="meta-row">A live look at the last 24 hours — race volume by hour (UTC) and who's been racing, from the same points ledger behind the Tracker and Leaderboards.</p>
    ${statBar}
    <h2 style="margin:28px 0 14px;">Races per hour</h2>
    ${chart}
    <h2 style="margin:28px 0 14px;">Most active (24h)</h2>
    ${table}`;
}

// ---------------------------------------------------------------------
// Racer stats: one racer's own page - their current roster snapshot plus
// their own points/races/avg speed/accuracy in every one of the site's
// standard windows (see leaderboard-data.js's loadRacerWindows/
// loadTeamRacerWindows), the same ledger every other board on this site
// sums, scoped to just this person. Linked from the small 📊 stats icon
// next to a racer's name everywhere one appears (see racerNameMarkup).
// ---------------------------------------------------------------------
function racerWindowRows(windows) {
  return LEADERBOARD_RANGES.map((range) => {
    const w = windows.byRange[range.key];
    if (!w || (Number(w.races) === 0 && Number(w.points) === 0)) {
      return `
        <tr>
          <td>${escapeHtml(range.label)}</td>
          <td colspan="4" style="color:var(--muted);">No points earned in this window yet.</td>
        </tr>`;
    }
    const accLabel = w.accuracy == null ? "—" : `${w.accuracy}%`;
    return `
      <tr>
        <td>${escapeHtml(range.label)}</td>
        <td><span class="points">${formatNumber(w.points)}</span></td>
        <td>${formatNumber(w.races)}</td>
        <td>${formatNumber(w.avg_speed ?? "-")}</td>
        <td><span class="pill ${accuracyClass(w.accuracy)}">${accLabel}</span></td>
      </tr>`;
  }).join("");
}

// `racer` carries identity + latest racer_stats snapshot (nt_user_id,
// username, display_name, role, membership, joined_at_nt, car_id,
// car_hue_angle, squad_name, squad_color, avg_speed, top_speed, races,
// accuracy); `team` is {tag, display_name, tag_color, team_emoji,
// captain_nt_user_id} for the team link/captain badge; `windows` is
// loadRacerWindows()'s (or loadTeamRacerWindows' per-racer entry) result:
// { byRange: {hourly: {...}|null, ...}, season }.
function racerStatsBody(racer, team, windows, assetsHref = "/assets/", teamHref) {
  const name = racer.display_name || racer.username;
  const initial = (name || "?").slice(0, 1).toUpperCase();
  const isCaptain = team.captain_nt_user_id != null && racer.nt_user_id === team.captain_nt_user_id;
  const accClass = accuracyClass(racer.accuracy);
  const accLabel = racer.accuracy == null ? "—" : `${racer.accuracy}%`;

  const hero = `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px;">
      <span class="avatar" style="width:44px;height:44px;font-size:17px;background:${avatarColor(name)}">${escapeHtml(initial)}</span>
      ${carThumb(racer.car_id, racer.car_hue_angle, assetsHref)}
      <div>
        <div style="font-size:19px;font-weight:800;">
          ${racer.username ? `<a href="${nitroTypeRacerHref(racer.username)}" target="_blank" rel="noopener" title="View on Nitro Type">${escapeHtml(name)}</a>` : escapeHtml(name)}
          ${roleBadge(racer.role, isCaptain)}${membershipBadge(racer.membership)}${squadBadge(racer.squad_name, racer.squad_color)}
        </div>
        <div class="meta-row" style="margin:4px 0 0;">
          ${teamHref ? `<a href="${teamHref(team.tag)}" style="color:inherit;">[${escapeHtml(team.tag)}]</a>` : `[${escapeHtml(team.tag)}]`}
          ${escapeHtml(team.display_name || "")}${teamEmojiSuffix(team.team_emoji)}
          · Joined ${formatDate(racer.joined_at_nt)}${racer.stats_captured_at ? ` · Last synced ${new Date(racer.stats_captured_at).toLocaleString()}` : ""}
        </div>
      </div>
    </div>`;

  const statBar = `
    <div class="req-bar">
      <div class="req">Avg speed <b>${formatNumber(racer.avg_speed ?? "-")}</b></div>
      <div class="req">Highest speed <b>${formatNumber(racer.top_speed ?? "-")}</b></div>
      <div class="req">Lifetime races tracked <b>${formatNumber(racer.races ?? "-")}</b></div>
      <div class="req">Accuracy <b><span class="pill ${accClass}">${accLabel}</span></b></div>
    </div>`;

  const seasonNote = windows.season ? `<p class="lb-score-note">${seasonalNote(windows.season)}</p>` : "";

  return `
    <h1>${escapeHtml(name)}</h1>
    <p class="meta-row">This racer's own points, races, avg speed and accuracy in every window this site tracks — the same ledger behind the Tracker and Leaderboards, scoped to just them.</p>
    ${hero}
    ${statBar}
    <h2 style="margin:28px 0 14px;">Points by window</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Window</th><th>Points</th><th>Races</th><th>Avg speed</th><th>Accuracy</th></tr></thead>
        <tbody>${racerWindowRows(windows)}</tbody>
      </table>
    </div>
    ${seasonNote}`;
}

// ---------------------------------------------------------------------
// Events: a team's event/tournament calendar. Unlike everything else on
// this site, these are curated by hand (see data/events.json) rather than
// synced from Nitro Type, which doesn't publish a per-team event calendar
// the way it publishes season dates - modeled on Startrack's Events page.
// ---------------------------------------------------------------------
function eventStatusPill(status) {
  const map = { pending: ["ok", "Pending"], active: ["good", "Active"], ended: ["na", "Ended"] };
  const [cls, label] = map[status] || ["na", status];
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

function formatEventDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Events moved from the hand-curated data/events.json file to the
// Supabase-backed `events` table (see schema.sql) so a team's real,
// NT-recognized captain can add/edit/remove events themselves, live - from
// Team Admin's own Events tab (see teamAdminBody below), not from this
// public page, which is read-only for everyone. `events`/`tag` here are
// still the build-time (or server.js live-query) snapshot, rendered as a
// normal table for a fast first paint and for anyone without JavaScript;
// src/client/app.js's initEventsPage() replaces #events-list with a
// freshly-fetched copy on load so a change the captain just made from
// Team Admin shows up here immediately, without waiting for the next
// scheduled site rebuild.
function eventsBody(tag, events) {
  const initialRows = !events.length
    ? `<div class="empty" style="padding:40px 24px;">No events scheduled for [${escapeHtml(tag)}] yet.</div>`
    : `<div class="table-wrap">
         <table>
           <thead>
             <tr><th>Event</th><th>Status</th><th>Starts</th><th>Ends</th></tr>
           </thead>
           <tbody>
             ${events
               .map(
                 (ev) => `
               <tr>
                 <td>
                   <b>${escapeHtml(ev.title)}</b>
                   ${ev.description ? `<div style="color:var(--muted);font-size:12.5px;margin-top:3px;max-width:420px;white-space:normal;">${escapeHtml(ev.description)}</div>` : ""}
                 </td>
                 <td>${eventStatusPill(ev.status)}</td>
                 <td>${formatEventDate(ev.start)}</td>
                 <td>${formatEventDate(ev.end)}</td>
               </tr>`
               )
               .join("")}
           </tbody>
         </table>
       </div>`;
  return `
    <div data-events-panel data-team-tag="${escapeHtml(tag)}">
      <h2 style="margin:28px 0 14px;">Events</h2>
      <div data-events-list>${initialRows}</div>
      <p class="lb-score-note">This team's captain manages events from Team Admin.</p>
    </div>`;
}

const SCORING_FIELD_LABELS = {
  points: "Points",
  races: "Races",
  avg_speed: "Avg speed",
  accuracy: "Accuracy",
};

// One bracket slot: an entrant (seed + name + score once decided) or an
// empty "TBD" placeholder for a seed that hasn't been determined, hasn't
// been assigned yet, or belongs to a round that hasn't been seeded.
// `racerHref(ntUserId, teamTag)` is optional - a tournament can span
// several teams, so each entrant's own stats page lives under its own
// team's directory, not necessarily the page this bracket is rendered on.
function bracketSlot(entrant, isWinner, racerHref) {
  if (!entrant) {
    return `<div class="bracket-slot bracket-slot-empty">TBD</div>`;
  }
  const name = entrant.display_name || entrant.username || "?";
  const statsHref = entrant.nt_user_id != null && racerHref ? racerHref(entrant.nt_user_id, entrant.team_tag) : null;
  const scoreHtml = entrant.score != null ? `<span class="bracket-score">${formatNumber(entrant.score)}</span>` : "";
  const qualifiedNote = entrant.qualified === false ? `<span class="bracket-dnq" title="Didn't meet the qualifying-races minimum">DNQ</span>` : "";
  return `
    <div class="bracket-slot${isWinner ? " bracket-slot-winner" : ""}">
      ${entrant.seed != null ? `<span class="bracket-seed">${escapeHtml(String(entrant.seed))}</span>` : ""}
      <span class="bracket-name">${racerNameMarkup(name, entrant.username, statsHref)}</span>
      ${qualifiedNote}${scoreHtml}
    </div>`;
}

function bracketMatch(match, racerHref) {
  const aWin = !!(match.winner && match.a && match.winner.nt_user_id === match.a.nt_user_id);
  const bWin = !!(match.winner && match.b && match.winner.nt_user_id === match.b.nt_user_id);
  return `
    <div class="bracket-match" data-status="${escapeHtml(match.status)}">
      ${bracketSlot(match.a, aWin, racerHref)}
      ${bracketSlot(match.b, bWin, racerHref)}
    </div>`;
}

// The full set of round columns for one tournament's bracket - a plain
// side-scrolling row of columns rather than a connected tree (no SVG/
// canvas connector lines), same "if it's too wide, let it scroll" call the
// rest of the site's wide tables already make on mobile.
function bracketColumns(bracket, racerHref) {
  if (!bracket || !bracket.roundsOut.length) {
    return `<div class="empty" style="padding:20px 4px;">This tournament's round schedule isn't fully set up yet.</div>`;
  }
  const cols = bracket.roundsOut
    .map(
      ({ round, matches }) => `
      <div class="bracket-col">
        <div class="bracket-col-title">${escapeHtml(round.label)}</div>
        ${matches.map((m) => bracketMatch(m, racerHref)).join("")}
      </div>`
    )
    .join("");
  return `<div class="bracket-wrap"><div class="bracket-grid">${cols}</div></div>`;
}

// Tournaments: a multi-round bracket per team_tournaments row (see
// schema.sql / src/tournaments-data.js's buildBracket), spanning however
// many teams the captain entered. This page is pure display - the create/
// delete/schedule form lives on Team Admin's own Tournaments tab, not
// here. `brackets` is a plain object keyed by tournament id -> the
// already-computed bracket (build.js/server.js call bracketsForTournaments
// once up front); src/client/app.js's initEventsPage-style live refresh
// doesn't apply here since a full bracket recompute isn't something to
// replicate in the browser - this page simply reflects whatever the last
// sync/build computed, same cadence as every other leaderboard.
function tournamentsBody(tag, tournaments, brackets, assetsHref = "/assets/", racerHref) {
  const initialRows = !tournaments.length
    ? `<div class="empty" style="padding:40px 24px;">No tournaments scheduled for [${escapeHtml(tag)}] yet.</div>`
    : tournaments
        .map((t) => {
          const bracket = brackets[t.id];
          const fieldLabel = SCORING_FIELD_LABELS[t.scoring_field] || "Points";
          return `
        <div class="card" style="margin-bottom:24px;" data-tournament-card="${escapeHtml(t.id)}">
          <div style="font-weight:700;font-size:15px;">${escapeHtml(t.title)} ${eventStatusPill(t.status)}</div>
          <div class="meta-row" style="margin:3px 0 4px;">${formatEventDate(t.start)} → ${formatEventDate(t.end)}</div>
          <div class="meta-row" style="margin:0 0 10px;">
            Teams: ${t.teams.map((tg) => `[${escapeHtml(tg)}]`).join(" ")} · Scored by ${escapeHtml(fieldLabel)}${t.qualifying_races ? ` · Min ${escapeHtml(String(t.qualifying_races))} races each round to qualify` : ""}
          </div>
          ${t.description ? `<div style="color:var(--muted);font-size:13px;margin-bottom:14px;max-width:560px;">${escapeHtml(t.description)}</div>` : ""}
          ${bracketColumns(bracket, racerHref)}
        </div>`;
        })
        .join("");
  return `
    <div data-tournaments-panel data-team-tag="${escapeHtml(tag)}">
      <h2 style="margin:28px 0 14px;">Tournaments</h2>
      <div data-tournaments-list>${initialRows}</div>
      <p class="lb-score-note">Rounds are scored from real race data each sync - no simulated matches. This team's captain manages tournaments from Team Admin.</p>
    </div>`;
}

// Team Admin: captain-only editing (appoint/remove officers), officer-only
// viewing, no access at all for anyone else - the three-tier permission
// model from the latest design. Unlike events/notifications/trackers
// above, this section's content is NEVER rendered into the static HTML
// (there's nothing here a build-time snapshot should show to every
// visitor) - the whole panel starts hidden and src/client/app.js's
// initTeamAdminPage() decides what, if anything, to reveal once it knows
// who's actually looking at the page. racers is the already-queried
// roster (build.js passes the same list roster.js renders), used only to
// label each officer-toggle row with a name instead of a bare nt_user_id.
function teamAdminBody(tag, captainNtUserId, racers, squads) {
  const rosterOptions = (racers || [])
    .map((r) => `<option value="${escapeHtml(r.nt_user_id)}">${escapeHtml(r.display_name || r.username)}</option>`)
    .join("");
  // Rendered once, server-side, from whatever squads already exist at
  // build/request time; the client re-renders this same block after any
  // create/delete/assign so it never goes stale within a session (see
  // renderSquadsTab in app.js) - this initial markup just avoids a blank
  // flash while getSession/resolveTeamRole are still resolving.
  const squadRows = (squads || []).length
    ? (squads || [])
        .map(
          (s) => `
          <tr data-squad-row="${escapeHtml(s.id)}">
            <td><span class="squad-swatch" style="background:${escapeHtml(s.color)};"></span>${escapeHtml(s.name)}</td>
            <td data-squad-count>${escapeHtml(String(s.racer_count ?? 0))}</td>
            <td data-squad-delete-cell></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="3" style="color:var(--muted);">No squads yet.</td></tr>`;
  const squadOptionsFor = (currentId) =>
    `<option value="">No squad</option>` +
    (squads || [])
      .map((s) => `<option value="${escapeHtml(s.id)}"${String(currentId ?? "") === String(s.id) ? " selected" : ""}>${escapeHtml(s.name)}</option>`)
      .join("");
  const squadRosterRows = (racers || []).length
    ? (racers || [])
        .map(
          (r) => `
          <tr data-squad-roster-row="${escapeHtml(r.nt_user_id)}">
            <td>${escapeHtml(r.display_name || r.username)}</td>
            <td data-squad-roster-select-cell>
              <select class="form-input" data-squad-roster-select disabled>${squadOptionsFor(r.squad_id)}</select>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="2" style="color:var(--muted);">No racers synced yet.</td></tr>`;
  return `
    <div data-admin-panel data-team-tag="${escapeHtml(tag)}" data-captain-nt-user-id="${escapeHtml(captainNtUserId ?? "")}">
      <h2 style="margin:28px 0 14px;">Team Admin</h2>
      <div data-admin-gate style="color:var(--muted);font-size:13.5px;">Checking your access…</div>
      <div data-admin-content style="display:none;">
        <p class="meta-row" data-admin-role-note></p>
        <div class="seg" style="margin-bottom:16px;">
          <button type="button" class="seg-btn active" data-admin-tab-btn="officers">Officers</button>
          <button type="button" class="seg-btn" data-admin-tab-btn="squads">Squads</button>
          <button type="button" class="seg-btn" data-admin-tab-btn="events">Events</button>
          <button type="button" class="seg-btn" data-admin-tab-btn="tournaments">Tournaments</button>
          <button type="button" class="seg-btn" data-admin-tab-btn="settings">Settings</button>
        </div>

        <div data-admin-tabpanel="officers">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Officer</th><th></th></tr></thead>
              <tbody data-admin-officer-rows><tr><td colspan="2" style="color:var(--muted);">No officers appointed yet.</td></tr></tbody>
            </table>
          </div>
          <form data-admin-appoint-form style="display:none;margin-top:14px;gap:8px;max-width:420px;">
            <select class="form-input" name="nt_user_id" style="flex:1;">${rosterOptions}</select>
            <button type="submit" class="btn-primary">Make officer</button>
          </form>
        </div>

        <div data-admin-tabpanel="squads" style="display:none;">
          <div style="color:var(--muted);font-size:13px;margin-bottom:14px;">
            Group racers within [${escapeHtml(tag)}] — site-only, doesn't affect anything on Nitro Type itself.
          </div>
          <div class="table-wrap" style="max-width:480px;">
            <table>
              <thead><tr><th>Squad</th><th>Racers</th><th></th></tr></thead>
              <tbody data-admin-squad-rows>${squadRows}</tbody>
            </table>
          </div>
          <form data-admin-squad-form style="display:none;margin-top:14px;gap:8px;max-width:480px;align-items:center;">
            <input class="form-input" type="color" name="squad_color" value="#29d3ff" style="flex:none;width:44px;padding:4px;">
            <input class="form-input" type="text" name="squad_name" placeholder="Squad name" maxlength="40" style="flex:1;">
            <button type="submit" class="btn-primary">Create squad</button>
          </form>

          <h3 style="margin:26px 0 10px;font-size:14.5px;">Assign racers</h3>
          <div class="table-wrap" style="max-width:480px;">
            <table>
              <thead><tr><th>Racer</th><th>Squad</th></tr></thead>
              <tbody data-admin-squad-roster-rows>${squadRosterRows}</tbody>
            </table>
          </div>
        </div>

        <div data-admin-tabpanel="events" style="display:none;">
          <div style="color:var(--muted);font-size:13px;margin-bottom:14px;">
            Manage [${escapeHtml(tag)}]'s events — shown on the public Events page.
          </div>
          <div data-admin-events-manage>Loading…</div>
        </div>

        <div data-admin-tabpanel="tournaments" style="display:none;">
          <div style="color:var(--muted);font-size:13px;margin-bottom:14px;">
            Build a bracket tournament for [${escapeHtml(tag)}] — pick participating teams, how it's scored, and each round's dates. Standings are computed from real race data every sync; nothing here is simulated.
          </div>
          <div data-admin-tournaments-manage>Loading…</div>
        </div>

        <div data-admin-tabpanel="settings" style="display:none;max-width:480px;">
          <div style="color:var(--muted);font-size:13px;margin-bottom:14px;">
            Site-only settings for [${escapeHtml(tag)}] — everything else on this team's page (requirements, color, roster) comes straight from Nitro Type and can't be edited here.
          </div>
          <label class="form-input-wrap" style="margin-bottom:16px;">
            <span style="color:var(--text);font-size:13.5px;font-weight:700;">Discord invite link</span>
            <span>Shown on this team's page so racers can join your server directly.</span>
            <input class="form-input" type="url" data-admin-discord-input placeholder="https://discord.gg/yourteam">
          </label>
          <label class="form-input-wrap" style="margin-bottom:16px;">
            <span style="color:var(--text);font-size:13.5px;font-weight:700;">Team emoji</span>
            <span>One emoji, shown next to your team's name on the leaderboards and team list.</span>
            <input class="form-input" type="text" data-admin-emoji-input placeholder="🏁" maxlength="8" style="max-width:120px;">
          </label>
          <button type="button" class="btn-primary" data-admin-settings-save style="display:none;">Save settings</button>
        </div>

        <div data-admin-error class="form-error" style="display:none;margin-top:10px;"></div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Notifications: an auto-detected feed (new members, lifetime/team race
// milestones) written during every sync - see src/notifications.js. No
// curation needed, unlike Events above. Modeled on Startrack's own
// Notifications page's day-grouped digest.
// ---------------------------------------------------------------------
const NOTIFICATION_ICON = {
  new_member: "\u{1F44B}",
  lifetime_milestone: "\u{1F3C1}",
  team_milestone: "\u{1F697}",
};
const NOTIFICATION_LABEL = {
  new_member: "New member",
  lifetime_milestone: "Lifetime race milestone",
  team_milestone: "Team race milestone",
};

function notificationsBody(tag, rows) {
  if (!rows.length) {
    return `
      <h2 style="margin:28px 0 14px;">Notifications</h2>
      <div class="empty" style="padding:40px 24px;">
        No notifications yet for [${escapeHtml(tag)}] — new members and race milestones will show up here automatically as syncs run.
      </div>`;
  }
  // Rows arrive newest-first from queryNotifications; just group
  // consecutive same-day rows together under one date heading.
  const groups = [];
  let currentKey = null;
  for (const row of rows) {
    const key = new Date(row.created_at).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    if (key !== currentKey) {
      groups.push({ key, items: [] });
      currentKey = key;
    }
    groups[groups.length - 1].items.push(row);
  }
  const groupsHtml = groups
    .map(
      (g) => `
        <div class="notif-day">
          <div class="notif-date">${escapeHtml(g.key)}</div>
          ${g.items
            .map(
              (row) => `
            <div class="notif-item">
              <span class="notif-icon">${NOTIFICATION_ICON[row.kind] || "\u{1F4E2}"}</span>
              <div>
                <div class="notif-headline">${escapeHtml(row.headline)}</div>
                <div class="notif-meta">${escapeHtml(NOTIFICATION_LABEL[row.kind] || row.kind)} · ${new Date(row.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>
              </div>
            </div>`
            )
            .join("")}
        </div>`
    )
    .join("");
  return `
    <h2 style="margin:28px 0 14px;">Notifications</h2>
    <p class="meta-row">Auto-detected from every sync — new members and race milestones, newest first.</p>
    ${groupsHtml}`;
}

const BASE_CSS = `
  :root {
    --bg: #0a0c11;
    --panel: #12151d;
    --panel-2: #181c27;
    --border: #272c3a;
    --text: #f1f3f8;
    --muted: #8d96a8;
    /* Amber is the brand/chrome color - nav, buttons, the default card
       accent. Cyan ("velocity") is spent in exactly one place: the
       single most important number on any page (leaderboard points),
       so it reads as a highlight instead of just another UI color. */
    --accent: #ffb020;
    --velocity: #29d3ff;
    --good: #3ddc84;
    --ok: #ffb020;
    --low: #ff5c5c;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    /* Flat dark fills read dead at this size - a faint diagonal
       "tread" texture (two offset stripe layers, almost invisible,
       fixed so it doesn't scroll with the page) gives the background
       some depth without competing with the data on top of it. */
    background-color: var(--bg);
    background-image:
      repeating-linear-gradient(135deg, rgba(255,255,255,0.025) 0 2px, transparent 2px 64px),
      repeating-linear-gradient(135deg, rgba(255,255,255,0.012) 0 10px, transparent 10px 64px);
    background-attachment: fixed;
    color: var(--text);
    font-family: "Manrope", -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  header.site {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    box-shadow: 0 1px 24px rgba(255,176,32,0.06);
    position: relative;
    z-index: 1;
  }
  header.site .mark {
    width: 30px; height: 30px; border-radius: 9px;
    background: linear-gradient(135deg, #ffb020, #ff5e3d);
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 15px; color: #1a0f00;
    flex: none;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.08) inset, 0 4px 14px rgba(255,176,32,0.35);
  }
  header.site .name {
    font-family: "Rajdhani", "Manrope", sans-serif;
    font-weight: 700; font-size: 20px; letter-spacing: 0.3px; margin-right: 10px;
    background: linear-gradient(135deg, #f6f7fb, #c7cedd);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  header.site .tagline { color: var(--muted); font-size: 13px; margin-left: 4px; }
  .site-nav { display: flex; gap: 4px; margin-left: 6px; }
  .site-nav-link {
    color: var(--muted);
    font-weight: 700;
    font-size: 13.5px;
    padding: 6px 11px;
    border-radius: 7px;
  }
  .site-nav-link { position: relative; }
  .site-nav-link:hover { color: var(--text); text-decoration: none; background: var(--panel-2); }
  .site-nav-link.active { color: var(--accent); background: rgba(255,176,32,0.12); }
  .site-nav-link.active::after {
    content: "";
    position: absolute; left: 11px; right: 11px; bottom: -11px;
    height: 2px; border-radius: 2px;
    background: var(--accent);
  }

  main { max-width: 1040px; margin: 0 auto; padding: 28px 20px 60px; }

  .crumb { color: var(--muted); font-size: 13px; margin-bottom: 18px; }

  h1 { font-family: "Rajdhani", "Manrope", sans-serif; font-size: 25px; font-weight: 700; margin: 0 0 4px; }
  h1 .tag-badge { padding: 2px 9px; border-radius: 6px; font-size: 14px; font-weight: 800; margin-right: 8px; }

  .meta-row {
    display: flex; gap: 22px; flex-wrap: wrap;
    color: var(--muted); font-size: 13px; margin: 10px 0 22px;
  }
  .meta-row strong { color: var(--text); }

  .hero {
    position: relative;
    overflow: hidden;
    border-radius: var(--radius);
    padding: 22px 24px;
    margin-bottom: 22px;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08), 0 10px 26px rgba(0,0,0,0.3);
  }
  /* The team's real tagColor is set inline as a flat fill (see above) -
     this overlay adds a soft glow + diagonal sheen on top of whatever
     that color is, so the banner reads like a lit card instead of a
     flat paint swatch, without needing a photo behind it. */
  .hero::before {
    content: "";
    position: absolute; inset: 0;
    background:
      radial-gradient(520px 200px at 85% -20%, rgba(255,255,255,0.22), transparent 60%),
      linear-gradient(120deg, rgba(255,255,255,0.1), transparent 40%),
      linear-gradient(0deg, rgba(0,0,0,0.18), transparent 55%);
    pointer-events: none;
  }
  /* A field of diagonal light-trail stripes, like a car's motion blur,
     masked so it only shows on the right ~45% of the banner - it reads
     as speed without ever crossing behind the team name/text on the
     left. */
  .hero::after {
    content: "";
    position: absolute; inset: 0;
    background: repeating-linear-gradient(100deg, rgba(255,255,255,0.16) 0 3px, transparent 3px 28px);
    -webkit-mask-image: linear-gradient(90deg, transparent 0%, transparent 54%, rgba(0,0,0,1) 80%, rgba(0,0,0,1) 100%);
    mask-image: linear-gradient(90deg, transparent 0%, transparent 54%, rgba(0,0,0,1) 80%, rgba(0,0,0,1) 100%);
    pointer-events: none;
  }
  .hero > * { position: relative; }
  .hero .name {
    font-family: "Rajdhani", "Manrope", sans-serif;
    font-size: 30px; font-weight: 700; letter-spacing: 0.3px;
  }
  .hero .sub { margin-top: 10px; font-size: 13px; opacity: 0.9; }
  .hero .meta-stats {
    display: flex; gap: 28px; margin-top: 14px; flex-wrap: wrap;
  }
  .hero .meta-stats .stat { font-size: 12px; opacity: 0.85; }
  .hero .meta-stats .stat b { display: block; font-size: 15px; font-weight: 800; opacity: 1; margin-top: 2px; }

  .req-bar {
    display: flex; gap: 28px; flex-wrap: wrap; align-items: center;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 20px;
    margin-bottom: 14px;
    font-size: 13px;
  }
  .req-bar .req { color: var(--muted); }
  .req-bar .req b { color: var(--text); font-weight: 700; }
  .req-bar a.req.discord-invite {
    color: var(--velocity);
    font-weight: 700;
    text-decoration: none;
    margin-left: auto;
  }
  .req-bar a.req.discord-invite:hover { text-decoration: underline; }

  .special-reqs {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 20px;
    margin-bottom: 22px;
    font-size: 13px;
    color: var(--muted);
  }
  .special-reqs .label {
    text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;
    color: var(--muted); font-weight: 700; margin-bottom: 6px;
  }
  .special-reqs .text { color: var(--text); line-height: 1.5; word-break: break-word; }

  .activity-chart {
    display: flex; align-items: flex-end; gap: 4px;
    height: 160px;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 12px 10px;
    margin-bottom: 8px;
  }
  .activity-bar {
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: flex-end; height: 100%; min-width: 0;
  }
  .activity-bar .bar {
    width: 100%; max-width: 18px; height: var(--h);
    background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px;
  }
  .activity-bar .bar-label {
    font-size: 10px; color: var(--muted); margin-top: 6px; height: 14px;
    white-space: nowrap;
  }

  .index-header {
    display: flex; justify-content: space-between; align-items: flex-end;
    flex-wrap: wrap; gap: 12px; margin-bottom: 18px;
  }
  .search-box input {
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 9px 12px;
    font-family: inherit;
    font-size: 13px;
    width: 220px;
  }
  .search-box input:focus { outline: 1px solid var(--accent); }
  .search-box input::placeholder { color: var(--muted); }

  .card .req-line { font-size: 12px; color: var(--muted); }
  .card .req-line b { color: var(--text); }
  .card .view-link {
    margin-top: 4px;
    display: inline-block;
    color: var(--card-accent, var(--accent));
    font-weight: 700;
    font-size: 12.5px;
    align-self: flex-start;
  }
  .card .view-link:hover { text-decoration: underline; }

  .role-pill {
    display: inline-block;
    font-size: 10.5px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    padding: 1px 6px;
    border-radius: 5px;
    margin-left: 7px;
    vertical-align: middle;
  }
  .role-pill.captain { background: rgba(255,176,32,0.18); color: var(--ok); }
  .role-pill.officer { background: rgba(41,211,255,0.16); color: var(--velocity); }
  .role-pill.gold { background: rgba(255,176,32,0.12); color: var(--ok); }

  .squad-pill {
    display: inline-block;
    font-size: 10.5px;
    font-weight: 800;
    padding: 1px 7px;
    border-radius: 5px;
    margin-left: 7px;
    vertical-align: middle;
    border: 1px solid;
  }
  .squad-swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    margin-right: 8px;
    vertical-align: middle;
  }

  .team-layout {
    display: flex;
    gap: 20px;
    align-items: flex-start;
  }
  .team-sidebar {
    width: 190px;
    flex: none;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px;
    position: sticky;
    top: 20px;
    display: flex;
    flex-direction: column;
  }
  .team-sidebar .nav-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 10px;
    border-radius: 8px;
    color: var(--text);
    font-size: 13.5px;
    font-weight: 600;
    margin-bottom: 2px;
  }
  .team-sidebar .nav-item:hover { background: var(--panel-2); text-decoration: none; }
  .team-sidebar .nav-item.active { background: rgba(255,176,32,0.15); color: var(--accent); }
  .team-sidebar .nav-icon { font-size: 14px; flex: none; opacity: 0.9; }
  .team-sidebar .soon-tag {
    margin-left: auto;
    font-size: 9px;
    background: rgba(170,178,192,0.15);
    color: var(--muted);
    padding: 2px 6px;
    border-radius: 999px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .team-sidebar .nav-section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    font-weight: 700;
    padding: 12px 10px 4px;
  }
  .team-content { flex: 1; min-width: 0; }

  @media (max-width: 760px) {
    .team-layout { flex-direction: column; }
    .team-sidebar {
      width: 100%;
      position: static;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 4px;
    }
    .team-sidebar .nav-section-label { display: none; }
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 14px;
  }
  /* Each card carries its own team's color as --card-accent (set inline
     per card), used for the top edge, the hover glow, and the "View
     roster" link below - so a grid of teams reads as a grid of
     distinct teams, not one repeated card shape in a neutral blue. */
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-top: 3px solid var(--card-accent, var(--accent));
    border-radius: var(--radius);
    padding: 15px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 14px 28px color-mix(in srgb, var(--card-accent, var(--accent)) 30%, transparent);
  }
  .card .top { display: flex; align-items: center; gap: 10px; }
  /* The tag (short, stable) links to this team's own TypeTrack page;
     the full name links out to the team's real Nitro Type page - two
     different destinations, so they get two separate link targets
     instead of one link covering the whole header. */
  .card .tag { font-weight: 800; font-size: 14px; color: var(--card-accent, var(--accent)); }
  .card .tag:hover { text-decoration: underline; }
  .card .display-name {
    font-family: "Rajdhani", "Manrope", sans-serif;
    color: var(--text); font-weight: 600; font-size: 15px;
  }
  .card .display-name:hover { text-decoration: underline; color: var(--card-accent, var(--accent)); }
  .card .footer { margin-top: auto; font-size: 11.5px; color: var(--muted); }
  .card a.cover { position: static; }
  .card a.view { align-self: flex-start; font-size: 12.5px; font-weight: 700; }

  .empty {
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    padding: 28px;
    color: var(--muted);
    text-align: center;
    font-size: 14px;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: 0 8px 20px rgba(0,0,0,0.18);
  }
  table { width: 100%; border-collapse: collapse; min-width: 560px; }
  thead th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    font-weight: 700;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
    position: sticky; top: 0;
  }
  /* Numeric/stat columns read like a data table (StarTrack-style) when
     the digits line up on a fixed grid instead of a variable-width
     text font - tabular-nums keeps this in Manrope rather than
     switching the whole row to monospace. */
  tbody td {
    padding: 11px 14px;
    font-size: 13.5px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:nth-child(even) { background: rgba(255,255,255,0.015); }
  tbody tr:hover { background: rgba(41,211,255,0.06); }
  td.racer { display: flex; align-items: center; gap: 10px; white-space: nowrap; }
  .avatar {
    width: 26px; height: 26px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 800; color: #0b1220;
    flex: none;
    box-shadow: 0 0 0 2px rgba(255,255,255,0.08), 0 2px 6px rgba(0,0,0,0.3);
  }
  .car-thumb {
    height: 22px; width: auto; max-width: 42px;
    object-fit: contain; flex: none;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.4));
  }
  .stats-link {
    display: inline-block; margin-left: 2px; font-size: 12px;
    text-decoration: none; opacity: 0.75;
  }
  .stats-link:hover { opacity: 1; text-decoration: none; }

  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
  }
  .pill.good { background: rgba(61,220,132,0.15); color: var(--good); }
  .pill.ok   { background: rgba(232,197,71,0.15); color: var(--ok); }
  .pill.low  { background: rgba(255,107,107,0.15); color: var(--low); }
  .pill.na   { background: rgba(170,178,192,0.12); color: var(--muted); }

  .notif-day { margin-bottom: 22px; }
  .notif-date { font-weight: 800; font-size: 13.5px; margin-bottom: 8px; }
  .notif-item {
    display: flex; align-items: flex-start; gap: 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
    margin-bottom: 8px;
  }
  .notif-icon { font-size: 18px; line-height: 1; flex: none; margin-top: 1px; }
  .notif-headline { font-size: 13.5px; color: var(--text); }
  .notif-meta { font-size: 11.5px; color: var(--muted); margin-top: 3px; }

  .lb-controls {
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: 10px;
    margin-bottom: 18px;
  }
  .seg {
    display: inline-flex;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 3px;
    gap: 2px;
  }
  .seg-btn {
    background: transparent;
    border: none;
    color: var(--muted);
    font-family: inherit;
    font-weight: 700;
    font-size: 12.5px;
    padding: 7px 13px;
    border-radius: 7px;
    cursor: pointer;
  }
  .seg-btn:hover { color: var(--text); }
  .seg-btn.active { background: var(--accent); color: #0b1220; }
  .seg-btn .soon-tag { vertical-align: 1px; }

  .lb-rank {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px; height: 24px;
    border-radius: 7px;
    font-size: 12px;
    font-weight: 800;
    font-family: "Roboto Mono", "Courier New", monospace;
    background: var(--panel-2);
    color: var(--muted);
  }
  /* Podium colors get a filled badge + soft glow instead of just a
     tinted background, so #1-3 actually pop out of the list the way
     a medal would, not just read as "slightly different gray". */
  .lb-rank.top1 {
    background: linear-gradient(135deg, #ffd166, #e8a93a);
    color: #3a2a00;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.15) inset, 0 2px 8px rgba(232,169,58,0.45);
  }
  .lb-rank.top2 {
    background: linear-gradient(135deg, #e3e8f2, #aab4c6);
    color: #1c2330;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.15) inset, 0 2px 8px rgba(170,180,198,0.35);
  }
  .lb-rank.top3 {
    background: linear-gradient(135deg, #ff9d66, #d9703a);
    color: #3a1a00;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.15) inset, 0 2px 8px rgba(217,112,58,0.4);
  }

  .lb-team-tag {
    display: inline-block;
    font-size: 11px;
    font-weight: 800;
    padding: 2px 7px;
    border-radius: 6px;
    margin-left: 8px;
    text-decoration: none;
  }
  .lb-team-tag:hover { text-decoration: none; opacity: 0.85; }
  td.racer a { color: inherit; }
  td.racer a:hover { text-decoration: underline; }

  /* Points is the one number every leaderboard page is organized around -
     it's the only place --velocity (cyan) appears, so it reads as the
     stat that matters rather than another UI color. */
  .points {
    font-weight: 700;
    color: var(--velocity);
    font-size: 14px;
    font-family: "Roboto Mono", "Courier New", monospace;
    letter-spacing: 0.2px;
  }
  .lb-score-note {
    color: var(--muted);
    font-size: 12px;
    margin: 10px 2px 0;
  }

  /* Tournament bracket - a side-scrolling row of round columns, each
     column's matches spaced out with flex gap rather than real connector
     lines (no SVG/canvas tree) - a deliberate simplification given no
     fixed per-match height to route lines between. */
  .bracket-wrap { overflow-x: auto; padding-bottom: 6px; }
  .bracket-grid { display: flex; gap: 26px; min-width: max-content; }
  .bracket-col { display: flex; flex-direction: column; justify-content: space-around; gap: 14px; min-width: 172px; }
  .bracket-col-title {
    font-size: 11.5px; font-weight: 800; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.05em;
    margin-bottom: 8px; text-align: center;
  }
  .bracket-match { display: flex; flex-direction: column; gap: 3px; }
  .bracket-slot {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 9px; border-radius: 7px;
    background: var(--panel-2); border: 1px solid var(--border);
    font-size: 12.5px; white-space: nowrap;
  }
  .bracket-slot-empty { color: var(--muted); justify-content: center; }
  .bracket-slot-winner { border-color: var(--accent); background: rgba(255,176,32,0.12); font-weight: 700; }
  .bracket-seed { color: var(--muted); font-size: 11px; width: 16px; flex: none; }
  .bracket-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .bracket-score { color: var(--velocity); font-weight: 700; font-size: 12px; flex: none; }
  .bracket-dnq { color: var(--low); font-size: 10px; font-weight: 800; flex: none; }

  footer.site {
    text-align: center;
    color: var(--muted);
    font-size: 12px;
    padding: 30px 20px 50px;
  }

  @media (max-width: 560px) {
    main { padding: 20px 14px 50px; }
    .hero .name { font-size: 21px; }
  }

  /* Forms - account pages (sign in/up, connect) and the captain events
     manager share this small set of classes. */
  .form-input {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 10px 12px;
    font: inherit;
    font-family: "Manrope", -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .form-input:focus { outline: 1px solid var(--accent); }
  .form-input::placeholder { color: var(--muted); }
  label.form-input-wrap { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
  .btn-primary, .btn-secondary, .btn-danger {
    font: inherit;
    font-weight: 700;
    font-size: 13.5px;
    border-radius: 8px;
    padding: 10px 14px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .btn-primary { background: var(--accent); color: #06121f; }
  .btn-primary:hover { opacity: 0.9; }
  .btn-secondary { background: var(--panel-2); color: var(--text); border-color: var(--border); }
  .btn-secondary:hover { border-color: var(--accent); }
  .btn-danger { background: rgba(255,107,107,0.12); color: var(--low); border-color: rgba(255,107,107,0.3); }
  .btn-danger:hover { background: rgba(255,107,107,0.2); }
  .form-error { color: var(--low); font-size: 12.5px; }
  .form-note { font-size: 12.5px; }
  .site-nav-link[data-account-nav] { white-space: nowrap; }
`;

// teamsHref/leaderboardsHref are supplied by the caller because the two
// page builders resolve them completely differently: build.js's static
// pages need a relative path back up to each top-level section (depth
// varies per page), while server.js's Express routes just use fixed
// absolute paths. `active` highlights whichever one the current page is.
function siteHeader({ teamsHref = "./", leaderboardsHref = "leaderboards/", accountHref = "account/", active = "" } = {}) {
  return `
    <header class="site">
      <div class="mark">T</div>
      <div class="name">TypeTrack</div>
      <nav class="site-nav">
        <a class="site-nav-link${active === "teams" ? " active" : ""}" href="${teamsHref}">Teams</a>
        <a class="site-nav-link${active === "leaderboards" ? " active" : ""}" href="${leaderboardsHref}">Leaderboards</a>
        <a class="site-nav-link${active === "account" ? " active" : ""}" href="${accountHref}" data-account-nav>Account</a>
      </nav>
    </header>`;
}

// build.js's teamsHref is always "however many ../ segments get back to
// the site root", so accountHref and the shared client script's URL can
// both be derived from it there without a caller having to pass them in.
// server.js's routes use fixed absolute paths instead ("/teams", not a
// relative depth), so it passes accountHref/assetsHref explicitly rather
// than relying on this derivation.
function pageShell({ title, body, crumb, teamsHref, leaderboardsHref, accountHref, assetsHref, active }) {
  if (accountHref == null) accountHref = `${teamsHref}account/`;
  if (assetsHref == null) assetsHref = `${teamsHref}assets/app.js`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&family=Rajdhani:wght@600;700&family=Roboto+Mono:wght@500;700&display=swap" rel="stylesheet">
  <style>${BASE_CSS}</style>
</head>
<body>
<script src="${assetsHref}"></script>
${siteHeader({ teamsHref, leaderboardsHref, accountHref, active })}
<main>
${crumb ? `<div class="crumb">${crumb}</div>` : ""}
${body}
</main>
<footer class="site">Generated ${new Date().toISOString()}</footer>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  teamEmojiSuffix,
  hashHue,
  teamColor,
  textOnColor,
  avatarColor,
  accuracyClass,
  formatDate,
  roleBadge,
  membershipBadge,
  squadBadge,
  racerRosterRows,
  NAV_ITEMS,
  MANAGE_NAV_ITEMS,
  teamAdminBody,
  teamSidebar,
  comingSoonBody,
  LEADERBOARD_RANGES,
  comingSoonLeaderboard,
  leaderboardPanel,
  leaderboardControls,
  rankBadgeClass,
  nitroTypeTeamHref,
  nitroTypeRacerHref,
  leaderboardsBody,
  TRACKER_RANGES,
  trackerBody,
  activityBody,
  eventsBody,
  tournamentsBody,
  racerStatsBody,
  notificationsBody,
  pageShell,
  carImageSourceUrl,
  carImageLocalFile,
};

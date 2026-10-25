// TypeTrack account / captain-events client logic.
//
// Runs only in the browser - never during the static build (build.js just
// copies this file verbatim into site/assets/app.js, and server.js serves
// it straight from this directory for local preview).
//
// Uses Supabase's publishable (anon) key, which is meant to be public and
// is safe to ship in client code: every table this talks to is protected
// by Row Level Security (see schema.sql), and the one operation that must
// never be left to the client - proving someone owns a Nitro Type account -
// is handled entirely server-side by the verify-car-swap Edge Function.
(function () {
  "use strict";

  var SUPABASE_URL = "https://pbnolrgiqpnfmbvgemcy.supabase.co";
  // Legacy (JWT-format) anon key, not the new sb_publishable_... key -
  // the project's gateway was rejecting the new-format key outright for
  // every endpoint (Auth, REST, and Edge Functions alike) at the time this
  // was written, most likely tied to a live Supabase platform incident
  // ("Elevated Mgmt API Error Rates in Multiple Regions"). This legacy key
  // is just as public/browser-safe by Supabase's own design - RLS is what
  // actually protects the data, not which key format asks for it.
  var SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBibm9scmdpcXBuZm1idmdlbWN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2MjgwNTYsImV4cCI6MjEwODIwNDA1Nn0.YMUXinEwYRQcYOa2yXGXbcPkdN_ExjNniUeGqSz11Lw";

  var _client = null;
  function withClient(cb) {
    if (_client) return cb(_client);
    if (window.supabase && window.supabase.createClient) {
      _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return cb(_client);
    }
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
    s.onload = function () {
      _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      cb(_client);
    };
    s.onerror = function () {
      console.error("TypeTrack: could not load the Supabase client library.");
    };
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------
  // Small helpers shared by every page that uses this file.
  // ---------------------------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function eventStatus(ev, now) {
    now = now || new Date();
    var start = new Date(ev.start_stamp);
    var end = new Date(ev.end_stamp);
    if (now < start) return "pending";
    if (now > end) return "ended";
    return "active";
  }

  function statusPill(status) {
    var label = status === "pending" ? "Upcoming" : status === "active" ? "Happening now" : "Ended";
    var cls = status === "pending" ? "ok" : status === "active" ? "good" : "na";
    return '<span class="pill ' + cls + '">' + label + "</span>";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------
  function getSession(cb) {
    withClient(function (sb) {
      sb.auth.getSession().then(function (res) {
        cb(res.data && res.data.session ? res.data.session : null, sb);
      });
    });
  }

  function signUp(email, password, cb) {
    withClient(function (sb) {
      sb.auth.signUp({ email: email, password: password }).then(function (res) {
        cb(res.error ? res.error.message : null, res.data);
      });
    });
  }

  function signIn(email, password, cb) {
    withClient(function (sb) {
      sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        cb(res.error ? res.error.message : null, res.data);
      });
    });
  }

  function signOut(cb) {
    withClient(function (sb) {
      sb.auth.signOut().then(function () {
        cb && cb();
      });
    });
  }

  // "Connect first" flow: the visitor proves ownership of a Nitro Type
  // account BEFORE they ever pick a TypeTrack email/username/password.
  // That needs *some* signed-in Supabase session to exist already (the
  // verify-car-swap Edge Function and the RLS policies on account_links /
  // verification_challenges are both anchored to auth.uid()) - an
  // anonymous Supabase Auth session is exactly that: a real auth.users row
  // with no email/password yet. Requires "Allow anonymous sign-ins" to be
  // turned on for this project (Supabase dashboard -> Authentication ->
  // Sign In / Providers -> Anonymous Sign-Ins); until that's on,
  // signInAnonymously resolves with an error and getOrCreateSession below
  // surfaces it as a normal error message rather than throwing.
  function getOrCreateSession(cb) {
    withClient(function (sb) {
      sb.auth.getSession().then(function (res) {
        var session = res.data && res.data.session ? res.data.session : null;
        if (session) {
          cb(null, session, sb);
          return;
        }
        sb.auth.signInAnonymously().then(function (res2) {
          if (res2.error) {
            cb(res2.error.message, null, sb);
            return;
          }
          cb(null, res2.data.session, sb);
        });
      });
    });
  }

  // Turns the visitor's current session (anonymous or not) into a real,
  // permanent TypeTrack login by attaching an email + password to it. The
  // auth_user_id never changes, so any account_links / verification_challenges
  // row already tied to this session (from the car-swap check) carries
  // straight over - nothing about the verification needs to be redone.
  //
  // Nitro Type usernames aren't email addresses, and a captain/officer's
  // account doesn't collect one at all per the current design, so both
  // paths synthesize a private, never-shown address under a dedicated
  // subdomain scoped to this project, built only from stable Nitro Type
  // ids - never guessable from someone else's real email, and never used
  // to actually send mail.
  function syntheticEmail(ntUserId) {
    return "nt" + ntUserId + "@racers.typetrack.internal";
  }

  // This used to call sb.auth.updateUser({ email, password }) straight
  // from the browser with the anon key. That goes through Supabase's
  // normal "secure email change" flow, which tries to SEND a confirmation
  // email to the new address on every single claim - and the address is
  // always synthetic/unreachable (see syntheticEmail above), so that
  // email could never be clicked anyway, while still burning the
  // project's shared-SMTP rate limit until claims started failing outright
  // with "email rate limit exceeded". The claim-account Edge Function
  // does the equivalent update server-side with the service-role key via
  // auth.admin.updateUserById(..., { email_confirm: true }), which skips
  // the confirmation email entirely - nothing is ever sent. The ntUserId
  // argument is kept for backward compatibility with existing callers but
  // isn't actually trusted: the Edge Function resolves it itself from the
  // caller's own account_links row.
  function claimAccount(ntUserId, password, cb) {
    withClient(function (sb) {
      sb.functions.invoke("claim-account", { body: { password: password } }).then(function (res) {
        if (res.error) {
          var msg = res.error.message || "Could not finish setting up your account.";
          (res.error.context && res.error.context.json ? res.error.context.json() : Promise.resolve(null)).then(function (body) {
            cb((body && body.error) || msg, null);
          }).catch(function () {
            cb(msg, null);
          });
          return;
        }
        cb(null, res.data);
      });
    });
  }

  // Lets an already-signed-in visitor set a new password for themselves.
  // Safe to do straight from the browser with the anon key, unlike
  // claimAccount above - a password-only update never touches the user's
  // email, so it never goes through Supabase's "secure email change"
  // confirmation flow and never sends mail. (Supabase's "Secure password
  // change" / "Require current password" project settings are both off
  // for this project, so this works from any signed-in session without
  // extra re-auth friction.)
  function changePassword(newPassword, cb) {
    withClient(function (sb) {
      sb.auth.updateUser({ password: newPassword }).then(function (res) {
        cb(res.error ? res.error.message : null, res.data);
      });
    });
  }

  // Looks up the Nitro Type racer (if any) this signed-in account has
  // verified ownership of. account_links is publicly readable (see
  // schema.sql), so this is a plain select.
  function getMyLink(userId, cb) {
    withClient(function (sb) {
      sb.from("account_links")
        .select("nt_user_id, verified_at")
        .eq("auth_user_id", userId)
        .maybeSingle()
        .then(function (res) {
          cb(res.error ? res.error.message : null, res.data);
        });
    });
  }

  function getRacerById(ntUserId, cb) {
    withClient(function (sb) {
      sb.from("racers")
        .select("nt_user_id, username, display_name, team_tag")
        .eq("nt_user_id", ntUserId)
        .maybeSingle()
        .then(function (res) {
          cb(res.error ? res.error.message : null, res.data);
        });
    });
  }

  function getProfile(authUserId, cb) {
    withClient(function (sb) {
      sb.from("profiles")
        .select("chosen_username")
        .eq("auth_user_id", authUserId)
        .maybeSingle()
        .then(function (res) {
          cb(res.error ? res.error.message : null, res.data);
        });
    });
  }

  function setChosenUsername(authUserId, username, cb) {
    withClient(function (sb) {
      sb.from("profiles")
        .upsert({ auth_user_id: authUserId, chosen_username: username })
        .then(function (res) {
          cb(res.error ? res.error.message : null, res.data);
        });
    });
  }

  function isTeamOfficer(teamTag, ntUserId, cb) {
    withClient(function (sb) {
      sb.from("team_officers")
        .select("nt_user_id")
        .eq("team_tag", teamTag)
        .eq("nt_user_id", ntUserId)
        .maybeSingle()
        .then(function (res) {
          cb(res.error ? res.error.message : null, !!res.data);
        });
    });
  }

  function listTeamOfficers(teamTag, cb) {
    withClient(function (sb) {
      sb.from("team_officers")
        .select("nt_user_id")
        .eq("team_tag", teamTag)
        .then(function (res) {
          cb(res.error ? res.error.message : null, (res.data || []).map(function (r) { return r.nt_user_id; }));
        });
    });
  }

  function addTeamOfficer(teamTag, ntUserId, cb) {
    withClient(function (sb) {
      sb.from("team_officers")
        .insert({ team_tag: teamTag, nt_user_id: ntUserId })
        .then(function (res) {
          cb(res.error ? res.error.message : null);
        });
    });
  }

  function removeTeamOfficer(teamTag, ntUserId, cb) {
    withClient(function (sb) {
      sb.from("team_officers")
        .delete()
        .eq("team_tag", teamTag)
        .eq("nt_user_id", ntUserId)
        .then(function (res) {
          cb(res.error ? res.error.message : null);
        });
    });
  }

  // ---------------------------------------------------------------------
  // Squads (see team_squads in schema.sql) - a captain's own sub-groups
  // within their team. Same ownership-via-RLS model as officers: anyone
  // can read, only that team's own verified captain can write, enforced
  // server-side (not just hidden client-side), so these calls fail
  // harmlessly for a non-captain even if somehow invoked.
  // ---------------------------------------------------------------------
  function loadSquads(teamTag, cb) {
    withClient(function (sb) {
      sb.from("team_squads")
        .select("id, name, color")
        .eq("team_tag", teamTag)
        .order("name")
        .then(function (res) {
          cb(res.error ? res.error.message : null, res.data || []);
        });
    });
  }

  function createSquad(teamTag, name, color, cb) {
    withClient(function (sb) {
      sb.from("team_squads")
        .insert({ team_tag: teamTag, name: name, color: color })
        .then(function (res) {
          cb(res.error ? res.error.message : null);
        });
    });
  }

  function deleteSquad(squadId, cb) {
    withClient(function (sb) {
      sb.from("team_squads")
        .delete()
        .eq("id", squadId)
        .then(function (res) {
          cb(res.error ? res.error.message : null);
        });
    });
  }

  // null squadId clears a racer's assignment ("No squad") - squad_id is
  // nullable and the column-scoped grant in schema.sql only ever allows
  // writing this one column on racers, nothing else.
  function updateRacerSquad(ntUserId, squadId, cb) {
    withClient(function (sb) {
      sb.from("racers")
        .update({ squad_id: squadId })
        .eq("nt_user_id", ntUserId)
        .then(function (res) {
          cb(res.error ? res.error.message : null);
        });
    });
  }

  // "captain" | "officer" | "member" - the three tiers the latest design
  // calls out. Captain is decided purely from teams.captain_nt_user_id
  // (the same source of truth events.js's RLS policy itself trusts);
  // officer from team_officers; anything else (including a racer who
  // isn't currently on team_tag's team at all) is "member".
  function resolveTeamRole(teamTag, ntUserId, captainNtUserId, cb) {
    if (captainNtUserId != null && String(ntUserId) === String(captainNtUserId)) {
      cb(null, "captain");
      return;
    }
    if (!teamTag) {
      cb(null, "member");
      return;
    }
    isTeamOfficer(teamTag, ntUserId, function (err, isOfficer) {
      cb(err, isOfficer ? "officer" : "member");
    });
  }

  // ---------------------------------------------------------------------
  // Verification (the Edge Function does the actual work - this just
  // invokes it with the signed-in user's session attached automatically).
  // ---------------------------------------------------------------------
  function startVerification(username, cb) {
    withClient(function (sb) {
      sb.functions.invoke("verify-car-swap", { body: { action: "start", username: username } }).then(function (res) {
        if (res.error) {
          var msg = res.error.message || "Could not start verification.";
          (res.error.context && res.error.context.json ? res.error.context.json() : Promise.resolve(null)).then(function (body) {
            cb((body && body.error) || msg, null);
          }).catch(function () {
            cb(msg, null);
          });
          return;
        }
        cb(null, res.data);
      });
    });
  }

  function checkVerification(cb) {
    withClient(function (sb) {
      sb.functions.invoke("verify-car-swap", { body: { action: "check" } }).then(function (res) {
        if (res.error) {
          var msg = res.error.message || "Could not check verification.";
          (res.error.context && res.error.context.json ? res.error.context.json() : Promise.resolve(null)).then(function (body) {
            cb((body && body.error) || msg, null);
          }).catch(function () {
            cb(msg, null);
          });
          return;
        }
        cb(null, res.data);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Team events - public read is always live (not just at build time), so
  // this page's list refreshes itself on load even though it's otherwise
  // static HTML. Writes only succeed server-side (via RLS) for that team's
  // verified real captain, and the only place to make them is Team Admin's
  // own Events tab (see initTeamAdminPage below) - this public page is
  // read-only for everyone.
  // ---------------------------------------------------------------------
  function loadTeamEvents(teamTag, cb) {
    withClient(function (sb) {
      sb.from("events")
        .select("id, title, description, start_stamp, end_stamp")
        .eq("team_tag", teamTag)
        .order("start_stamp", { ascending: false })
        .then(function (res) {
          cb(res.error ? res.error.message : null, res.data || []);
        });
    });
  }

  function renderEventsTable(events) {
    if (!events.length) {
      return (
        '<div class="empty" style="padding:40px 24px;">No events scheduled for this team yet.</div>'
      );
    }
    var rows = events
      .map(function (ev) {
        var status = eventStatus(ev);
        return (
          "<tr>" +
          "<td><b>" +
          escapeHtml(ev.title) +
          "</b>" +
          (ev.description
            ? '<div style="color:var(--muted);font-size:12.5px;margin-top:3px;max-width:420px;white-space:normal;">' +
              escapeHtml(ev.description) +
              "</div>"
            : "") +
          "</td>" +
          "<td>" +
          statusPill(status) +
          "</td>" +
          "<td>" +
          fmtDate(ev.start_stamp) +
          "</td>" +
          "<td>" +
          fmtDate(ev.end_stamp) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
    return (
      '<div class="table-wrap"><table><thead><tr><th>Event</th><th>Status</th><th>Starts</th><th>Ends</th></tr></thead><tbody>' +
      rows +
      "</tbody></table></div>"
    );
  }

  function toLocalInputValue(iso) {
    var d = iso ? new Date(iso) : new Date();
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function renderCaptainManager(container, teamTag, events, refresh) {
    container.innerHTML = "";
    var wrap = el("div", { class: "card", style: "margin-top:18px;max-width:640px;" });
    wrap.appendChild(el("div", { style: "font-weight:700;margin-bottom:10px;", text: "Manage events (captain)" }));

    var list = el("div", { style: "display:flex;flex-direction:column;gap:10px;margin-bottom:16px;" });
    events.forEach(function (ev) {
      var row = el("div", { class: "card", style: "padding:12px;" });
      row.innerHTML =
        "<div style='font-weight:700;'>" +
        escapeHtml(ev.title) +
        "</div><div style='color:var(--muted);font-size:12.5px;margin:2px 0 8px;'>" +
        fmtDate(ev.start_stamp) +
        " → " +
        fmtDate(ev.end_stamp) +
        (ev.description ? "<br>" + escapeHtml(ev.description) : "") +
        "</div>";
      var delBtn = el("button", { type: "button", class: "btn-danger", text: "Delete" });
      delBtn.addEventListener("click", function () {
        if (!confirm('Delete "' + ev.title + '"?')) return;
        withClient(function (sb) {
          sb.from("events")
            .delete()
            .eq("id", ev.id)
            .then(function (res) {
              if (res.error) {
                alert("Could not delete: " + res.error.message);
                return;
              }
              refresh();
            });
        });
      });
      row.appendChild(delBtn);
      list.appendChild(row);
    });
    wrap.appendChild(list);

    var form = el("form", { style: "display:flex;flex-direction:column;gap:8px;" });
    form.innerHTML =
      '<input class="form-input" name="title" placeholder="Event title" required>' +
      '<textarea class="form-input" name="description" placeholder="Description (optional)" rows="2"></textarea>' +
      '<label style="font-size:12px;color:var(--muted);">Starts<input class="form-input" name="start" type="datetime-local" required value="' +
      toLocalInputValue() +
      '"></label>' +
      '<label style="font-size:12px;color:var(--muted);">Ends<input class="form-input" name="end" type="datetime-local" required value="' +
      toLocalInputValue(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()) +
      '"></label>' +
      '<button type="submit" class="btn-primary">Add event</button>' +
      '<div class="form-error" style="display:none;"></div>';
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var title = (fd.get("title") || "").toString().trim();
      var description = (fd.get("description") || "").toString().trim();
      var start = fd.get("start");
      var end = fd.get("end");
      var errorEl = form.querySelector(".form-error");
      errorEl.style.display = "none";
      if (!title || !start || !end) return;
      withClient(function (sb) {
        sb.from("events")
          .insert({
            team_tag: teamTag,
            title: title,
            description: description || null,
            start_stamp: new Date(start).toISOString(),
            end_stamp: new Date(end).toISOString(),
          })
          .then(function (res) {
            if (res.error) {
              errorEl.textContent = res.error.message;
              errorEl.style.display = "";
              return;
            }
            form.reset();
            refresh();
          });
      });
    });
    wrap.appendChild(form);
    container.appendChild(wrap);
  }

  function initEventsPage() {
    var panel = document.querySelector("[data-events-panel]");
    if (!panel) return;
    var teamTag = panel.getAttribute("data-team-tag");
    var listTarget = panel.querySelector("[data-events-list]");

    function refresh() {
      loadTeamEvents(teamTag, function (err, events) {
        if (err) return;
        if (listTarget) listTarget.innerHTML = renderEventsTable(events);
      });
    }

    refresh();
  }

  // ---------------------------------------------------------------------
  // Tournament brackets (see team_tournaments/tournament_teams/
  // tournament_rounds in schema.sql) - management only, used from Team
  // Admin's own Tournaments tab (see initTeamAdminPage below). The public
  // Tournaments page's actual bracket - seeding, round-by-round scoring,
  // winners - is computed server-side (src/tournaments-data.js's
  // buildBracket) and rendered at build/request time; replicating that
  // whole algorithm here just to recompute it live in the browser isn't
  // worth the duplication risk, so the public page simply reflects
  // whatever the last sync/build produced, same as every other board.
  // ---------------------------------------------------------------------
  var BRACKET_ROUNDS = [
    { key: "seeding", label: "Seeding" },
    { key: "r64", label: "Round of 64" },
    { key: "r32", label: "Round of 32" },
    { key: "r16", label: "Sweet 16" },
    { key: "r8", label: "Elite 8" },
    { key: "r4", label: "Final 4" },
    { key: "championship", label: "Championship" },
  ];
  var SCORING_FIELDS = [
    { key: "points", label: "Points" },
    { key: "races", label: "Races" },
    { key: "avg_speed", label: "Avg speed" },
    { key: "accuracy", label: "Accuracy" },
  ];

  function scoringLabel(key) {
    var found = SCORING_FIELDS.filter(function (s) { return s.key === key; })[0];
    return found ? found.label : "Points";
  }

  function loadAdminTournaments(teamTag, cb) {
    withClient(function (sb) {
      sb.from("team_tournaments")
        .select("id, title, description, scoring_field, qualifying_races")
        .eq("team_tag", teamTag)
        .order("id", { ascending: false })
        .then(function (res) {
          if (res.error) { cb(res.error.message, []); return; }
          var tournaments = res.data || [];
          if (!tournaments.length) { cb(null, []); return; }
          var ids = tournaments.map(function (t) { return t.id; });
          Promise.all([
            sb.from("tournament_teams").select("tournament_id, team_tag").in("tournament_id", ids),
            sb.from("tournament_rounds").select("tournament_id, round_key, round_order, label, start_stamp, end_stamp").in("tournament_id", ids).order("round_order"),
          ]).then(function (results) {
            var teamsByT = {};
            (results[0].data || []).forEach(function (r) {
              (teamsByT[r.tournament_id] = teamsByT[r.tournament_id] || []).push(r.team_tag);
            });
            var roundsByT = {};
            (results[1].data || []).forEach(function (r) {
              (roundsByT[r.tournament_id] = roundsByT[r.tournament_id] || []).push(r);
            });
            tournaments.forEach(function (t) {
              t.teams = teamsByT[t.id] || [];
              t.rounds = roundsByT[t.id] || [];
            });
            cb(null, tournaments);
          });
        });
    });
  }

  function deleteTournamentFull(id, cb) {
    withClient(function (sb) {
      sb.from("team_tournaments").delete().eq("id", id).then(function (res) {
        cb(res.error ? res.error.message : null);
      });
    });
  }

  // payload: {title, description, teams:[tags], scoring_field,
  // qualifying_races, rounds:[{key,label,order,start,end}]} - inserts the
  // tournament row first (so its id exists), then its participant teams
  // and round schedule. Not wrapped in a DB transaction (PostgREST can't
  // do that from the browser); a failure partway through leaves an
  // incomplete tournament the captain can just delete and redo - acceptable
  // for a captain-only admin action that isn't money or anything
  // destructive to anyone else.
  function createTournamentFull(teamTag, payload, cb) {
    withClient(function (sb) {
      sb.from("team_tournaments")
        .insert({
          team_tag: teamTag,
          title: payload.title,
          description: payload.description || null,
          start_stamp: payload.rounds[0].start,
          end_stamp: payload.rounds[payload.rounds.length - 1].end,
          scoring_field: payload.scoring_field,
          qualifying_races: payload.qualifying_races,
        })
        .select("id")
        .single()
        .then(function (res) {
          if (res.error) { cb(res.error.message); return; }
          var tournamentId = res.data.id;
          var teamRows = payload.teams.map(function (tag) { return { tournament_id: tournamentId, team_tag: tag }; });
          var roundRows = payload.rounds.map(function (r) {
            return { tournament_id: tournamentId, round_key: r.key, round_order: r.order, label: r.label, start_stamp: r.start, end_stamp: r.end };
          });
          Promise.all([
            sb.from("tournament_teams").insert(teamRows),
            sb.from("tournament_rounds").insert(roundRows),
          ]).then(function (results) {
            var err = results[0].error || results[1].error;
            cb(err ? err.message : null);
          });
        });
    });
  }

  function renderAdminTournamentSummary(t) {
    var roundsLine = (t.rounds || [])
      .map(function (r) { return escapeHtml(r.label) + ": " + fmtDate(r.start_stamp) + " → " + fmtDate(r.end_stamp); })
      .join(" · ");
    return (
      "<div style='font-weight:700;'>" + escapeHtml(t.title) + "</div>" +
      "<div style='color:var(--muted);font-size:12px;margin:2px 0 6px;'>Teams: " +
      (t.teams || []).map(function (tg) { return "[" + escapeHtml(tg) + "]"; }).join(" ") +
      " · Scored by " + escapeHtml(scoringLabel(t.scoring_field)) +
      (t.qualifying_races ? " · Min " + t.qualifying_races + " races/round" : "") +
      "</div>" +
      (t.description ? "<div style='color:var(--muted);font-size:12.5px;margin-bottom:6px;'>" + escapeHtml(t.description) + "</div>" : "") +
      "<div style='color:var(--muted);font-size:11.5px;'>" + roundsLine + "</div>"
    );
  }

  function renderAdminTournaments(container, teamTag, tournaments, refresh) {
    container.innerHTML = "";
    var list = el("div", { style: "display:flex;flex-direction:column;gap:10px;margin-bottom:16px;" });
    if (!tournaments.length) {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;">No tournaments yet.</div>';
    } else {
      tournaments.forEach(function (t) {
        var row = el("div", { class: "card", style: "padding:12px;" });
        row.innerHTML = renderAdminTournamentSummary(t);
        var delBtn = el("button", { type: "button", class: "btn-danger", text: "Delete" });
        delBtn.addEventListener("click", function () {
          if (!confirm('Delete "' + t.title + '" and its whole bracket?')) return;
          deleteTournamentFull(t.id, function (err) {
            if (err) { alert("Could not delete: " + err); return; }
            refresh();
          });
        });
        row.appendChild(delBtn);
        list.appendChild(row);
      });
    }
    container.appendChild(list);

    var form = el("form", { style: "display:flex;flex-direction:column;gap:10px;max-width:640px;" });
    var now = Date.now();
    var dayMs = 24 * 60 * 60 * 1000;

    var fieldsHtml =
      '<input class="form-input" name="title" placeholder="Tournament title" required>' +
      '<textarea class="form-input" name="description" placeholder="Description (optional)" rows="2"></textarea>' +
      '<input class="form-input" name="teams" placeholder="Participating team tags, space or comma separated" value="' +
      escapeHtml(teamTag) +
      '" required>' +
      '<div style="display:flex;gap:8px;">' +
      '<select class="form-input" name="scoring_field" style="flex:1;">' +
      SCORING_FIELDS.map(function (s) { return '<option value="' + s.key + '">' + escapeHtml(s.label) + "</option>"; }).join("") +
      "</select>" +
      '<input class="form-input" name="qualifying_races" type="number" min="0" placeholder="Min races/round (optional)" style="flex:1;">' +
      "</div>" +
      '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Round schedule:</div>';

    BRACKET_ROUNDS.forEach(function (r, i) {
      var startDefault = toLocalInputValue(new Date(now + i * dayMs).toISOString());
      var endDefault = toLocalInputValue(new Date(now + (i + 1) * dayMs).toISOString());
      fieldsHtml +=
        '<div style="display:flex;gap:8px;align-items:center;border-top:1px solid var(--border);padding-top:8px;flex-wrap:wrap;">' +
        '<span style="width:100px;flex:none;font-size:12.5px;font-weight:700;">' +
        escapeHtml(r.label) +
        "</span>" +
        '<label style="flex:1;min-width:150px;font-size:11px;color:var(--muted);">Starts<input class="form-input" name="round_' +
        r.key +
        '_start" type="datetime-local" required value="' +
        startDefault +
        '"></label>' +
        '<label style="flex:1;min-width:150px;font-size:11px;color:var(--muted);">Ends<input class="form-input" name="round_' +
        r.key +
        '_end" type="datetime-local" required value="' +
        endDefault +
        '"></label>' +
        "</div>";
    });

    fieldsHtml += '<button type="submit" class="btn-primary" style="margin-top:6px;">Create tournament</button><div class="form-error" style="display:none;"></div>';
    form.innerHTML = fieldsHtml;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var title = (fd.get("title") || "").toString().trim();
      var description = (fd.get("description") || "").toString().trim();
      var teams = (fd.get("teams") || "")
        .toString()
        .split(/[\s,]+/)
        .map(function (s) { return s.trim().toUpperCase(); })
        .filter(Boolean);
      var scoringField = (fd.get("scoring_field") || "points").toString();
      var qualifyingRaces = parseInt(fd.get("qualifying_races"), 10) || 0;
      var errorEl = form.querySelector(".form-error");
      errorEl.style.display = "none";
      if (!title || !teams.length) return;

      var rounds = [];
      for (var i = 0; i < BRACKET_ROUNDS.length; i++) {
        var r = BRACKET_ROUNDS[i];
        var startVal = fd.get("round_" + r.key + "_start");
        var endVal = fd.get("round_" + r.key + "_end");
        if (!startVal || !endVal) {
          errorEl.textContent = "Every round needs start and end dates.";
          errorEl.style.display = "";
          return;
        }
        var startIso = new Date(startVal).toISOString();
        var endIso = new Date(endVal).toISOString();
        if (endIso <= startIso) {
          errorEl.textContent = r.label + "'s end must be after its start.";
          errorEl.style.display = "";
          return;
        }
        rounds.push({ key: r.key, label: r.label, order: i, start: startIso, end: endIso });
      }

      createTournamentFull(
        teamTag,
        { title: title, description: description, teams: teams, scoring_field: scoringField, qualifying_races: qualifyingRaces, rounds: rounds },
        function (err) {
          if (err) {
            errorEl.textContent = err;
            errorEl.style.display = "";
            return;
          }
          form.reset();
          refresh();
        }
      );
    });

    container.appendChild(form);
  }

  // ---------------------------------------------------------------------
  // Team Admin: captain edits officers, officer views read-only, anyone
  // else gets no content at all - see theme.js's teamAdminBody for the
  // static shell this fills in.
  // ---------------------------------------------------------------------
  function renderOfficerRows(tbody, teamTag, officerIds, racersById, isCaptain, refresh) {
    if (!officerIds.length) {
      tbody.innerHTML = '<tr><td colspan="2" style="color:var(--muted);">No officers appointed yet.</td></tr>';
      return;
    }
    tbody.innerHTML = "";
    officerIds.forEach(function (ntUserId) {
      var racer = racersById[ntUserId];
      var name = (racer && (racer.display_name || racer.username)) || "racer " + ntUserId;
      var tr = document.createElement("tr");
      var nameTd = document.createElement("td");
      nameTd.textContent = name;
      tr.appendChild(nameTd);
      var actionTd = document.createElement("td");
      if (isCaptain) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-danger";
        btn.textContent = "Remove";
        btn.addEventListener("click", function () {
          removeTeamOfficer(teamTag, ntUserId, function (err) {
            if (!err) refresh();
          });
        });
        actionTd.appendChild(btn);
      }
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
  }

  // squads: [{id, name, color}]. Builds both the squad list table (with a
  // racer count per squad and a captain-only Delete button) and the
  // option list every per-racer <select> in the roster below reuses -
  // kept as one function since both need to stay in sync with the same
  // squads array on every refresh.
  function renderSquadRows(tbody, teamTag, squads, racersById, isCaptain, refresh) {
    if (!squads.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);">No squads yet.</td></tr>';
      return;
    }
    var counts = {};
    for (var id in racersById) {
      var sid = racersById[id].squad_id;
      if (sid != null) counts[sid] = (counts[sid] || 0) + 1;
    }
    tbody.innerHTML = "";
    squads.forEach(function (squad) {
      var tr = document.createElement("tr");
      var nameTd = document.createElement("td");
      var swatch = document.createElement("span");
      swatch.className = "squad-swatch";
      swatch.style.background = squad.color;
      nameTd.appendChild(swatch);
      nameTd.appendChild(document.createTextNode(squad.name));
      tr.appendChild(nameTd);
      var countTd = document.createElement("td");
      countTd.textContent = String(counts[squad.id] || 0);
      tr.appendChild(countTd);
      var actionTd = document.createElement("td");
      if (isCaptain) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-danger";
        btn.textContent = "Delete";
        btn.addEventListener("click", function () {
          deleteSquad(squad.id, function (err) {
            if (!err) refresh();
          });
        });
        actionTd.appendChild(btn);
      }
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
  }

  function squadSelectOptionsHtml(squads, currentSquadId) {
    var opts = '<option value="">No squad</option>';
    squads.forEach(function (squad) {
      var selected = String(currentSquadId == null ? "" : currentSquadId) === String(squad.id) ? " selected" : "";
      opts += '<option value="' + escapeHtml(squad.id) + '"' + selected + ">" + escapeHtml(squad.name) + "</option>";
    });
    return opts;
  }

  function renderSquadRosterRows(tbody, teamTag, squads, racers, isCaptain, refresh) {
    if (!racers.length) {
      tbody.innerHTML = '<tr><td colspan="2" style="color:var(--muted);">No racers synced yet.</td></tr>';
      return;
    }
    tbody.innerHTML = "";
    racers.forEach(function (racer) {
      var tr = document.createElement("tr");
      var nameTd = document.createElement("td");
      nameTd.textContent = racer.display_name || racer.username;
      tr.appendChild(nameTd);
      var selectTd = document.createElement("td");
      var select = document.createElement("select");
      select.className = "form-input";
      select.innerHTML = squadSelectOptionsHtml(squads, racer.squad_id);
      if (!isCaptain) select.setAttribute("disabled", "disabled");
      select.addEventListener("change", function () {
        var val = select.value ? Number(select.value) : null;
        updateRacerSquad(racer.nt_user_id, val, function (err) {
          if (!err) refresh();
        });
      });
      selectTd.appendChild(select);
      tr.appendChild(selectTd);
      tbody.appendChild(tr);
    });
  }

  function initTeamAdminPage() {
    var panel = document.querySelector("[data-admin-panel]");
    if (!panel) return;
    var teamTag = panel.getAttribute("data-team-tag");
    var captainNtUserId = panel.getAttribute("data-captain-nt-user-id") || null;
    var gate = panel.querySelector("[data-admin-gate]");
    var content = panel.querySelector("[data-admin-content]");
    var roleNote = panel.querySelector("[data-admin-role-note]");
    var rowsEl = panel.querySelector("[data-admin-officer-rows]");
    var appointForm = panel.querySelector("[data-admin-appoint-form]");
    var errorEl = panel.querySelector("[data-admin-error]");
    var tabBtns = Array.prototype.slice.call(panel.querySelectorAll("[data-admin-tab-btn]"));
    var tabPanels = Array.prototype.slice.call(panel.querySelectorAll("[data-admin-tabpanel]"));
    var discordInput = panel.querySelector("[data-admin-discord-input]");
    var emojiInput = panel.querySelector("[data-admin-emoji-input]");
    var settingsSaveBtn = panel.querySelector("[data-admin-settings-save]");
    var squadRowsEl = panel.querySelector("[data-admin-squad-rows]");
    var squadForm = panel.querySelector("[data-admin-squad-form]");
    var squadRosterRowsEl = panel.querySelector("[data-admin-squad-roster-rows]");
    var eventsManageEl = panel.querySelector("[data-admin-events-manage]");
    var tournamentsManageEl = panel.querySelector("[data-admin-tournaments-manage]");

    // Tabs are just show/hide - wiring this up doesn't depend on who's
    // looking, so it can happen before the access check below resolves.
    tabBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = btn.getAttribute("data-admin-tab-btn");
        tabBtns.forEach(function (b) { b.classList.toggle("active", b === btn); });
        tabPanels.forEach(function (p) {
          p.style.display = p.getAttribute("data-admin-tabpanel") === target ? "" : "none";
        });
      });
    });

    getSession(function (session) {
      if (!session || !session.user || session.user.is_anonymous) {
        gate.textContent = "Sign in and connect your Nitro Type account to view this page.";
        return;
      }
      getMyLink(session.user.id, function (err, link) {
        if (err || !link) {
          gate.textContent = "Connect your Nitro Type account to view this page.";
          return;
        }
        resolveTeamRole(teamTag, link.nt_user_id, captainNtUserId, function (err2, role) {
          if (role !== "captain" && role !== "officer") {
            gate.textContent = "You don't have access to this team's admin page.";
            return;
          }
          gate.style.display = "none";
          content.style.display = "";
          var isCaptain = role === "captain";
          roleNote.textContent = isCaptain
            ? "You're this team's captain — appoint or remove officers below."
            : "You're an officer on this team — you can view this page, but only the captain can make changes.";

          function refresh() {
            withClient(function (sb) {
              Promise.all([
                sb.from("team_officers").select("nt_user_id").eq("team_tag", teamTag),
                sb.from("racers").select("nt_user_id, username, display_name").eq("team_tag", teamTag),
              ]).then(function (results) {
                var officerIds = (results[0].data || []).map(function (r) { return r.nt_user_id; });
                var racersById = {};
                (results[1].data || []).forEach(function (r) { racersById[r.nt_user_id] = r; });
                renderOfficerRows(rowsEl, teamTag, officerIds, racersById, isCaptain, refresh);
                if (isCaptain) appointForm.style.display = "flex";
              });
            });
          }
          refresh();

          // Squads tab: fetches its own squads + full roster (not just
          // officers) independently of the Officers tab's refresh() above
          // - same "each tab owns its own data" pattern the Settings tab
          // below already uses.
          function refreshSquads() {
            withClient(function (sb) {
              Promise.all([
                sb.from("team_squads").select("id, name, color").eq("team_tag", teamTag).order("name"),
                sb.from("racers").select("nt_user_id, username, display_name, squad_id").eq("team_tag", teamTag)
                  .order("display_name", { nullsFirst: false }),
              ]).then(function (results) {
                var squads = results[0].data || [];
                var racers = results[1].data || [];
                var racersById = {};
                racers.forEach(function (r) { racersById[r.nt_user_id] = r; });
                if (squadRowsEl) renderSquadRows(squadRowsEl, teamTag, squads, racersById, isCaptain, refreshSquads);
                if (squadRosterRowsEl) renderSquadRosterRows(squadRosterRowsEl, teamTag, squads, racers, isCaptain, refreshSquads);
                if (isCaptain && squadForm) squadForm.style.display = "flex";
              });
            });
          }
          refreshSquads();

          // Events tab: reuses the same loadTeamEvents/renderCaptainManager
          // the (now read-only) public Events page's table rendering comes
          // from - only the mount point moves here, and only a captain
          // (not an officer) gets the editable form; an officer just sees
          // the plain table.
          function refreshEvents() {
            if (!eventsManageEl) return;
            loadTeamEvents(teamTag, function (err, events) {
              if (err) return;
              if (isCaptain) {
                renderCaptainManager(eventsManageEl, teamTag, events, refreshEvents);
              } else {
                eventsManageEl.innerHTML = renderEventsTable(events);
              }
            });
          }
          refreshEvents();

          // Tournaments tab: captain-only create/delete; an officer sees
          // the same tournaments read-only (summaries, not the full
          // bracket - that's the public Tournaments page's job).
          function refreshTournaments() {
            if (!tournamentsManageEl) return;
            loadAdminTournaments(teamTag, function (err, tournaments) {
              if (err) return;
              if (isCaptain) {
                renderAdminTournaments(tournamentsManageEl, teamTag, tournaments, refreshTournaments);
              } else {
                tournamentsManageEl.innerHTML = tournaments.length
                  ? tournaments.map(function (t) { return "<div class='card' style='padding:12px;margin-bottom:10px;'>" + renderAdminTournamentSummary(t) + "</div>"; }).join("")
                  : '<div style="color:var(--muted);font-size:13px;">No tournaments yet.</div>';
              }
            });
          }
          refreshTournaments();

          if (squadForm) {
            squadForm.addEventListener("submit", function (e) {
              e.preventDefault();
              var name = (squadForm.squad_name.value || "").trim();
              var color = squadForm.squad_color.value || "#29d3ff";
              if (!name) return;
              errorEl.style.display = "none";
              createSquad(teamTag, name, color, function (err4) {
                if (err4) {
                  errorEl.textContent = err4;
                  errorEl.style.display = "";
                  return;
                }
                squadForm.squad_name.value = "";
                refreshSquads();
              });
            });
          }

          // Settings tab: discord_invite_url/team_emoji are the only two
          // `teams` columns a captain can write (see schema.sql's
          // column-scoped grant) - read is public, same as every other
          // team-profile field, so both captain and officer see the
          // current values; only the captain gets an editable form.
          withClient(function (sb) {
            sb.from("teams")
              .select("discord_invite_url, team_emoji")
              .eq("tag", teamTag)
              .maybeSingle()
              .then(function (res) {
                if (res.error || !res.data) return;
                if (discordInput) discordInput.value = res.data.discord_invite_url || "";
                if (emojiInput) emojiInput.value = res.data.team_emoji || "";
              });
          });
          if (isCaptain) {
            if (discordInput) discordInput.removeAttribute("disabled");
            if (emojiInput) emojiInput.removeAttribute("disabled");
            if (settingsSaveBtn) settingsSaveBtn.style.display = "";
          } else {
            if (discordInput) discordInput.setAttribute("disabled", "disabled");
            if (emojiInput) emojiInput.setAttribute("disabled", "disabled");
          }
          if (settingsSaveBtn) {
            settingsSaveBtn.addEventListener("click", function () {
              errorEl.style.display = "none";
              // Letters/digits typed into the emoji field are stripped
              // rather than rejected outright - easier to just take
              // whatever's left than to bounce the whole save over it.
              var emoji = (emojiInput.value || "").replace(/[a-zA-Z0-9]/g, "").trim().slice(0, 8);
              var discordUrl = (discordInput.value || "").trim();
              withClient(function (sb) {
                sb.from("teams")
                  .update({ discord_invite_url: discordUrl || null, team_emoji: emoji || null })
                  .eq("tag", teamTag)
                  .then(function (res) {
                    if (res.error) {
                      errorEl.textContent = res.error.message;
                      errorEl.style.display = "";
                      return;
                    }
                    emojiInput.value = emoji;
                    settingsSaveBtn.textContent = "Saved!";
                    setTimeout(function () { settingsSaveBtn.textContent = "Save settings"; }, 1500);
                  });
              });
            });
          }

          appointForm.addEventListener("submit", function (e) {
            e.preventDefault();
            var ntUserId = appointForm.nt_user_id.value;
            if (!ntUserId) return;
            errorEl.style.display = "none";
            addTeamOfficer(teamTag, Number(ntUserId), function (err3) {
              if (err3) {
                errorEl.textContent = err3;
                errorEl.style.display = "";
                return;
              }
              refresh();
            });
          });
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Site-wide header auth status (shown on every page via a small badge
  // next to the Account nav link, when that link is present). Sign-out
  // itself lives only on the account page's signed-in card - not also
  // here in the header - so there's exactly one place to do it, right
  // next to the rest of the account controls (password/username).
  // ---------------------------------------------------------------------
  function initHeaderStatus() {
    var link = document.querySelector('[data-account-nav]');
    if (!link) return;
    getSession(function (session) {
      // An anonymous session only exists mid-connect-flow (see
      // getOrCreateSession) - it isn't a real "signed in" state yet, so
      // the header shouldn't claim one.
      if (session && session.user && !session.user.is_anonymous) {
        link.textContent = "Account ●";
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initHeaderStatus();
    initEventsPage();
    initTeamAdminPage();
  });

  window.TypeTrack = {
    withClient: withClient,
    getSession: getSession,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    getOrCreateSession: getOrCreateSession,
    claimAccount: claimAccount,
    changePassword: changePassword,
    getMyLink: getMyLink,
    getRacerById: getRacerById,
    getProfile: getProfile,
    setChosenUsername: setChosenUsername,
    isTeamOfficer: isTeamOfficer,
    listTeamOfficers: listTeamOfficers,
    addTeamOfficer: addTeamOfficer,
    removeTeamOfficer: removeTeamOfficer,
    resolveTeamRole: resolveTeamRole,
    startVerification: startVerification,
    checkVerification: checkVerification,
    el: el,
    escapeHtml: escapeHtml,
    fmtDate: fmtDate,
  };
})();

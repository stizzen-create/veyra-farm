// ==UserScript==
// @name         Veyra Multi-Farm Bot
// @namespace    https://demonicscans.org/
// @author       UANM
// @version      1.63.0
// @description  Multi-farm: wave + GUILD DUNGEON bosses (battle.php?dgmid) + GUILD DUNGEON LOCATION pages (many .mon instances, farm by name) + AUTO Adventurer's Guild quests (accept→farm g5w9→turn in→next, 2-day rotation) · uses ONLY LSP (251), never FSP — FSP stash stays untouched · English UI · "Scan this page" · per-page targets with ✕ · ⏰timed/🎯farm · billions damage target (3b) · loots dead · pause persists (manual play) · live-apply edits · mobile-friendly panel · respects view tabs · auto-heal · no wasted double-potion · potion toggle · ⚔ AUTO-PvP module on /pvp pages: self-matchmakes the solo ladder, plays each turn DATA-DRIVEN from the learned DB (best learned net damage it can afford, spends the FULL Rage bar on its best learned nuke instead of wasting it on Slash, drops Slash vs healers, lethal check, survival brace), LEARNS every match into a per-enemy-class DB (incl. empowered full-Rage skill effects), ON/OFF toggle to play by hand
// @match        https://demonicscans.org/*
// @updateURL    https://raw.githubusercontent.com/stizzen-create/veyra-farm/main/farm_tampermonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/stizzen-create/veyra-farm/main/farm_tampermonkey.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
(function () {
'use strict';

const BASE       = 'https://demonicscans.org';
const SKILL_ID   = -1;    // power (default 10-stam hit)
const SKILL_COST = 10;
const ATK_GAP    = 1600;  // ms between attacks
// 🏰 DUNGEON BOSS watch: while a "dungeon boss" target is armed, the main loop + the
// location page-read run at THIS cadence (instead of 12s cache / 60s idle nap) so the
// bot notices the boss room opening within ~3s and fires the instant it goes alive —
// no clock, no button, works AFK. Low enough vs the site rate-limit (retries "Slow down").
const DUNGEON_BOSS_POLL = 3000;
// Stamina potions the bot may drink, in PRIORITY order. RULE (user): NEVER touch FSP
// (item 35, Full Stamina Potion) — only ever spend LSP (251, Large, +5000), and only
// if needed. FSP is kept untouched, so it's deliberately NOT in this list.
const STAM_POTS = [
  { item: 251, name: 'LSP' },   // Large Stamina Potion (+5000) — the ONLY potion the bot drinks
];

// Attack tiers (skill_id → stamina). Damage is LINEAR in stamina (verified from
// the battle-page formula: dmg = K * stamina_cost, K constant per fight). So we
// can deliver an EXACT stamina amount by composing tiers, landing within 1
// stamina (=K dmg) of the target instead of overshooting by a whole 10-stam hit.
// Ordered largest→smallest so SKILLS.find(s => s.stam <= want) is greedy.
const SKILLS = [
  { id: -5, stam: 1000 },
  { id: -4, stam: 200  },
  { id: -3, stam: 100  },
  { id: -2, stam: 50   },
  { id: -1, stam: 10   },
  { id:  0, stam: 1    },
];

// ── WAVE / TARGET CONFIG ──────────────────────────────────────────────────────
// useLSP values:
//   false      — no potions
//   'once'     — 1 LSP at start of each mob attack (Pan, Orion)
//   'asNeeded' — LSP every time stamina runs out (G3W8 timed)

// ── DEFAULT CONFIG (serializable → editable from the Settings tab) ─────────────
// No closures here: match is expressed as include/exclude name lists so the whole
// thing can live in GM_setValue. makeMatch() rebuilds the predicate at runtime.
//   include: [] → matches ANY mob; else name must contain one of these
//   exclude: [] → matches everything not containing one of these
const DEFAULT_CONFIG = [
  { id:'g3w8', gate:3, wave:8, enabled:true, targets:[
    { key:'drakzareth', label:'Drakzareth the Tyrant Lizard King',     include:['drakzareth'], exclude:[], dmgTarget:3_000_000_000,  killLimit:null, useLSP:'asNeeded', timer:true, enabled:true },
    { key:'skarn',      label:'General Skarn the Radiant Bastion',     include:['skarn'],      exclude:[], dmgTarget:3_000_000_000,  killLimit:null, useLSP:'asNeeded', timer:true, enabled:true },
    { key:'vessir',     label:'General Vessir the Sunfang Duelist',    include:['vessir'],     exclude:[], dmgTarget:3_000_000_000,  killLimit:null, useLSP:'asNeeded', timer:true, enabled:true },
    { key:'hrazz',      label:'General Hrazz the Dawnflame Oathkeeper', include:['hrazz'],     exclude:[], dmgTarget:3_000_000_000,  killLimit:null, useLSP:'asNeeded', timer:true, enabled:true },
  ]},
  { id:'g5w9', gate:5, wave:9, enabled:true, targets:[
    // Oceanus a 3B con pozioni (asNeeded) come i boss g3w8 — non droppa FSP ma lo vogliamo full.
    { key:'oceanus',    label:'Oceanus the Water Titan',              include:['oceanus'],    exclude:[], dmgTarget:3_000_000_000,  killLimit:null, useLSP:'asNeeded', timer:true, enabled:true },
  ]},
  { id:'g5w10', gate:5, wave:10, enabled:true, targets:[
    { key:'pan',        label:'Pan, Wild Herald of Hermes',           include:['pan'],        exclude:[],                 dmgTarget:120_000_000, killLimit:null, useLSP:'asNeeded', timer:true,  enabled:true },
    { key:'g5w10-farm', label:'G5W10 Farm',                          include:[],             exclude:['pan','hermes'],   dmgTarget:100_000_000, killLimit:400,  useLSP:'asNeeded', timer:false, enabled:true },
  ]},
  { id:'g5w11', gate:5, wave:11, enabled:true, targets:[
    { key:'orion',      label:'Orion, Eternal Hunter of Artemis',     include:['orion'],      exclude:[], dmgTarget:500_000_000, killLimit:null, useLSP:'asNeeded', timer:true, enabled:true },
    { key:'g5w11-farm', label:'G5W11 Farm',                          include:[],             exclude:['orion','artemis'], dmgTarget:50_000_000, killLimit:400, useLSP:'asNeeded', timer:false, enabled:true },
  ]},
];

function makeMatch(include = [], exclude = []) {
  const inc = include.map(s => String(s).toLowerCase().trim()).filter(Boolean);
  const exc = exclude.map(s => String(s).toLowerCase().trim()).filter(Boolean);
  return m => (inc.length === 0 || inc.some(n => m.name.includes(n)))
           && !exc.some(n => m.name.includes(n));
}

// Short human label for a page URL (wave / event / gate / guild dungeon).
function pageLabel(url) {
  try {
    const u = new URL(url, BASE), p = u.searchParams;
    if (u.pathname.includes('active_wave')) {
      if (p.get('gate') && p.get('wave')) return `G${p.get('gate')}W${p.get('wave')}`;
      if (p.get('event'))                 return `Ev${p.get('event')}W${p.get('wave') || '?'}`;
    }
    if (u.pathname.includes('battle.php') && p.get('dgmid')) return `🏰 Dungeon boss ${p.get('dgmid')}`;
    if (u.pathname.includes('guild_dungeon_instance.php')) return `🏰 Dungeon instance ${p.get('id') || ''}`.trim();
    if (u.pathname.includes('guild_dungeon_location.php')) return `🏰 Guild dungeon ${p.get('location_id') || ''}`.trim();
    if (u.pathname.includes('gate.php')) return `Gate ${p.get('id') || ''}`.trim();
    if (u.pathname.includes('wave.php')) return `Wave ${p.get('id') || ''}`.trim();
    return (u.pathname.replace(/^\//, '').replace(/\.php$/, '') + (p.get('id') ? ` ${p.get('id')}` : '')) || url;
  } catch { return url; }
}

// safe "&dead_page=N" append (works whether url already has a query or not)
function withDeadPage(url, p) { return url + (url.includes('?') ? '&' : '?') + 'dead_page=' + p; }

// source url for a config entry: explicit url, or derived from legacy gate/wave.
function srcUrl(w) {
  return w.url || (w.gate != null ? `${BASE}/active_wave.php?gate=${w.gate}&wave=${w.wave}` : '');
}

// Build the runtime WAVES (page sources with compiled match fns) from saved config.
// Disabled sources/targets are dropped so the main loop never sees them.
function buildWaves() {
  return (S.config || []).filter(w => w.enabled !== false && w.kind !== 'dungeon' && w.kind !== 'dungeonloc').map(w => ({
    id:    w.id,
    label: w.label || pageLabel(srcUrl(w)) || w.id,
    url:   srcUrl(w),
    targets: (w.targets || []).filter(t => t.enabled !== false).map(t => ({
      ...t,
      match: makeMatch(t.include, t.exclude),
    })),
  })).filter(w => w.url);
}

let WAVES = [];   // populated after S.config is initialized (see STATE section)

// ── STATE ─────────────────────────────────────────────────────────────────────
const SK = 'veyra_mfarm_v1';
const defState = () => ({
  kills: {}, attacks: 0, timers: {}, lspInv: null, potInv: {}, started: Date.now(),
  timedKills: 0, timedBy: {}, lspUses: 0, hpHeals: 0, pos: null, config: null,
  debug: false,            // verbose scan/diagnostic log lines (off = clean, user-friendly log)
  farmSeen: {},            // name → last-seen ts: farm mobs we've encountered, so the
                           // 🎯 Farming tab lists what we farm even before the 1st kill
  // ── Leveling rate (replaces the old HP readout in the status grid) ─────────────
  // Baseline fractional level (level + exp/expMax) + its timestamp. The status panel
  // shows the live average lvl/hour = (currentFracLevel − base) / hoursElapsed. Reset
  // by the 🗑 stats button so the average restarts fresh; persists across reloads so
  // the figure is a true running average over the whole session.
  lvlBaseFrac: null, lvlBaseTs: null,
  _g5w11FarmMigrated: false, // one-time: add the g5w11 trash-farm target to existing saves
  paused: false,
  // dgmids of guild-dungeon (cube) instances we've already capped at their damage target.
  // SHARED bosses don't die from our hit, so without remembering this ACROSS page reloads
  // the bot re-engaged them every load and dealt +1 slash each time, creeping past the
  // guild cap. Persisted here; respawns get a NEW dgmid so old entries never block a fresh
  // mob. Bounded to the last 500 to keep GM storage small.
  dlLooted: [],
  minimized: false,        // panel collapsed state — persists across page reloads
  dockPos: null,           // {left,top} of the minimized dock once dragged — persists
  _timedKillsPurged: false, // one-time: drop timed-boss names that leaked into Farming
  // Hit style. OFF (default) = EXACT, minimal-overshoot: every fight composes tiers
  // so it lands within ~1 small hit of the target (no stamina wasted — "danni precisi
  // per tutto"). ON = proc-farming: fixed 50-stam Heroic hits for more Orryphos
  // free-hit procs, but it overshoots small targets (e.g. ~19M on a 5M quest mob).
  smallHits: false,
  _exactMigrated: false,   // one-time flip of the old proc-farming default → exact
  _farmLspMigrated: false, // one-time: farm targets drink LSP too (user request v1.18.0)
  // Pozioni stamina (LSP): i boss TIMED le usano SEMPRE (così non perdi una finestra di
  // spawn). Questo flag decide solo se ANCHE il FARM le usa:
  //   ON  (checked)   → timed + farm bevono pozioni
  //   OFF (unchecked) → solo i timed bevono; il farm gira con la sola stamina naturale
  // (prima era un kill-switch totale "tutto o niente" — l'etichetta diceva "solo timed"
  // ma in realtà beveva anche per il farm: incoerenza sistemata in v1.23.0.)
  lspEnabled: true,
  // ── HP potions (auto-heal) ──────────────────────────────────────────────────
  // Soglia (%) sotto la quale il bot beve una pozione HP (user_heal_potion.php).
  // 0 = OFF: non cura MAI (aspetta la rigenerazione naturale, non spende pozioni).
  // >0 = cura quando HP% ≤ soglia (e comunque alla morte). Slider nel ⚙ Setup.
  // Default 10% = cura solo quando sei quasi morto (prima curava SEMPRE alla morte
  // e l'utente lo trovava troppo aggressivo → ora si sceglie con lo slider).
  hpHealPct: 10,
  // ── Mana potions (per classi a mana: Mago/Hunter/ecc., NON il Berserker) ──────
  // Io (UANM) gioco Berserker → uso Rage, niente mana. Ma le classi a mana spendono MP
  // per le skill: questo controllo dice se e quante pozioni di mana bere quando l'MP è
  // basso. DISABILITATO di default. Il CONSUMO vero si aggancia con l'AutoPvP adattivo
  // (rileva la classe) — vedi useMana(). Mana Potion L (item 163, +200) poi S (162, +20).
  manaEnabled: false,   // checkbox Setup (default OFF)
  manaPots: 500,        // quante pozioni di mana usare (budget) quando abilitato (slider 0–4000)
  manaUsed: 0,          // contatore sessione
  // ── Adventurer's Guild quests (auto accept → farm g5w9 → finish → next) ──
  // ON = il bot accetta una quest disponibile (fuori cooldown), farma il suo mob
  // su g5w9 fino al target del server, la consegna e prende la successiva.
  questEnabled: true,
  questTaken: 0, questDone: 0,   // contatori accettate / consegnate
  questActive: null,             // {id,title,monster,minDmg,have,need} cache per UI + farm
  // ── AUTO-PvP (solo ladder) ────────────────────────────────────────────────────
  // Modulo PvP: si attiva SOLO sulle pagine /pvp.php e /pvp_battle.php. Quando enabled
  // matchmaka da solo (finché ci sono token), gioca ogni turno scegliendo la skill a
  // danno massimo, e IMPARA da ogni match riempiendo pvp.db (per classe avversaria +
  // le mie skill, incl. l'effetto POTENZIATO a Rage piena). enabled=false → giochi a mano.
  pvp: {
    enabled: false,             // toggle ON/OFF (così puoi giocare a mano)
    survive: true,              // brace: quando la risorsa NEMICA è piena (sta per nukeare), a Rage
                                // piena usa una skill difensiva potenziata (Ironclad +DEF) invece del nuke.
                                // NB: il Berserker a HP bassi fa più danno e cura di più → non ci si
                                // difende per poca vita, solo per anticipare il nuke avversario.
    cur: null,                  // match_id in corso (guida il loop)
    tokensUsed: 0, wins: 0, losses: 0,
    lastPick: '', lastClass: '', note: '',
    tokensAvail: null, tokensCheckedAt: 0, gems: null, refillCost: 500, freeChance: null,  // letti da pvp.php
    matches: [],                // {mid, enemyClass, winner}
    db: { classes: {}, my: {} },// il DB che cresce a ogni match
  },
});
let S = (() => {
  try { return JSON.parse(GM_getValue(SK, 'null')) || defState(); }
  catch { return defState(); }
})();
// migrate older saved state so new fields always exist
for (const [k, v] of Object.entries(defState())) if (S[k] === undefined) S[k] = v;
// v1.16.0: minimal-overshoot is now the standard everywhere (user: "danni precisi per
// tutto"). Flip the old proc-farming default OFF once on existing installs — the user
// can still re-enable it from the ⚔️ toggle (it won't be flipped again).
if (S._exactMigrated !== true) { S.smallHits = false; S._exactMigrated = true; }
// seed the editable wave config on first run (or if wiped)
if (!Array.isArray(S.config) || !S.config.length) {
  S.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
// backfill url + label on legacy gate/wave sources so the URL-based UI works
for (const w of S.config) {
  if (!w.url)   w.url   = srcUrl(w);
  if (!w.label) w.label = pageLabel(w.url) || w.id;
}
const save = () => GM_setValue(SK, JSON.stringify(S));

// v1.18.0: l'utente vuole che ANCHE i mob in farming usino le pozioni (LSP), come i
// boss timed. Flippa una volta sola tutti i target farm (non-timed) salvati da
// useLSP:false → 'asNeeded' (FSP resta comunque intoccato — non è in STAM_POTS).
// Da qui in poi i nuovi target farm nascono già con 'asNeeded' (DEFAULT_CONFIG + mkTarget).
if (S._farmLspMigrated !== true) {
  for (const w of (S.config || [])) for (const t of (w.targets || []))
    if (!t.timer && t.useLSP === false) t.useLSP = 'asNeeded';
  S._farmLspMigrated = true; save();
}

// v1.25.0: g5w11 ora farma i trash come g5w10 (mancava il target farm: c'era solo il
// boss Orion timed). Inietta g5w11-farm negli install esistenti SENZA richiedere un
// Reset — 50M/mob, esclude i boss orion+artemis. One-time.
if (S._g5w11FarmMigrated !== true) {
  const w = (S.config || []).find(x => x.id === 'g5w11' || /[?&]gate=5&wave=11\b/.test(srcUrl(x) || ''));
  if (w && !(w.targets || []).some(t => !t.timer)) {
    (w.targets = w.targets || []).push({
      key:'g5w11-farm', label:'G5W11 Farm', include:[], exclude:['orion','artemis'],
      dmgTarget:50_000_000, killLimit:400, useLSP:'asNeeded', timer:false, enabled:true,
    });
  }
  S._g5w11FarmMigrated = true; save();
}

// compile the runtime waves from the saved config; call again after edits
function rebuildWaves() {
  WAVES = buildWaves();
  for (const k of Object.keys(_waveCache)) delete _waveCache[k];   // drop stale cache
}
WAVES = buildWaves();

// Does this mob name belong to a TIMED target anywhere? Timed ALWAYS wins over a
// farm target (especially a wildcard include:[] like g5w10-farm): a timed boss is
// never attacked nor counted by the farm pass, and never shows up in the 🎯 Farming
// list — it lives only under ⏰ Boss timers. (Fixes "general hrazz" leaking into farm.)
function isTimedName(name) {
  const m = { name: String(name || '').toLowerCase().trim() };
  for (const w of WAVES) for (const t of w.targets)
    if (t.timer && t.match(m)) return true;
  return false;
}

// v1.16.2: a farm wildcard used to also count timed bosses (general hrazz landed in
// Farming). Purge any kill entries that belong to a timed target so they leave the
// list; from now on isTimedName() keeps them out.
if (S._timedKillsPurged !== true) {
  for (const name of Object.keys(S.kills || {})) if (isTimedName(name)) delete S.kills[name];
  S._timedKillsPurged = true; save();
}

// ── CONTROL ───────────────────────────────────────────────────────────────────
// paused persists in S so a page navigation doesn't silently resume the bot.
let paused  = S.paused === true;
let running = true;
let status  = 'starting…';

// ── LOG ───────────────────────────────────────────────────────────────────────
const LOG_MAX = 300;                 // keep a deeper history for debugging
const logBuf  = [];
const fullLog = [];                  // unbounded-ish copyable trace (capped at 2000)

function log(msg, color = '#aaa') {
  const ts  = new Date().toTimeString().slice(0,8);
  logBuf.push({ ts, msg, color });
  if (logBuf.length > LOG_MAX) logBuf.shift();
  fullLog.push(`${ts} ${msg.replace(/<[^>]+>/g, '')}`);
  if (fullLog.length > 2000) fullLog.shift();
  // copy the whole trace from the console with: copy(window.__farmLog())
  try { window.__farmLog = () => fullLog.join('\n'); } catch {}
  console.log(`[FarmBot ${ts}] ${msg}`);
}

// debug-only log: noisy per-scan / diagnostic lines that a first-time user doesn't need.
// Hidden unless 🐞 Debug log is toggled on in Setup. Keeps the default log readable.
function dlog(msg, color = '#556') { if (S && S.debug) log(msg, color); }

// ── HTTP ──────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch with a hard timeout — a stalled request used to hang the whole loop
// forever (no native timeout). On abort we resolve to an error so the loop
// retries on the next cycle instead of freezing on "fetch …".
function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { credentials: 'include', ...opts, signal: ctrl.signal })
    .finally(() => clearTimeout(id));
}

async function post(path, data) {
  try {
    const r = await fetchT(`${BASE}/${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(data).toString(),
    }, 12000);
    return await r.json();
  } catch { return null; }
}

async function getHtml(url) {
  try {
    const r = await fetchT(url, {}, 15000);
    if (!r.ok) { log(`HTTP ${r.status} for ${url.slice(-20)}`, '#f66'); return ''; }
    return await r.text();
  } catch (e) {
    log(`fetch timeout/err: ${e.name === 'AbortError' ? 'timeout' : e.message}`, '#f66');
    return '';
  }
}

// ── STAMINA / HP ──────────────────────────────────────────────────────────────
let stam     = 0;
let userHp   = null;   // last known HP (retaliation.user_hp_after / page "X / Y HP")
let userHpMax = null;  // last known MAX HP (page "X / Y HP" or full-heal response)
let hpEmpty  = false;  // true once HP potions run out (avoid spamming the endpoint)
// persistent counters live on S: S.hpHeals, S.lspUses, S.timedKills

function parseStam(html) {
  const m = html.match(/id="stamina_span"[^>]*>\s*([\d,]+)/)
         || html.match(/Stamina[^\d]{0,20}([\d,]+)/i);
  if (m) stam = parseInt(m[1].replace(/,/g, '')) || stam;
}

// read "12,345 / 67,890 HP" from a page → live HP + max (same source as veyra_colab).
// Lets the % auto-heal threshold work, and refreshes HP so the bot resumes after a
// natural regen when auto-heal is OFF.
function parseHp(html) {
  const m = html.match(/(\d[\d,]+)\s*\/\s*(\d[\d,]+)\s*HP/);
  if (!m) return;
  const cur = parseInt(m[1].replace(/,/g, '')), mx = parseInt(m[2].replace(/,/g, ''));
  if (Number.isFinite(cur)) userHp = cur;
  if (Number.isFinite(mx) && mx > 0) userHpMax = mx;
}

// current HP as a percentage of max (null if max unknown yet)
function hpPct() { return (userHpMax > 0 && userHp != null) ? (userHp / userHpMax * 100) : null; }

// ── LEVELING RATE ───────────────────────────────────────────────────────────────
// Read the top bar "LV 4125" + "EXP 84,731,522 / 106,399,325" from any fetched full
// page (battle/wave/dungeon pages all carry the global header). Turns level+exp into a
// single monotonic "fractional level" so we can show a live lvl/hour average — this is
// what replaced the HP readout in the status grid (user: "il conteggio degli hp non mi
// interessa, sostituiscilo con una media di livelli/ora").
let userLevel = null, userExp = null, userExpMax = null;
function parseLevel(html) {
  const lm = html.match(/\bLV\b[^\d]{0,20}?([\d][\d,]*)/i) || html.match(/\bLevel\b[^\d]{0,20}?([\d][\d,]*)/i);
  if (lm) { const v = parseInt(lm[1].replace(/,/g, '')); if (Number.isFinite(v)) userLevel = v; }
  // anchor to the EXP label so we never grab the "X / Y HP" pair by mistake
  const em = html.match(/\bEXP\b[\s\S]{0,200}?([\d][\d,]+)\s*\/\s*([\d][\d,]+)/i);
  if (em) {
    const cur = parseInt(em[1].replace(/,/g, '')), mx = parseInt(em[2].replace(/,/g, ''));
    if (Number.isFinite(cur)) userExp = cur;
    if (Number.isFinite(mx) && mx > 0) userExpMax = mx;
  }
  noteLevelProgress();
}
// level + progress to next level, as one always-increasing number (caps the fraction
// just under 1 so a full bar never reads as the next whole level before it ticks over)
function fracLevel() {
  if (userLevel == null) return null;
  const f = (userExpMax > 0 && userExp != null) ? Math.min(userExp / userExpMax, 0.999) : 0;
  return userLevel + f;
}
// set the baseline the first time we get a reading (after start / after a stats reset)
function noteLevelProgress() {
  const f = fracLevel();
  if (f == null) return;
  if (S.lvlBaseFrac == null || !S.lvlBaseTs) { S.lvlBaseFrac = f; S.lvlBaseTs = Date.now(); save(); }
}
// live average levels gained per hour since the baseline (null until enough time/data)
function lvlPerHour() {
  const f = fracLevel();
  if (f == null || S.lvlBaseFrac == null || !S.lvlBaseTs) return null;
  const hrs = (Date.now() - S.lvlBaseTs) / 3600000;
  if (hrs < 1 / 120) return null;   // <30s elapsed → too noisy to be meaningful yet
  return Math.max(0, (f - S.lvlBaseFrac) / hrs);
}

// Should we spend an HP potion right now? Threshold is user-chosen (S.hpHealPct, the
// slider in ⚙ Setup): 0 = OFF (never auto-heal). Otherwise heal when HP% ≤ threshold.
// If max HP isn't known yet, fall back to "only when actually dead".
function wantHeal() {
  const t = S.hpHealPct | 0;
  if (t <= 0) return false;
  const p = hpPct();
  return p == null ? (userHp != null && userHp <= 0) : (p <= t);
}

function readStamFromDOM() {
  // try to read stamina directly from the current page DOM (no fetch needed)
  const el = document.getElementById('stamina_span')
          || document.querySelector('[id*="stamina"]');
  if (el) {
    const n = parseInt(el.textContent.replace(/[^\d]/g, ''));
    if (!isNaN(n) && n > 0) { stam = n; log(`stamina from DOM: ${stam}`, '#0cf'); return; }
  }
  // fallback: regex on full page text
  const m = document.body?.innerText?.match(/Stamina[^\d]{0,20}([\d,]+)/i);
  if (m) { stam = parseInt(m[1].replace(/,/g, '')); log(`stamina from page: ${stam}`, '#0cf'); }
}

// ── USER ID ───────────────────────────────────────────────────────────────────
const uid = () =>
  document.cookie.split(';')
    .find(c => c.trim().startsWith('demon='))?.split('=')[1]?.trim() || '';

// ── LSP ───────────────────────────────────────────────────────────────────────
// resolve inv_id + qty for every stamina potion in STAM_POTS (parsed from the DOM,
// so it survives markup changes better than a flat regex)
async function refreshInv() {
  const html = await getHtml(`${BASE}/inventory.php`);
  if (!html) return;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  S.potInv = S.potInv || {};
  for (const p of STAM_POTS) {
    const card = doc.querySelector(`[data-item-id="${p.item}"]`);
    if (card) {
      const inv = card.getAttribute('data-inv-id');
      const qty = parseInt(card.querySelector('.potion-qty-left')?.textContent.replace(/[^\d]/g, '') || '0');
      S.potInv[p.item] = { inv, qty: Number.isFinite(qty) ? qty : null };
    } else {
      delete S.potInv[p.item];
    }
  }
  S.lspInv = S.potInv[251]?.inv || null;   // legacy field, kept in sync (LSP only — FSP never touched)
  save();
  log(`potions: ${STAM_POTS.map(p => `${p.name} x${S.potInv[p.item]?.qty ?? 0}`).join(' · ')}`, '#0cf');
}

// first potion in priority order that still has stock (LSP only — FSP is never touched)
function pickPotion() {
  for (const p of STAM_POTS) {
    const e = S.potInv?.[p.item];
    if (e && e.inv && (e.qty == null || e.qty > 0)) return { ...p, inv: e.inv };
  }
  return null;
}

async function useLSP(timer = false) {
  // Timed bosses always drink (don't miss a spawn window). Farm mobs drink only when the
  // user enabled it (toggle ⚙). S.lspEnabled now means "farm uses potions too", NOT a
  // global on/off — timed potions are unconditional.
  if (!timer && !S.lspEnabled) return false;
  let pick = pickPotion();
  if (!pick) { await refreshInv(); pick = pickPotion(); }
  if (!pick) { log('no LSP left (FSP is never used)', '#f66'); return false; }

  // Read the RAW response. use_item.php may not return clean JSON — when it didn't,
  // post() returned null, so `ok` was always false: the counter stayed at 0 and
  // stamina was never updated (which also caused a second potion to be wasted).
  let txt = '', data = null, httpStatus = 0;
  try {
    const r = await fetchT(`${BASE}/use_item.php`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ inv_id: pick.inv, qty: 1 }).toString(),
    }, 12000);
    httpStatus = r.status;
    txt = await r.text();
    try { data = JSON.parse(txt); } catch {}
  } catch (e) { log(`${pick.name} request error: ${e.message}`, '#f66'); return false; }

  // success if JSON says so, OR the raw text mentions success/stamina/refill,
  // OR the text contains no explicit error.
  const ok = !!(data && (data.status === 'success' || data.success === true || data.stamina !== undefined))
          || /success|refill|stamina/i.test(txt)
          || (!!txt && !/error|fail|not enough|don'?t have|invalid/i.test(txt));

  if (ok) {
    S.lspUses++;
    // decrement the local stock so we don't keep picking an empty potion before the
    // next inventory refresh (and so the panel count is live).
    const e = S.potInv?.[pick.item];
    if (e && typeof e.qty === 'number') e.qty = Math.max(0, e.qty - 1);
    // FSP fully refills stamina; LSP gives +5000. Read the new value from the
    // response if present; otherwise assume a refill so the caller doesn't grab a
    // second potion. The next damage.php response carries the real stamina.
    const fromText = (txt.match(/stamina["':\s]+([\d,]+)/i)?.[1] || '').replace(/,/g, '');
    const parsed   = parseInt(data?.stamina ?? fromText);
    stam = (Number.isFinite(parsed) && parsed > 0) ? parsed : Math.max(stam, 5000);
    save();
  } else if (/not enough|don'?t have|0|empty|invalid/i.test(txt)) {
    // this potion is actually empty — zero it and let the next call fall through to
    // the backup (LSP) on the following attempt.
    if (S.potInv?.[pick.item]) S.potInv[pick.item].qty = 0;
    save();
  }
  log(ok ? `🧪 ${pick.name} used (#${S.lspUses}) — stamina now ${stam} · left x${S.potInv?.[pick.item]?.qty ?? '?'}`
        : `${pick.name} failed — response: ${txt.slice(0, 80).replace(/\s+/g, ' ')}`,
      ok ? '#0cf' : '#f66');
  return ok;
}

// ── HP HEAL ─────────────────────────────────────────────────────────────────
// user_heal_potion.php {user_id} → restores full HP (item 108, no inv_id needed).
// Verified endpoint (same one veyra_colab uses). Returns {status, user_hp,
// potions_remaining}. Called the moment a retaliation kills us so the bot keeps
// fighting instead of sitting dead (which silently stalls ALL attacks).
async function healUp() {
  if (hpEmpty) return false;
  const d = await post('user_heal_potion.php', { user_id: uid() });
  const ok = !!(d && (d.status === 'success' || /full hp/i.test(d.message || '')));
  if (ok) {
    userHp = parseInt(d.user_hp) || userHp;
    if (userHp) userHpMax = Math.max(userHpMax || 0, userHp);   // full heal ⇒ this is max HP
    S.hpHeals++; save();
    const left = d.potions_remaining ?? '?';
    if (left === 0 || left === '0') hpEmpty = true;
    log(`💀→❤️ died: HP potion used (#${S.hpHeals}, left: ${left})`, '#f44');
  } else {
    const msg = d?.message || 'no resp';
    if (/no potion|0 potion|don'?t have|out of/i.test(msg)) hpEmpty = true;
    log(`HP heal failed: ${msg}`, '#f66');
  }
  return ok;
}

// ── WAVE PARSE ────────────────────────────────────────────────────────────────
// data-boss is ALWAYS 0 (verified) → boss detection is name-based via match fns.
// data-expire = unix timestamp (death/respawn). data-dead = 0 alive / 1 dead.
// _collectMobs / _collectAutoSummon work on ANY root (a parsed doc OR the live
// `document`) so scanning the current page needs no fetch (→ no cookie race).
function _collectMobs(root) {
  const out = {};
  for (const c of root.querySelectorAll('.monster-card')) {
    const id = c.dataset.monsterId;
    if (!id) continue;
    out[id] = {
      id,
      name:    (c.dataset.name || '').toLowerCase().trim(),
      dead:    c.dataset.dead === '1',
      userdmg: parseInt(c.dataset.userdmg || '0'),
      expire:  parseInt(c.dataset.expire || '0'),  // unix ts
    };
  }
  return out;
}
function parseMobs(html) {
  return _collectMobs(new DOMParser().parseFromString(html, 'text/html'));
}

// Auto-summon cards carry the authoritative boss timers:
//   .auto-summon-name, data-alive (1/0), data-next-ts (unix respawn ts)
function _collectAutoSummon(root) {
  for (const c of root.querySelectorAll('.auto-summon-card')) {
    const nm = (c.querySelector('.auto-summon-name')?.textContent || '').toLowerCase().trim();
    if (!nm) continue;
    S.timers[nm] = {
      alive:  c.dataset.alive === '1',
      nextTs: parseInt(c.dataset.nextTs || '0'),  // seconds
    };
  }
  save();
}
function parseAutoSummon(html) {
  _collectAutoSummon(new DOMParser().parseFromString(html, 'text/html'));
}

// Guild-dungeon LOCATION page (guild_dungeon_location.php?instance_id=…&location_id=…)
// lists many `.mon` cards — each a SEPARATE boss instance with its own dgmid
// (View → battle.php?dgmid=…&instance_id=…). The monster name comes from the image
// filename (Prismblade_Reaver.webp → "prismblade reaver"); a `.mon.dead` class marks
// a killed/looted instance. Works on a parsed doc OR the live `document`.
function _collectDungeonMons(root) {
  const out = [];
  for (const c of root.querySelectorAll('.mon')) {
    const a    = c.querySelector('a[href*="battle.php"]');
    const href = a ? a.getAttribute('href') : '';
    const dgmid       = (href.match(/dgmid=(\d+)/)       || [])[1];
    const instance_id = (href.match(/instance_id=(\d+)/) || [])[1];
    if (!dgmid) continue;
    const file = (c.querySelector('img')?.getAttribute('src') || '').split('?')[0].split('/').pop() || '';
    const name = file.replace(/\.\w+$/, '').replace(/[_-]+/g, ' ').toLowerCase().trim();
    out.push({ dgmid, instance_id, name, dead: /(^|\s)dead(\s|$)/.test(c.className) });
  }
  return out;
}
function parseDungeonMons(html) {
  return _collectDungeonMons(new DOMParser().parseFromString(html, 'text/html'));
}

// per-target auto-die timestamp of the currently-alive boss instance (seconds).
// data-expire on the wave card === AUTO_DIE_CFG.nextDieMs on battle.php (verified):
// it's when the boss auto-dies and respawns with a fresh id + reset userdmg.
const liveBoss = {};

const _waveCache = {};
const CACHE_TTL  = 30_000;

// Guild-dungeon LOCATION caches: _dlCache throttles page reads per source; _dlLooted
// records the dgmids we've already dealt our target damage to. PERSISTED across page
// reloads (S.dlLooted = [[dgmid, ts], …]) so a capped cube mob isn't re-hit — and re-hit,
// and re-hit — on every navigation/scan (the bug: "ogni check aggiunge danno"). Entries
// EXPIRE after DL_TTL: the cube is a DAILY dungeon, so yesterday's "done" marks must drop
// or the bot would never farm it again when it re-opens.
const DL_TTL    = 18 * 3600_000;   // 18h — long enough to cover a farming session, short
                                   // enough that the next daily opening starts fresh
const _dlCache  = {};
const _dlLooted = new Map();        // dgmid → timestamp we hit our target
for (const e of (S.dlLooted || [])) {   // load surviving (non-expired) marks
  if (Array.isArray(e) && Date.now() - e[1] < DL_TTL) _dlLooted.set(e[0], e[1]);
}
// True only if this dgmid was claimed AND the claim hasn't expired (auto-prunes stale ones
// so a 24/7 run without a reload still re-farms the dungeon when it re-opens next day).
function isLooted(dgmid) {
  const t = _dlLooted.get(dgmid);
  if (t == null) return false;
  if (Date.now() - t >= DL_TTL) { _dlLooted.delete(dgmid); return false; }
  return true;
}
// Mark a dgmid as claimed and persist it (bounded to the last 500 to keep storage small).
// Call save() afterwards (existing call sites already do).
function lootedAdd(dgmid) {
  _dlLooted.set(dgmid, Date.now());
  let arr = [..._dlLooted.entries()];
  if (arr.length > 500) { arr = arr.slice(-500); _dlLooted.clear(); for (const [d, t] of arr) _dlLooted.set(d, t); }
  S.dlLooted = arr;
}

const DEAD_PAGES = 6;   // max dead pages to scan per wave

// View cookies: hide_dead_monsters (1=alive view, 0=dead/unclaimed view) and
// show_dead_bosses_only (1=only dead bosses). These are the 3 wave tabs
// (Show Alive / Show all dead / Dead bosses only).
//
// CRITICAL: write them HOST-ONLY (no domain=), exactly like the page's own
// setCookie. The old code used `domain=demonicscans.org`, which created a SECOND,
// separate cookie that fought the page's host-only one — the server then read the
// wrong value and HID the alive mobs ("lo script nasconde i mob"). We also purge
// those bad domain duplicates once at startup.
function setCookieRaw(name, val) { document.cookie = `${name}=${val}; path=/; SameSite=Lax`; }
function getCookieRaw(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
function setHideDead(on) { setCookieRaw('hide_dead_monsters', on ? 1 : 0); }

// snapshot/restore the tab the USER has selected, so the bot's reads never change
// what the user sees on the wave page.
function saveUserView() { return { h: getCookieRaw('hide_dead_monsters'), b: getCookieRaw('show_dead_bosses_only') }; }
function restoreUserView(v) {
  setCookieRaw('hide_dead_monsters', v.h != null ? v.h : 1);
  setCookieRaw('show_dead_bosses_only', v.b != null ? v.b : 0);
}
function purgeDomainCookies() {
  for (const n of ['hide_dead_monsters', 'show_dead_bosses_only']) {
    document.cookie = `${n}=; domain=demonicscans.org; path=/; Max-Age=0`;
    document.cookie = `${n}=; domain=.demonicscans.org; path=/; Max-Age=0`;
  }
}

// needDead: scan the dead pages so dead instances (farm trash AND timed bosses)
// can be looted. The cache records whether it included dead; a needDead request
// will NOT reuse an alive-only cache entry (that was the bug that left 100+ mobs
// unlooted — Phase 1 cached alive-only, Phase 2 reused it and never saw the dead).
async function fetchWave(url, needDead = false) {
  const now = Date.now();
  const hit = _waveCache[url];
  if (hit && now - hit.ts < CACHE_TTL && (!needDead || hit.hadDead)) return hit.mobs;

  const view = saveUserView();     // remember the tab the user is on
  setCookieRaw('show_dead_bosses_only', 0);

  // ── ALIVE mobs: hide_dead_monsters=1 ──
  setHideDead(true);
  const html = await getHtml(url);
  parseStam(html);
  parseHp(html);                   // live HP + max (for the % auto-heal threshold)
  parseLevel(html);                // LV + EXP → live lvl/hour figure in the status grid
  parseAutoSummon(html);           // boss timers
  const mobs = parseMobs(html);    // alive cards

  // ── DEAD mobs (for looting): hide_dead_monsters=0 + dead_page pagination ──
  if (needDead) {
    setHideDead(false);
    for (let p = 1; p <= DEAD_PAGES; p++) {
      status = '🔍 checking for loot…'; renderUI();
      const h2   = await getHtml(withDeadPage(url, p));
      const more = parseMobs(h2);
      let added  = 0;
      for (const [id, m] of Object.entries(more)) {
        if (m.dead && !mobs[id]) { mobs[id] = m; added++; }
      }
      if (!added) break;
    }
  }

  restoreUserView(view);   // put the user's selected tab back — never hide their mobs
  const result = Object.values(mobs);
  _waveCache[url] = { ts: Date.now(), mobs: result, hadDead: needDead };
  return result;
}

// ── TIMED WATCHDOG ────────────────────────────────────────────────────────────
// Light check (1 GET per timed-wave, no dead pagination) to see if any timed boss
// is alive and still needs damage. Throttled so it never spams the server.
let _lastTimedCheck = 0;
let _timedInterrupt = false;
// true se in QUESTO giro del mainLoop ho fatto qualcosa di reale (un colpo o un loot). Se a fine
// giro è ancora false e ho stamina, vuol dire "giro a vuoto" (target tutti al cap / niente da
// lootare) → mostro "in attesa" e dormo a lungo invece di scorrere le wave (fetch g5w11…) ogni 600ms.
let _didWork = false;
const TIMED_CHECK_INTERVAL = 25_000;

async function anyTimedReady() {
  const now = Date.now();
  if (now - _lastTimedCheck < TIMED_CHECK_INTERVAL) return false;
  _lastTimedCheck = now;
  for (const wave of WAVES) {
    const timed = wave.targets.filter(t => t.timer);
    if (!timed.length) continue;
    const view = saveUserView();
    setCookieRaw('show_dead_bosses_only', 0);
    setHideDead(true);
    const html = await getHtml(wave.url);   // alive mobs only (light, no dead pages)
    restoreUserView(view);                  // put the user's tab back
    parseStam(html);
    parseAutoSummon(html);
    const mobs = Object.values(parseMobs(html));
    for (const t of timed) {
      if (mobs.some(m => !m.dead && t.match(m) && m.userdmg < t.dmgTarget)) {
        const hit = mobs.find(m => !m.dead && t.match(m) && m.userdmg < t.dmgTarget);
        log(`⏰ ${hit.name} ready in ${wave.id} → back to bosses`, '#f90');
        delete _waveCache[wave.url];        // force fresh fetch in phase 1
        return true;
      }
    }
  }
  return false;
}

// The REAL auto-die countdown is NOT the wave card's data-expire (that's a far
// despawn ts). It lives on the boss's battle page as
//   window.AUTO_DIE_CFG = { nextDieMs, serverNowMs }
// (the "AUTO DIES AFTER hh:mm:ss" chip). We fetch it and adjust for client/server
// clock skew, returning a client-clock unix-seconds death time.
async function fetchAutoDie(mid) {
  const html = await getHtml(`${BASE}/battle.php?id=${mid}`);
  const nd = html.match(/nextDieMs\s*:\s*(\d+)/);
  if (!nd) return null;
  const sn = html.match(/serverNowMs\s*:\s*(\d+)/);
  const remainMs = parseInt(nd[1]) - (sn ? parseInt(sn[1]) : Date.now());
  return Math.floor((Date.now() + remainMs) / 1000);   // client-clock death ts (s)
}

// Keep the panel's boss death/respawn countdowns fresh even during a long fight
// (the main loop is blocked inside fightTarget for minutes on a big boss). Throttled
// to ~15s. Updates liveBoss (real auto-die, from each alive boss's battle page) +
// S.timers (respawn) without disturbing the user's selected view tab.
let _lastTimerRefresh = 0;
async function refreshTimers() {
  const now = Date.now();
  if (now - _lastTimerRefresh < 15_000) return;
  _lastTimerRefresh = now;
  const seen = new Set();
  for (const wave of WAVES) {
    const timed = wave.targets.filter(t => t.timer);
    if (!timed.length || seen.has(wave.url)) continue;
    seen.add(wave.url);
    const view = saveUserView();
    setCookieRaw('show_dead_bosses_only', 0);
    setHideDead(true);
    const html = await getHtml(wave.url);
    restoreUserView(view);
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    _collectAutoSummon(doc);                         // S.timers (respawn ts)
    const mobs = Object.values(_collectMobs(doc));
    for (const t of timed) {
      const a = mobs.find(m => !m.dead && t.match(m));   // alive matching boss
      if (a) { const die = await fetchAutoDie(a.id); if (die) liveBoss[t.key] = die; }
      else delete liveBoss[t.key];                        // dead → respawn branch (S.timers)
    }
  }
}

// ── COMBAT ────────────────────────────────────────────────────────────────────
// idp = identity params: {monster_id} for waves, {dgmid, instance_id} for guild
// dungeons. The attack tiers/skills and damage.php response are identical; only
// the join/loot endpoints and the mob id differ (verified live).
let _lat = 0;

const isDungeon = idp => idp && idp.dgmid != null;

async function join(idp) {
  if (isDungeon(idp))
    await post('dungeon_join_battle.php', { dgmid: idp.dgmid, instance_id: idp.instance_id, user_id: uid() });
  else
    await post('user_join_battle.php', { monster_id: idp.monster_id, user_id: uid() });
}

async function attack(idp, skillId = SKILL_ID, cost = SKILL_COST) {
  const w = ATK_GAP - (Date.now() - _lat);
  if (w > 0) await sleep(w);
  const d = await post('damage.php', { ...idp, skill_id: skillId, stamina_cost: cost });
  _lat = Date.now();
  if (!d) return null;
  const msg = d.message || '';
  if (msg.includes('Slow down'))          { await sleep(1200); return null; }
  if (/rejoin|removed due/i.test(msg))    { await join(idp);   return null; }
  // death: server refuses the hit while we're dead. Heal+rejoin ONLY if auto-heal is on
  // (S.hpHealPct>0); if it's OFF the user chose not to spend potions → stay dead (the
  // fight loop / processWave skip out and wait for natural HP regen).
  if (/you are dead|you have died|you'?re dead/i.test(msg)) {
    userHp = 0;
    if (S.hpHealPct > 0 && await healUp()) await join(idp);
    return null;
  }
  if (msg.includes('Not enough stamina')) return null;
  if (d.stamina !== undefined) stam = parseInt(d.stamina);
  // track our HP from the boss retaliation; heal when it drops at/below the chosen %
  const ret = d.retaliation || {};
  if (ret.user_hp_after !== undefined) {
    userHp = Math.max(0, parseInt(ret.user_hp_after) || 0);
    if (wantHeal()) { if (await healUp()) await join(idp); }
  }
  return d;
}

async function lootMob(idp) {
  const d = isDungeon(idp)
    ? await post('dungeon_loot.php', { dgmid: idp.dgmid, instance_id: idp.instance_id, user_id: uid() })
    : await post('loot.php', { monster_id: idp.monster_id, user_id: uid() });
  if (d?.status === 'success') { _didWork = true; return d.rewards ?? {}; }   // un loot = lavoro reale
  return null;
}

// ── EXACT-DAMAGE FIGHT (shared by waves + dungeons) ────────────────────────────
// Reaches dmgTarget with minimal overshoot: pick the LARGEST tier whose expected
// damage (tier.stam*K) does NOT overshoot the remaining gap; only the final 1-stam
// hit crosses the line → overshoot ≤ one 1-stamina hit. K = dmg per stamina, learned
// from the first reliable hit. knownStart=true when startDmg is the real prior total
// (wave card userdmg); false for dungeons (we don't know it → learn K on hit #2).
// Returns { dmg, reason: 'done'|'dead'|'cap'|'nostam'|'interrupt' }.
const SMALLEST = SKILLS[SKILLS.length - 1];   // 1-stamina Slash
const PROC_MAX_STAM = 50;                     // proc-farming caps hits at 50 stam (Heroic)

async function fightTarget(idp, label, startDmg, dmgTarget, lsp, interruptible, knownStart, exact = false, harvest = null, timer = false, hardCap = false) {
  await join(idp);
  let dmg = startDmg, K = 0, stall = 0, measured = !!knownStart;
  status = `→ ${shortName(label)}`;

  while (dmg < dmgTarget && !paused && running) {
    // dead with auto-heal OFF → don't burn an HP potion: bail out quietly and let the
    // bot wait for natural HP regen (the next wave read refreshes userHp).
    if (S.hpHealPct <= 0 && userHp != null && userHp <= 0) return { dmg, reason: 'dead' };
    await refreshTimers();   // keep boss death/respawn countdowns fresh during long fights
    if (interruptible && await anyTimedReady()) { _timedInterrupt = true; return { dmg, reason: 'interrupt' }; }

    const remaining = dmgTarget - dmg;
    // 🏰 HARD CAP (dungeon boss): dmgTarget is a STRICT guild ceiling, not a "stop at".
    // Once even the smallest hit (1 stam ≈ K dmg) would cross it, STOP here and stay UNDER
    // — never overshoot the guild's allowed damage. (Normal targets accept a ≤1-hit
    // overshoot; a dungeon boss must not.) K must be known first (we measure it on hit #2).
    if (hardCap && K && remaining < K) {
      log(`🏰 ${label}: cap-safe stop at ${fmtDmg(dmg)} — next hit ≈${fmtDmg(Math.round(K))} would cross cap ${fmtDmg(dmgTarget)}`, '#9cf');
      return { dmg, reason: 'done' };
    }
    // potion ONLY when truly out of stamina — never just to afford a bigger tier
    // (that was the "pozione senza motivo"). With some stamina left we use the
    // biggest tier we can already afford.
    if (stam < 1) {
      // CAP GUARD: se l'ultimo colpo non ha fatto danno (stall>0) il boss è al suo
      // tetto per-giocatore. NON prendere una pozione per inseguire un target
      // irraggiungibile: la sprecheresti (la stamina finirebbe poi sulla wave).
      // Esci subito: i 5000 della pozione restano per il farm, non per colpi a vuoto.
      if (stall > 0) {
        log(`⛔ ${label}: cap reached at ${fmtDmg(dmg)} and out of stamina → leaving WITHOUT a potion`, '#fa0');
        return { dmg, reason: 'cap' };
      }
      // VARIANT B: for farm fights, first try to HARVEST exp (loot dead + briefly wait
      // for near-expiring mobs to die) so a level-up refills stamina → potion saved.
      // Falls back to the potion only if that didn't recover any stamina.
      let recovered = false;
      if (harvest) recovered = await harvest();
      // harvesting (loot dead + brief wait) can refill stamina via a level-up OR a bit
      // of natural regen. RULE: always spend whatever stamina we have before a potion —
      // only drink if it's STILL below a single 1-stam hit. (Was: drank whenever harvest
      // didn't reach the +500 level-up threshold, even if stamina had come back usable →
      // "prendeva la pozione pur avendo stamina residua".)
      if (!recovered && stam < 1 && (lsp === 'asNeeded' || lsp === 'once')) await useLSP(timer);
      if (stam < 1) { log(`out of stamina on ${label} (${stam})`, '#fa0'); return { dmg, reason: 'nostam' }; }
    }
    // pick the attack tier:
    //  • probe (K unknown) → 1 stam
    //  • smallHits proc-farming → fixed medium hits ≤50 stam (Heroic), biggest
    //    affordable; overshoot accepted (more Orryphos free-hit procs).
    //  • EXACT (default, and forced for quests) → compose ONLY the 1/10/50-stam tiers
    //    (Slash/Power/Heroic — NEVER 100/200/1000): the biggest of those that fits the
    //    stamina AND won't overshoot the remaining gap, stepping 50→10→1 toward the
    //    target so the final damage lands exactly on it (overshoot ≤ one 1-stam hit).
    //    Capping at 50 (not 1000) ALSO maximises Orryphos procs: a 3B boss is ~154
    //    Heroic hits = 154 proc chances, vs ~3 with the 1000-stam World Breaker.
    let tier;
    if (!K)                         tier = SMALLEST;
    else if (S.smallHits && !exact) tier = SKILLS.find(s => s.stam <= PROC_MAX_STAM && s.stam <= stam) || SMALLEST;
    else                            tier = SKILLS.find(s => s.stam <= PROC_MAX_STAM && s.stam <= stam && s.stam * K <= remaining) || SMALLEST;

    const before = dmg;
    const res = await attack(idp, tier.id, tier.stam);
    if (!res) continue;
    S.attacks++;
    _didWork = true;                                // ho davvero attaccato → non è un giro a vuoto
    const msg = res.message || '';
    if (msg.includes('Monster is already dead')) { log(`${label} already dead`, '#fa0'); return { dmg, reason: 'dead' }; }
    const nd = parseInt(res.totaldmgdealt || '0');
    if (nd > before) {
      if (!K && measured) {                        // learn K from a hit with a real "before"
        K = (nd - before) / tier.stam;
        const est = Math.max(1, Math.ceil((dmgTarget - nd) / K));
        log(`${label}: ${fmtDmg(Math.round(K))}/stam → ~${est} stam to target`, '#9cf');
      }
      measured = true;                             // after the first hit, "before" is real
      dmg = nd;
      stall = 0;
    } else {
      stall++;
    }
    const hitDmg = nd - before;
    log(`  ⚔ ${tier.stam}⚡ sk${tier.id} · 💥 +${fmtDmg(hitDmg)} → ${fmtDmg(nd)} / ${fmtDmg(dmgTarget)} · K≈${fmtDmg(Math.round(K))}/st · 🔋${stam}${stall ? ` · ⚠ stall ${stall}` : ''}`, hitDmg > 0 ? '#9be7ff' : '#fa0');
    if (stall >= 3) {
      log(`⛔ ${label}: damage stuck at ${fmtDmg(dmg)}/${fmtDmg(dmgTarget)} (cap or undamageable) → moving on`, '#fa0');
      return { dmg, reason: 'cap' };
    }
    // numbers FIRST so the long monster name (truncated) can't push them out of view
    status = `${fmtDmg(dmg)}/${fmtDmg(dmgTarget)} ${stam}⚡ · ${shortName(label)}`;
    renderUI();
  }
  return { dmg, reason: 'done' };
}

// ── VARIANT B: harvest EXP before spending a stamina potion (farm only) ─────────
// When a FARM target runs out of stamina we'd normally drink an LSP. Instead we first
// LOOT every dead matching mob (free EXP, no stamina) and briefly WAIT for mobs that
// are about to auto-die so we can loot them too. Leveling up refills stamina → potion
// saved. Strictly BOUNDED so the farm never stalls for long:
//   • only WAIT when the next death is within WAIT_LOOKAHEAD (otherwise loot now, return)
//   • never wait more than HARVEST_WAIT_CAP in total
// Returns true if stamina recovered (a level-up jump) → caller SKIPS the potion;
// false → caller drinks the potion as fallback.
const HARVEST_WAIT_CAP  = 120_000;  // max total wait per harvest (ms) — tune here
const WAIT_LOOKAHEAD    = 45_000;   // only wait if a mob auto-dies within this window
const HARVEST_MIN_STAM  = 500;      // stamina jump that counts as "leveled up / recovered"

async function harvestWaveExp(wave, targets) {
  const farm = (targets || []).filter(t => !t.timer);
  if (!farm.length) return false;
  const stamStart = stam;
  const deadline  = Date.now() + HARVEST_WAIT_CAP;
  const looted    = new Set();

  while (Date.now() < deadline && !paused && running) {
    delete _waveCache[wave.url];                 // force a fresh read (stamina + dead mobs)
    const mobs = await fetchWave(wave.url, true);

    // loot every dead matching farm mob not yet looted this harvest
    for (const m of mobs.filter(x => x.dead)) {
      if (looted.has(m.id)) continue;
      const t = farm.find(ft => ft.match(m) && !isTimedName(m.name));
      if (!t) continue;
      const r = await lootMob({ monster_id: m.id });
      looted.add(m.id);
      if (r !== null && t.killLimit !== null) {
        S.kills[m.name] = (S.kills[m.name] || 0) + 1;
        log(`loot ✓ ${m.name} — kill #${S.kills[m.name]}${lootSfx(r)}`, '#2f8');
      }
    }
    save();

    // leveled up? stamina jumped → potion saved
    if (stam >= stamStart + HARVEST_MIN_STAM && stam >= SKILL_COST) {
      log(`🌟 looted/leveled → stamina ${stam} (potion saved)`, '#2f8');
      return true;
    }

    // soonest auto-death among alive matching farm mobs
    const now  = Math.floor(Date.now() / 1000);
    const soon = mobs
      .filter(m => !m.dead && m.expire > now && farm.some(t => t.match(m) && !isTimedName(m.name)))
      .map(m => m.expire).sort((a, b) => a - b)[0];
    if (!soon || (soon - now) * 1000 > WAIT_LOOKAHEAD) break;   // nothing dying soon → stop
    const waitMs = Math.min((soon - now) * 1000 + 1500, deadline - Date.now(), 30_000);
    if (waitMs <= 0) break;
    status = `⏳ ${Math.ceil(waitMs / 1000)}s → loot expiring mobs (save potion)`;
    renderUI();
    await sleep(waitMs);
  }
  return stam >= SKILL_COST && stam >= stamStart + HARVEST_MIN_STAM;
}

// ── PROCESS WAVE ──────────────────────────────────────────────────────────────
// targets: subset of wave.targets to process in this pass (timed OR farm).
// Defaults to all targets (backwards-compatible).
async function processWave(wave, targets = null, interruptible = false) {
  targets = targets || wave.targets;
  // QUIET = nessuna stamina per attaccare: questo giro serve solo a lootare i morti
  // (gratis). Niente "fetch g5… → Polydevourer…" e niente log grigi di scan: lascia
  // lo stato "in attesa" impostato dal mainLoop. I morti vengono comunque lootati
  // (e mostrano cosa si è preso). Vedi richiesta utente: "in attesa → solo waiting".
  const quiet = stam < 1;
  // niente più "fetch g5w11…" sullo status (scorreva tutte le wave a vuoto): lo status mostra
  // solo attività reale (→ mob / danno) o "in attesa". Lo scan resta nel log debug se serve.
  // every target loots its dead instances — farm trash AND timed bosses (a killed
  // boss sits dead until looted). Cache makes this ~1 dead-scan per wave / 30s.
  const needDead = true;
  const mobs = await fetchWave(wave.url, needDead);

  const aliveN = mobs.filter(x => !x.dead).length;
  const deadN  = mobs.filter(x => x.dead).length;
  if (!quiet) dlog(`${wave.id}: ${mobs.length} mobs (${aliveN} alive, ${deadN} dead) [${targets.map(t=>t.key).join('+')}]`, '#555');

  // per-target match trace — debug-only (was flooding the default log every ~3s)
  for (const t of targets) {
    const matched = mobs.filter(m => t.match(m));
    const aliveM  = matched.filter(m => !m.dead);
    if (!quiet && matched.length) {
      dlog(`  [${t.key}] ${matched.length} match, ${aliveM.length} alive: ${aliveM.slice(0,6).map(m=>`${m.name}(${fmtDmg(m.userdmg)})`).join(', ')}${aliveM.length>6?'…':''}`, '#888');
    } else if (!quiet) {
      dlog(`  [${t.key}] no match`, '#444');
    }
    // the alive boss's REAL death countdown comes from its battle page (auto-die),
    // not data-expire — refreshTimers() fetches it. Here we just clear it when dead.
    if (t.timer && !aliveM.length) delete liveBoss[t.key];
    // remember farm mob names we've encountered so the 🎯 Farming tab lists what we're
    // farming even before the first kill lands (user: "il tab farming si deve
    // aggiornare con i mostri che farmo").
    if (!t.timer && !t.quest && t.killLimit != null) {
      for (const m of matched) if (!isTimedName(m.name)) S.farmSeen[m.name] = Date.now();
    }
  }

  // loot dead mobs matching this pass's targets (timers come from auto-summon cards)
  for (const m of mobs.filter(x => x.dead)) {
    for (const t of targets) {
      if (!t.match(m)) continue;
      if (!t.timer && isTimedName(m.name)) continue;   // farm never claims a timed boss
      const r = await lootMob({ monster_id: m.id });
      if (r !== null) {
        if (t.killLimit !== null) {
          S.kills[m.name] = (S.kills[m.name] || 0) + 1;
          log(`loot ✓ ${m.name} — kill #${S.kills[m.name]}${lootSfx(r)}`, '#2f8');
        } else {
          log(`loot ✓ ${m.name}${lootSfx(r)}`, '#2f8');
        }
      }
    }
  }
  save();

  // attack alive targets
  for (const t of targets) {
    if (paused || !running) break;

    const alive = mobs.filter(m =>
      !m.dead &&
      t.match(m) &&
      (t.timer || !isTimedName(m.name)) &&        // farm never attacks a timed boss
      m.userdmg < t.dmgTarget &&
      (t.killLimit === null || (S.kills[m.name] || 0) < t.killLimit)
    );

    // dead + auto-heal OFF: nothing to do until HP regenerates (one log, not per-mob spam)
    if (S.hpHealPct <= 0 && userHp != null && userHp <= 0) {
      log(`💀 dead & auto-heal OFF — waiting for HP regen (stop ${t.key})`, '#fa0'); break;
    }

    // quest mobs drink potions unconditionally (must complete the quest); they're
    // farm-type otherwise. `forcePot` makes useLSP/fightTarget treat them like a timed.
    const forcePot = !!(t.timer || t.quest || t.dungeonBoss);

    for (const mob of alive) {
      if (paused || !running) break;
      // QUEST CAP: stop ENGAGING new mobs once we've damaged `need` distinct ones — the
      // kill is credited at loot, so engaging more would over-kill (the reported bug:
      // 7 alive → 7 engaged, respawn → 7 more = 14 for a 10-quest). We still loot the
      // dead ones above; we just don't start additional mobs.
      if (t.quest && S.questActive) {
        const need = S.questActive.need || 10;
        if ((S.questActive.engaged || 0) >= need) {
          log(`📜 quest: engaged ${S.questActive.engaged}/${need} mobs — waiting for kills to credit (have ${S.questActive.have || 0})`, '#9cf');
          break;
        }
      }
      // before starting a farm mob, give timed bosses a chance
      if (interruptible && await anyTimedReady()) { _timedInterrupt = true; return; }

      // RULE: never drink with stamina left. The old `useLSP==='once'` here drank a
      // potion at the START of every mob even on a full bar — removed. Potions are
      // taken ONLY below, when stamina is actually exhausted (stam < 1).
      if (stam < 1) {
        // VARIANT B: farm targets first try to harvest exp (loot + wait for expiring
        // mobs → level-up refills stamina) before drinking; timed bosses just drink.
        if (!t.timer) await harvestWaveExp(wave, targets);
        if (stam < 1 && (t.useLSP === 'asNeeded' || t.useLSP === 'once')) await useLSP(forcePot);
        // niente stamina e niente pozione utilizzabile: tutti i mob restanti di
        // questo target richiedono stamina → inutile provarli a uno a uno (era lo
        // spam "no stam — skip" ×42/ciclo). Esci dal target.
        if (stam < 1) { log(`no stamina — stop ${t.key} (${alive.length} mobs waiting for stamina)`, '#fa0'); break; }
      }

      log(`→ ${mob.name} (${fmtDmg(mob.userdmg)} / ${fmtDmg(t.dmgTarget)}) stam:${stam}`, '#7df');
      const { dmg, reason } = await fightTarget(
        { monster_id: mob.id }, mob.name, mob.userdmg, t.dmgTarget, t.useLSP, interruptible, true, !!t.exact,
        (t.timer || t.dungeonBoss) ? null : (() => harvestWaveExp(wave, targets)), forcePot, !!t.dungeonBoss);
      if (reason === 'interrupt') return;             // a timed boss respawned → bail to phase 1
      if (dmg >= t.dmgTarget) {
        // quest: this mob is now engaged (≥ minDmg) → count it against `need` so we
        // don't start more than required. Credit still arrives via loot.
        if (t.quest && S.questActive) S.questActive.engaged = (S.questActive.engaged || 0) + 1;
        const over = dmg - t.dmgTarget;   // residuo oltre il target (≤ 1 colpo da 1 stam)
        if (t.timer) {
          S.timedKills++;
          S.timedBy[t.key] = (S.timedBy[t.key] || 0) + 1;
          log(`✓ TIMED #${S.timedKills} — ${mob.name} ${fmtDmg(dmg)} (+${fmtDmg(over)} over ${fmtDmg(t.dmgTarget)})`, '#2f8');
        } else {
          log(`✓ ${mob.name} — ${fmtDmg(dmg)} (+${fmtDmg(over)} over)`, '#2f8');
        }
      }
      save();
    }
  }
}

// ── PROCESS DUNGEON (guild dungeon boss on battle.php?dgmid=…&instance_id=…) ────
// One boss per source: join → exact-damage to the configured dmgTarget → loot.
async function processDungeon(src) {
  const t = (src.targets || [])[0];
  if (!t || t.enabled === false) return;
  if (stam < 1) {
    if (t.useLSP) await useLSP(t.timer || t.dungeonBoss);
    if (stam < 1) { log(`no stamina — skip dungeon ${src.label}`, '#fa0'); return; }
  }
  const idp = { dgmid: src.dgmid, instance_id: src.instance_id };
  log(`→ 🏰 dungeon ${src.label} (target ${fmtDmg(t.dmgTarget)}) stam:${stam}`, '#7df');
  // startDmg 0 + knownStart=false → fightTarget learns K on hit #2 (we don't know
  // our prior cumulative damage on this boss; totaldmgdealt gives the real total).
  // dungeonBoss → drink unconditionally (timer-like) + hard cap (stay under guild limit).
  const { dmg, reason } = await fightTarget(idp, src.label, 0, t.dmgTarget, t.useLSP, false, false, !!t.dungeonBoss, null, t.timer || t.dungeonBoss, !!t.dungeonBoss);
  if (reason === 'done' || dmg >= t.dmgTarget || reason === 'dead' || reason === 'cap') {
    const r = await lootMob(idp);
    log(`${reason === 'dead' ? '☠️' : '✓'} dungeon ${src.label} — ${fmtDmg(dmg)}${r ? ' · loot ✓' : ''}`, '#2f8');
  }
  save();
}

// ── PROCESS GUILD DUNGEON LOCATION (many .mon instances on one location page) ──
// Instances respawn with NEW dgmids, so we can't hardcode them: each pass we re-read
// the location page, loot the dead matching instances, then fight each alive matching
// instance (its CURRENT dgmid) to the target's dmgTarget. Matches by monster NAME
// (include/exclude) exactly like a wave — one source can target several monster types.
async function processDungeonLocation(src) {
  const targets = (src.targets || []).filter(t => t.enabled !== false);
  if (!targets.length) return;

  // throttle the page read: when everything is dead this would otherwise re-fetch
  // ~twice a second (the main loop only sleeps 600ms while stamina is left) and hammer
  // the server. While cached we just skip the pass.
  //   • normal targets        → 12s (gentle, the room isn't time-critical)
  //   • 🏰 dungeon boss armed  → DUNGEON_BOSS_POLL (~3s) so we SEE the room open fast
  const hasBoss   = targets.some(t => t.dungeonBoss);
  const readEvery = hasBoss ? DUNGEON_BOSS_POLL : 12_000;
  const now = Date.now();
  const hit = _dlCache[src.id];
  let mons;
  if (hit && now - hit.ts < readEvery) {
    mons = hit.mons;
  } else {
    status = `fetch 🏰 ${src.label}…`; renderUI();
    const html = await getHtml(srcUrl(src));
    if (!html) return;
    parseStam(html);
    mons = parseDungeonMons(html);
    _dlCache[src.id] = { ts: Date.now(), mons };
    const aliveN = mons.filter(m => !m.dead).length;
    log(`🏰 ${src.label}: ${mons.length} instances (${aliveN} alive) [${targets.map(t => t.key).join('+')}]`, '#558');
  }
  const matched = targets.map(t => ({ t, fn: makeMatch(t.include, t.exclude) }));

  // loot dead matching instances — ONCE per dgmid (a looted instance keeps showing
  // until it respawns with a NEW dgmid, so the set never blocks a fresh kill).
  for (const m of mons.filter(x => x.dead)) {
    if (isLooted(m.dgmid)) continue;
    for (const { t, fn } of matched) {
      if (!fn(m)) continue;
      const r = await lootMob({ dgmid: m.dgmid, instance_id: m.instance_id });
      lootedAdd(m.dgmid);
      if (r !== null) {
        if (t.killLimit !== null) S.kills[m.name] = (S.kills[m.name] || 0) + 1;
        const kc   = t.killLimit !== null ? ` · kill #${S.kills[m.name]}` : '';
        const loot = fmtLoot(r);
        log(`💰 loot 🏰 ${m.name}${kc}${loot ? ` → ${loot}` : ' (vuoto)'}`, '#ffd54a');
      }
      break;   // one target claims it
    }
  }
  save();

  // fight alive matching instances
  for (const { t, fn } of matched) {
    if (paused || !running) break;
    // SKIP mobs we already reached the target on (added to _dlLooted below). Cube mobs
    // are SHARED damage targets that don't die from our hit, so loot fails and they stay
    // "alive" — without this skip the same mob got re-fought every pass and kept dealing
    // damage FAR past the configured target ("continua a fare danno sopra i 200M").
    const alive = mons.filter(m => !m.dead && fn(m) && !isLooted(m.dgmid) &&
      (t.killLimit === null || (S.kills[m.name] || 0) < t.killLimit));
    for (const m of alive) {
      if (paused || !running) break;
      if (stam < 1) {
        if (t.useLSP) await useLSP(t.timer || t.dungeonBoss);
        if (stam < 1) { log(`no stamina — stop 🏰 ${t.key}`, '#fa0'); return; }
      }
      log(`⚔️ attacking 🏰 ${m.name} → target ${fmtDmg(t.dmgTarget)} · 🔋${stam}`, '#7df');
      const idp = { dgmid: m.dgmid, instance_id: m.instance_id };
      // dungeonBoss → exact tiers + drink unconditionally + HARD CAP (never cross the guild limit).
      const { dmg, reason } = await fightTarget(idp, m.name, 0, t.dmgTarget, t.useLSP, false, false, !!t.exact || !!t.dungeonBoss, null, t.timer || t.dungeonBoss, !!t.dungeonBoss);
      if (reason === 'done' || dmg >= t.dmgTarget || reason === 'dead' || reason === 'cap') {
        const r = await lootMob(idp);
        lootedAdd(m.dgmid);   // claimed (persisted) → won't be re-fought even after a reload
        if (r !== null && t.killLimit !== null) S.kills[m.name] = (S.kills[m.name] || 0) + 1;
        delete _dlCache[src.id];   // state changed → re-read the page next pass
        const loot = r !== null ? fmtLoot(r) : null;
        const tag  = reason === 'dead' ? '☠️' : reason === 'cap' ? '🛑' : '✅';
        const col  = reason === 'cap' ? '#fa0' : '#2f8';
        log(`${tag} 🏰 ${m.name} — ${fmtDmg(dmg)} / target ${fmtDmg(t.dmgTarget)}${loot ? ` · 💰 ${loot}` : ''}`, col);
      }
      save();
    }
  }
}

// ── ADVENTURER'S GUILD QUESTS ──────────────────────────────────────────────────
// All quests target g5w9 mobs (verified): "Kill 10 <monster> · min 5m dmg" or
// "Gather Nx <item>". Endpoints (verified from the page's own JS):
//   accept : POST /adventurers_accept_quest.php {quest_id} → {status:'ok'}
//   finish : POST /adventurers_finish_quest.php {quest_id} → ok only if objective met
//   giveup : POST /adventurers_giveup_quest.php {quest_id}
// Rules: ONE active quest at a time; a finished quest goes on a 2-day rotation
// cooldown (its row then loses the accept button → we just pick another available
// one). Flow per cycle: finish if complete → accept next available → farm its mob
// on g5w9 to ≥minDmg each (server counts the kill when the mob dies with our hit).
const GUILD_URL  = `${BASE}/adventurers_guild.php`;
const QUEST_WAVE = `${BASE}/active_wave.php?gate=5&wave=9`;
const QUEST_DMG  = 5_000_000;            // default min damage per mob (quests ask ≥3–5m)
const QUEST_INTERVAL = 20_000;           // how often we re-read the guild page
let _lastQuest = 0;
let _questCooldowns = [];                 // [{title, ts}] cooldown quests tracked for the UI

const _qid = el => parseInt((el.getAttribute('onclick') || '').match(/\((\d+)/)?.[1] || '0');

// the monster a quest targets: req-text "Monster: X" → desc "Kill N X while …" →
// "from (a) defeated X". null = unknown → farm ALL g5w9 mobs (covers gather quests).
function questMonster(row) {
  const req = row.querySelector('.quest-req-text')?.textContent || '';
  let m = req.match(/Monster:\s*([^·\n]+?)\s*(?:·|$)/i);
  if (m) return m[1].trim().toLowerCase();
  const desc = row.querySelector('.quest-main-desc')?.textContent || '';
  m = desc.match(/Kill\s+\d+\s+(.+?)\s+while dealing/i);
  if (m) return m[1].trim().toLowerCase();
  m = desc.match(/from (?:a )?defeated\s+([A-Za-z' ]+?)(?:[.,]|\s+so\b|$)/i);
  if (m) return m[1].trim().toLowerCase();
  return null;
}
function questMinDmg(row) {
  const m = (row.querySelector('.quest-req-text')?.textContent || '').match(/min\s*([\d,]+)\s*dmg/i);
  const n = m ? parseInt(m[1].replace(/,/g, '')) : 0;
  return n > 0 ? n : QUEST_DMG;
}

// the single active quest (row carrying give-up/finish controls), or null
function parseActiveQuest(doc) {
  for (const row of doc.querySelectorAll('.quest-row')) {
    const fin = row.querySelector('[onclick*="finishQuest"]');
    const giv = row.querySelector('[onclick*="giveUpQuest"]');
    if (!fin && !giv) continue;
    const pm   = (row.querySelector('.quest-progress')?.textContent || '').match(/([\d,]+)\s*\/\s*([\d,]+)/);
    const have = pm ? parseInt(pm[1].replace(/,/g, '')) : 0;
    const need = pm ? parseInt(pm[2].replace(/,/g, '')) : 10;
    return {
      id: _qid(fin || giv), have, need,
      finishable: !!fin || (need > 0 && have >= need),
      monster: questMonster(row), minDmg: questMinDmg(row),
      title: (row.querySelector('.quest-main-title')?.textContent || '').trim(),
    };
  }
  return null;
}

// quests we can accept right now (accept button present, not on 2-day cooldown,
// charges remaining). Cooldown rows replace the button with a data-cooldown-ts
// countdown → they have no accept button, so they're skipped naturally.
function parseAvailableQuests(doc) {
  const out = [], now = Math.floor(Date.now() / 1000);
  for (const row of doc.querySelectorAll('.quest-row')) {
    const acc = row.querySelector('[onclick*="acceptQuest"]');
    if (!acc) continue;
    const cdEl = row.querySelector('[data-cooldown-ts]');
    if (cdEl && parseInt(cdEl.getAttribute('data-cooldown-ts') || '0') > now) continue;
    const lim = row.textContent.match(/(\d+)\s*\/\s*\d+\s*remaining/i);
    if (lim && parseInt(lim[1]) <= 0) continue;
    out.push({
      id: _qid(acc), monster: questMonster(row), minDmg: questMinDmg(row),
      title: (row.querySelector('.quest-main-title')?.textContent || '').trim(),
    });
  }
  return out;
}

// quests currently on the 2-day cooldown rotation (no accept button, future
// data-cooldown-ts) → tracked so the UI can show when each frees up again.
function parseQuestCooldowns(doc) {
  const out = [], now = Math.floor(Date.now() / 1000);
  for (const row of doc.querySelectorAll('.quest-row')) {
    const cdEl = row.querySelector('[data-cooldown-ts]');
    if (!cdEl) continue;
    const ts = parseInt(cdEl.getAttribute('data-cooldown-ts') || '0');
    if (ts <= now) continue;   // already off cooldown → it'll be in "available"
    out.push({ title: (row.querySelector('.quest-main-title')?.textContent || 'quest').trim(), ts });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

async function fetchGuild() {
  const html = await getHtml(GUILD_URL);
  return html ? new DOMParser().parseFromString(html, 'text/html') : null;
}

// a transient farm wave for the active quest's monster on g5w9. Unknown monster →
// empty include = match ALL g5w9 mobs (so gather quests still progress). Core token
// only (split on comma) so "Charybdis, Living Maelstrom" matches via "charybdis".
function questWaveFor(q) {
  const dmg = Math.round((q.minDmg || QUEST_DMG) * 1.02);   // tiny margin over the floor
  const inc = q.monster ? [q.monster.split(',')[0].trim()] : [];
  return {
    id: 'quest', label: `Quest: ${q.title}`, url: QUEST_WAVE,
    targets: [{
      key: 'quest', label: q.monster || 'quest mobs', srcName: 'quest',
      match: makeMatch(inc, []), dmgTarget: dmg, exact: true,
      // quest:true → (1) always uses potions (like a timed boss, ignores the farm
      // toggle) and (2) caps engagement at the quest's `need` so it never kills MORE
      // mobs than required (the kill is credited at LOOT, so we engage exactly `need`
      // distinct mobs and then just loot them as they die — see processWave).
      killLimit: null, useLSP: 'asNeeded', timer: false, quest: true, enabled: true,
    }],
  };
}

// Drive the Adventurer's Guild "di seguito": finish a completed quest → accept the
// next available one (only ONE at a time) → farm its mob to the server target → on
// the next read finish it and accept the next, and so on. Cooldown quests are just
// tracked for the UI. The guild page is re-read at most every QUEST_INTERVAL; between
// reads we keep farming the cached active quest's mob (LSP refills the stamina).
//
// Returns TRUE while there is still quest work pending → the main loop then SKIPS the
// general farm waves, so stamina is spent ONLY on the quest (refilled with LSP) and
// never wasted on the waves. Returns FALSE only when nothing is left to do right now
// (no active quest and everything else on cooldown).
async function processQuests() {
  if (!S.questEnabled) return false;

  if (Date.now() - _lastQuest > QUEST_INTERVAL) {
    _lastQuest = Date.now();
    const doc = await fetchGuild();
    if (doc) {
      _questCooldowns = parseQuestCooldowns(doc);
      let active = parseActiveQuest(doc);

      // 1) finish a completed quest → frees the single active slot
      if (active && active.finishable) {
        const r = await post('adventurers_finish_quest.php', { quest_id: active.id });
        if (r && r.status === 'ok') { S.questDone++; log(`🏅 quest done: ${active.title} (${active.have}/${active.need})`, '#2f8'); }
        else log(`quest finish failed (${active.title}): ${r?.message || 'no resp'}`, '#f66');
        active = null;
      }

      // 2) no active quest → accept the next available (off cooldown), then farm it
      if (!active) {
        const avail = parseAvailableQuests(doc);
        if (avail.length) {
          const p = avail[0];
          const r = await post('adventurers_accept_quest.php', { quest_id: p.id });
          if (r && r.status === 'ok') {
            S.questTaken++;
            active = { id: p.id, title: p.title, monster: p.monster, minDmg: p.minDmg, have: 0, need: 10, engaged: 0 };
            log(`📜 quest accepted: ${p.title}${p.monster ? ` → ${p.monster}` : ''} (min ${fmtDmg(p.minDmg)})`, '#9cf');
          } else log(`quest accept failed (${p.title}): ${r?.message || 'no resp'}`, '#f66');
        } else {
          dlog(`quests: none available · ${_questCooldowns.length} on cooldown`, '#778');
        }
      }

      // carry the local "engaged" count across guild re-reads (same quest id), and never
      // let it drop below the server-credited `have` → caps over-killing reliably.
      if (active) {
        const prev = (S.questActive && S.questActive.id === active.id) ? (S.questActive.engaged || 0) : 0;
        active.engaged = Math.max(prev, active.have || 0);
      }
      S.questActive = active;   // cache for the UI + the farm pass below
      save();
    }
  }

  // farm the active quest's mob (interruptible: timed bosses keep priority). Report
  // "pending" so the caller skips the waves until the quest slot is empty.
  const q = S.questActive;
  if (q && (q.have || 0) < (q.need || 10)) {
    status = `📜 quest: ${q.title}`;
    await processWave(questWaveFor(q), null, true);
    // Reserve stamina (skip the farm pass) ONLY while we still need to ENGAGE more
    // quest mobs. Once `need` of them are engaged we're just waiting for the loot to
    // credit (have → need) — don't idle on the quest wave, let Phase 2 farm run.
    return (q.engaged || 0) < (q.need || 10);
  }
  // an active-but-finishable quest is turned in on the next read → still pending
  return !!(q && q.finishable);
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────
// Pass 1: timed bosses across ALL waves (high priority, with LSP).
// Pass 2: farm mobs across ALL waves (use remaining stamina).
// fetchWave has a 30s cache so each wave is only fetched once per cycle.
// ── AUTO-PvP MODULE ─────────────────────────────────────────────────────────────
// Solo 1v1, a turni (~10s/turno). Pilota il match con la stessa API della pagina:
//   pvp_battle_state.php (GET stato) · pvp_battle_action.php (POST use_skill) · pvp_matchmake.php
// Risorsa = Rage (Berserker). Passivo "Rage Engine": il danno cresce con la Rage attuale.
// Ragnarok Cleave (adv:8) richiede Rage PIENA (requires_full_resource) — il nuke grosso.
// Le skill lanciate a Rage PIENA hanno effetto POTENZIATO (es. Ironclad → +DEF, 2 turni):
// le IMPARIAMO dal log per skill/livello-di-rage, così la strategia si adatta a ogni match.
const PVP_PAGE = /\/pvp(_battle)?\.php$/.test(location.pathname);
let _pvpUrlConsumed = false, _pvpStale = 0, _pvpLastSave = 0;
let _pvpTurnMid = null, _pvpMyTurns = 0;   // conta i MIEI turni nel match corrente (per l'apertura Ironclad)

const pvpReqHeaders = extra => Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, extra || {});
async function pvpState(mid) {
  try {
    const r = await fetchT(`${BASE}/pvp_battle_state.php?match_id=${mid}&since_log_id=0`, { headers: pvpReqHeaders() }, 12000);
    return await r.json();
  } catch { return {}; }
}
async function pvpPostJson(path, body) {
  try {
    const r = await fetchT(`${BASE}/${path}`, {
      method:  'POST',
      headers: pvpReqHeaders({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
      body:    new URLSearchParams(body).toString(),
    }, 12000);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return {}; }
  } catch { return {}; }
}
const pvpAction = (mid, since, skillId, targetKey) =>
  pvpPostJson('pvp_battle_action.php', { match_id: mid, since_log_id: since, action: 'use_skill', skill_id: skillId, target_key: targetKey });

// costo Rage EFFETTIVO: le skill avanzate richiedono la risorsa PIENA (il campo `cost`
// è fuorviante — contano `requires_full_resource` + `resource_cost`).
const pvpRageCost = (k, max) => k.requires_full_resource ? (max || 100)
  : (k.resource_cost != null ? k.resource_cost : (k.cost || 0));

const _pvpSeen = {};   // mid:logId → 1 (dedup tra i poll)
// statistiche del match CORRENTE (per diagnosticare PERCHÉ vinci/perdi). Si azzerano a ogni
// nuovo match (mid diverso). myDmg = danno che faccio, enemyDmg = danno che subisco,
// enemyHeal = quanto si cura il nemico, enemyBig = il suo colpo più forte su di me.
// myTokens/enemyTokens = somma dei costi-token delle skill usate nel match (da d.skill.cost).
let _pvpMatchStats = { mid: null, myDmg: 0, enemyDmg: 0, enemyHeal: 0, enemyBig: 0, myTokens: 0, enemyTokens: 0 };
// classifica una classe dai dati IMPARATI: curatore (si cura tanto / ha skill di cura) e/o
// nuker (colpo singolo molto forte). Guida la strategia in pvpPick.
function pvpProfile(cls) {
  const C = (S.pvp.db.classes || {})[cls];
  if (!C) return { healer: false, bursty: false, C: null };
  const m = Math.max(1, C.matches || 1);
  const hasHealSkill = Object.keys(C.skills || {}).some(n => /heal|recover|bless|sanct|mend/i.test(n));
  const healer = hasHealSkill || (C.healed || 0) / m > 50000;     // cura > ~50k a match
  const bursty = (C.bigHit?.dmg || 0) > 250000 || cls === 'Assassin'; // colpo singolo enorme
  return { healer, bursty, C };
}
// impara da OGNI voce di log: danno delle mie skill (bucket per Rage, così becca la variante
// POTENZIATA a Rage piena) + skill/effetti/retaliation/note di ogni classe avversaria.
function pvpLearn(mid, state, logs, rageBefore) {
  const db = S.pvp.db;
  const enemyU = Object.values(state.teams?.enemy?.players_by_num || {})[0];
  const cls = enemyU?.advanced_class_name || 'Unknown';
  if (_pvpMatchStats.mid !== mid) _pvpMatchStats = { mid, myDmg: 0, enemyDmg: 0, enemyHeal: 0, enemyBig: 0, myTokens: 0, enemyTokens: 0 };
  for (const l of (logs || [])) {
    const key = mid + ':' + l.id; if (_pvpSeen[key]) continue; _pvpSeen[key] = 1;
    const d = l.details; if (!d || !d.skill) continue;
    const dmg  = (d.target?.hp_before || 0) - (d.target?.hp_after || 0);  // >0 danno, <0 cura
    const self = (d.actor?.hp_before  || 0) - (d.actor?.hp_after  || 0);
    if (d.actor?.side === 'ally') {
      const name = d.skill.name;
      const m = db.my[name] = db.my[name] || { id: d.skill.id, cost: d.skill.cost, maxDmg: 0, byRage: {} };
      m.id = d.skill.id;
      if (dmg > m.maxDmg) m.maxDmg = dmg;
      if (dmg > 0) _pvpMatchStats.myDmg += dmg;
      _pvpMatchStats.myTokens += (d.skill.cost || 0);   // token spesi da me (per il report)
      const bucket = (rageBefore != null && rageBefore >= 100) ? 'full' : 'partial';
      const b = m.byRage[bucket] = m.byRage[bucket] || { maxDmg: 0, note: '' };
      if (dmg > b.maxDmg) b.maxDmg = dmg;
      // a Rage piena cattura il testo dell'effetto potenziato (dal contenuto del log)
      const eff = bucket === 'full' && (l.content || '').match(/((?:gains?|grants?|\+\d+%|defen\w*|shield|heal\w*|poison|stun)[^.]*?for \d+ (?:full )?turns?|\+\d+%[^.]*)/i);
      if (eff) b.note = eff[0].slice(0, 90);
    } else {
      const C = db.classes[cls] = db.classes[cls] || { class: cls, resource: enemyU?.advanced_resource_name, skills: {}, effects: {}, notes: {}, matches: 0, losses: 0, dmgToMe: 0, healed: 0, bigHit: { dmg: 0, skill: '' } };
      const sk = C.skills[d.skill.name] = C.skills[d.skill.name] || { id: d.skill.id, cost: d.skill.cost, maxDmg: 0, retaliationToMe: 0 };
      _pvpMatchStats.enemyTokens += (d.skill.cost || 0);   // token spesi dal nemico (visibili → report)
      if (dmg  > sk.maxDmg)          sk.maxDmg = dmg;
      if (self > sk.retaliationToMe) sk.retaliationToMe = self;
      if (d.formula?.attack_notes)  C.notes.attack  = d.formula.attack_notes;
      if (d.formula?.defense_notes) C.notes.defense = d.formula.defense_notes;
      // PATTERN per classe: quanto mi colpisce / quanto si cura / colpo più forte
      if (dmg > 0) {                                   // mi ha fatto danno
        _pvpMatchStats.enemyDmg += dmg;
        if (dmg > _pvpMatchStats.enemyBig) _pvpMatchStats.enemyBig = dmg;
        C.dmgToMe = (C.dmgToMe || 0) + dmg;
        if (dmg > (C.bigHit?.dmg || 0)) C.bigHit = { dmg, skill: d.skill.name };
      } else if (dmg < 0) {                            // si è curato
        _pvpMatchStats.enemyHeal += -dmg;
        C.healed = (C.healed || 0) + (-dmg);
      }
    }
  }
  if (enemyU) {
    const C = db.classes[cls] = db.classes[cls] || { class: cls, resource: enemyU.advanced_resource_name, skills: {}, effects: {}, notes: {}, matches: 0, losses: 0 };
    for (const e of (enemyU.effects || [])) { const n = e.name || e.label || e.id; if (n) C.effects[n] = e; }
  }
}

// scelta adattiva della skill — "quale e quando". Usa il danno IMPARATO nel db, il nuke a
// Rage piena, la consapevolezza della classe (curatori → burst) e una regola di sopravvivenza
// (HP basso a Rage piena → skill difensiva potenziata invece del nuke).
function pvpPick(state, myTurns) {
  const me = state.me || {};
  const rage = me.advanced_resource || 0, max = me.advanced_resource_max || 100;
  // TOKEN = pool del match (cap ~40, rigenera ogni turno). `skill.cost` è il costo in TOKEN
  // (Slash 0, Ironclad/War Aura 6, Power Slash 9, Ragnarok 15). Slash GRATIS = builder che carica
  // Rage E lascia rigenerare i token. La Rage (0-100, +25/turno) si AZZERA dopo 100 se non spesa.
  const tokens = Number(me.tokens) || 0;
  const skills = me.skills || [];
  const enemy = Object.values(state.teams?.enemy?.players_by_num || {}).find(u => u.alive);
  if (!enemy) return null;
  const ehp = enemy.hp || 1e9;
  const cls = enemy.advanced_class_name || 'Unknown';
  const prof = pvpProfile(cls);   // {healer, bursty} imparato dai match precedenti
  const atFull = rage >= max;
  const cost = k => k && k.cost || 0;
  // danno IMPARATO di una mia skill nel bucket di Rage che vale ADESSO (full vs partial).
  const dmgOf = k => {
    const e = S.pvp.db.my[k && k.name]; if (!e) return null;
    const b = e.byRage || {};
    const v = atFull ? (b.full && b.full.maxDmg) : (b.partial && b.partial.maxDmg);
    return v || e.maxDmg || 0;
  };
  // Taunt è inutile in 1v1 (forza il bersaglio su di te ma sei solo) — il gioco stesso dice
  // "Solo PvP AI will not use Taunt". Mai sceglierla. Vedi pvp_skills_kb.json soloPvpExclude.
  const soloExclude = k => /^\s*taunt\s*$/i.test(k && k.name || '');
  // LANCIABILI ORA = abbastanza TOKEN per il costo, e le full-resource (Ragnarok) anche Rage piena.
  const usable = skills.filter(k => k.type === 'attack' && !soloExclude(k) && tokens >= cost(k) && (!k.requires_full_resource || atFull));
  const nukeSk    = skills.find(k => k.requires_full_resource);      // Ragnarok Cleave
  const warAuraSk = skills.find(k => /warrior aura/i.test(k.name));
  const comboCost = cost(warAuraSk) + cost(nukeSk) || 21;            // War Aura(6) + Ragnarok(15) = 21 token
  const slash     = skills.find(k => String(k.id) === '0');         // builder gratuito
  const ironclad  = usable.find(k => /ironclad/i.test(k.name)) || usable.find(k => /guard/i.test(k.name));

  const enemyFx = enemy.effects || [];
  const enemyStunned = enemyFx.some(e => /stun/i.test(e.name || e.label || e.key || ''));
  const shredUp      = enemyFx.some(e => /defense change|defen|armor|shred|break/i.test(e.name || e.label || e.key || ''));
  const haveDef = (Object.values(state.teams?.ally?.players_by_num || {})[0]?.effects || [])
    .some(e => /def|guard|iron|shield|aegis/i.test(e.name || e.label || e.key || ''));
  const eMax = enemy.advanced_resource_max || 0;
  // I NUKER (Assassino) lanciano il loro ULTIMATE appena la risorsa è piena — es. "Final Wish" è il
  // loro Ragnarok (risorsa piena + token). Per i bursty bracciamo già al 75% così l'Ironclad è su
  // PRIMA che colpiscano (al 100% reagirei troppo tardi). Per gli altri solo a barra piena.
  const enemyNukeReady = eMax > 0 && (enemy.advanced_resource || 0) >= eMax * (prof.bursty ? 0.75 : 1) && !enemyStunned;
  const enemyResFull   = eMax > 0 && (enemy.advanced_resource || 0) >= eMax && !enemyStunned;
  const haveNuke = Object.keys(S.pvp.db.my).some(n => /ragnarok/i.test(n)) || !!nukeSk;

  // HP% MIO — la combo War Aura→Ragnarok va scaricata SOTTO il 50% HP. Lì la lifesteal di Ragnarok
  // (Blood Frenzy scala con la vita mancante: ~43-50%) SUPERA la backlash da 261k → Ragnarok NET-HEALA
  // mentre nuca, ed è il picco di danno del Berserker. SOPRA il 50% NON si spreca: si Slasha (gratis),
  // si CONSERVANO i token, si lascia ciclare la Rage (use-it-or-lose-it) e rampare il Rage Engine.
  // Idea di UANM 2026-06-23: "conserva i token, sotto il 50% combo War Aura→Ragnarok e ti curi subito".
  const meP = Object.values(state.teams?.ally?.players_by_num || {})[0] || {};
  const myHpPct = meP.hp_max ? (meP.hp || 0) / meP.hp_max : 1;
  const lowHp = myHpPct <= 0.50;          // finestra Ragnarok (net-heal)
  const comboWindow = myHpPct <= 0.55;    // lead-in: War Aura il turno prima, così lo shred è su quando scendi sotto 50
  // La strategia "conserva token + combo a vita bassa" è SPECIFICA del Berserker: solo RAGNAROK CLEAVE
  // net-heala a HP basso (Blood Frenzy) e solo lui ha il setup War Aura. Le ALTRE classi (un amico che usa
  // l'AutoPvP — Assassin/Mage/Magic Knight…) NON devono tenere l'ultimate per il low-HP: il loro nuke
  // (Final Wish, Mana Collapse, Eclipse Sever…) va sparato a risorsa PIENA, subito. `zerk` separa i regimi.
  const zerk = (nukeSk && /ragnarok/i.test(nukeSk.name || '')) ||
               Object.keys(S.pvp.db.my).some(n => /ragnarok/i.test(n));

  // RACE MODE — contro nemici VELOCI/bursty o che storicamente ti battono a DPS (`out-damaged`,
  // es. l'Assassino): NON rallentare con Slash (45k) come filler né sprecare turni in Ironclad.
  // Corri col miglior colpo affordable (Power Slash ~455k) tenendo i token per il Ragnarok a Rage
  // piena. Eccezione: le classi che ti uccidono col NUKE (es. Magic Knight → `their nuke`) → la
  // parata resta giusta, quindi NON entrare in race (nukeKiller).
  const lr = (prof.C && prof.C.lossReasons) || {};
  const outDmgLosses = lr['out-damaged'] || 0, nukeLosses = lr['their nuke'] || 0;
  const dpm = (prof.C && prof.C.dmgToMe || 0) / Math.max(1, prof.C && prof.C.matches || 0);
  // NUKER = il suo colpo più forte è di fascia LETALE. ≥500k separa nettamente i nuker veri
  // (Assassin/Magic Knight/Grand Mage 720–880k) da TUTTI gli altri (≤377k). Contro un nuker NON
  // si corre la gara di DPS: si PARA il burst (Ironclad +41% def 2t) e poi si punisce. FIX 2026-06-23
  // (export 22 KO): l'Assassino era in RACE e perdeva 7/8 al suo Final Wish/Death Mark (Killing Tempo
  // lo fa scattare 2 volte a risorsa piena). Hardcode Assassin come safety con DB fresco (bigHit non
  // ancora imparato). Vedi reference-pvp-skills-kb / reference-berserker-pvp-strategy.
  const isNuker = (prof.C && (prof.C.bigHit?.dmg || 0) >= 500000) || cls === 'Assassin';
  const nukeKiller = isNuker || (nukeLosses >= 1 && outDmgLosses === 0);   // nuker o ti batte SOLO col nuke → para, non correre
  const race = !nukeKiller && (prof.bursty || outDmgLosses >= 1 || dpm > 400000);
  // miglior colpo NON-ultimate affordable (di norma Power Slash) — il workhorse della race
  const powerHit = usable.filter(k => !k.requires_full_resource && String(k.id) !== '0')
    .sort((a, b) => (dmgOf(b) || 0) - (dmgOf(a) || 0))[0];

  // 1) LETALE: la skill affordable più economica (in token) che uccide ORA (≥ HP nemico).
  const lethal = usable.filter(k => (dmgOf(k) || 0) >= ehp).sort((a, b) => cost(a) - cost(b))[0];
  if (lethal) { S.pvp.note = 'lethal ' + lethal.name; return { id: lethal.id, tk: enemy.key }; }

  // 0) APERTURA — primo mio turno: Ironclad per reggere il nuke d'apertura (molti partono a risorsa
  //    piena e nukano subito). Ho 40 token a inizio match → Ironclad è sempre affordable al turno 1.
  if ((myTurns || 0) === 0 && ironclad && !haveDef && !race) {
    S.pvp.note = 'opener ironclad'; return { id: ironclad.id, tk: enemy.key };
  }

  // 2) BRACE — il nemico sta per nukare (Assassino → "Final Wish", il suo Ragnarok: risorsa piena +
  //    token) e non ho DEF su → Ironclad per ASSORBIRE il nuke. Per i bursty scatta già al 75% (DEF su
  //    in tempo). A Rage piena Ironclad è la 2-turni. Salto vs healer puro. Token permettendo.
  //    In RACE mode NON bracciamo al 75% (regalerebbe la gara di DPS): paro SOLO quando la risorsa
  //    nemica è davvero al 100% (Final Wish imminente) e non posso vincere lo scambio ora.
  const braceNow = race ? (enemyResFull && tokens < cost(nukeSk || {})) : enemyNukeReady;
  if (S.pvp.survive && braceNow && !haveDef && ironclad && !prof.healer && (prof.bursty || !prof.C)) {
    S.pvp.note = 'brace(' + cls + ' nuke)'; return { id: ironclad.id, tk: enemy.key };
  }

  // 3) RAGE PIENA → Ragnarok (la barra è use-it-or-lose-it). Se non ho i 15 token NON sprecare il
  //    colpo: fall-through a Slash (i token rigenerano, al prossimo ciclo nuko). Se il nuke non è
  //    ancora nel DB, provalo per impararlo.
  if (atFull) {
    const nuke = usable.find(k => k.requires_full_resource);
    // BERSERKER (zerk): Ragnarok SOLO sotto il 50% HP (lì net-heala col lifesteal). Sopra il 50%: NON
    // bruciarlo a vita alta (backlash 261k con poca cura) — Slasha, lascia ciclare la Rage e conserva i
    // token. ALTRE classi: il loro ultimate va a risorsa piena SUBITO (no hold). `lethal` (step 1) chiude
    // comunque la partita a qualunque HP.
    if (nuke && (!zerk || lowHp)) { S.pvp.note = nuke.name + '@full' + (zerk ? ' (lowHP heal)' : ''); return { id: nuke.id, tk: enemy.key }; }
    if (nuke && zerk && !lowHp && slash) { S.pvp.note = 'hold Ragnarok (HP ' + Math.round(myHpPct * 100) + '% > 50)'; return { id: slash.id, tk: enemy.key }; }
    // l'ultimate ESISTE ma non ho i token (tokens < costo) → Slash per RICARICARE token, NON bruciare
    // la finestra su un mid-skill (la Rage si azzera comunque, al prossimo ciclo nuko coi token su).
    if (nukeSk && slash) { S.pvp.note = 'wait tokens (' + tokens + '/' + cost(nukeSk) + ')'; return { id: slash.id, tk: enemy.key }; }
    // NESSUN ultimate equipaggiato → il payoff a Rage piena è il miglior colpo affordable conosciuto.
    const best = usable.filter(k => dmgOf(k) != null).sort((a, b) => (dmgOf(b) || 0) - (dmgOf(a) || 0))[0];
    if (best) { S.pvp.note = best.name + '@full'; return { id: best.id, tk: enemy.key }; }
    if (slash) { S.pvp.note = 'build (slash)'; return { id: slash.id, tk: enemy.key }; }
  }

  // 4) ULTIMO COLPO PRIMA DEL PIENO (rage ≥ max-25) → War Aura (shred), così a 100 Ragnarok colpisce
  //    a difesa abbassata. MA solo se ho ≥ comboCost (21) token: War Aura ORA (6) + Ragnarok dopo (15).
  //    Se non ho abbastanza token → continua a Slashare (gratis) per rigenerarli. Vale anche vs healer.
  // Solo IN FINESTRA (HP ≤ 55%): se sopra il 50% si conservano i token e si Slasha — non si imposta
  // la combo a vita alta perché il Ragnarok dopo non andrebbe comunque (lo si terrebbe, vedi step 3).
  if (!atFull && zerk && comboWindow && rage >= max - 25 && warAuraSk && !shredUp && tokens >= comboCost) {
    S.pvp.note = 'war aura (combo setup)'; return { id: warAuraSk.id, tk: enemy.key };
  }

  // 4b) DIFESA SOTTO MINACCIA (solo conservazione token) — col Ragnarok equipaggiato (haveNuke) NON si
  //     fa più il "filler aggressivo" Power Slash: bruciava i token che servono alla combo. L'UNICA
  //     spesa di token concessa fuori-finestra è l'Ironclad DIFENSIVO quando il nemico sta per nukare e
  //     non ho difesa su (≈198k + GRANTS +41% def 2 turni): para il colpo e ti tiene vivo fino alla
  //     finestra <50% HP, e solo se restano i 21 token della combo. Altrimenti → Slash (conserva).
  //     FIX 2026-06-23 (export 110W/23L · strategia UANM): conserva token, sotto il 50% combo che net-heala.
  //     Vedi reference-berserker-pvp-strategy. SOLO Berserker (zerk): le ALTRE classi (e i build senza
  //     ultimate) usano il miglior colpo affordable come filler — niente conservazione token.
  if (zerk) {
    const threat = (enemyNukeReady || enemyResFull) && !haveDef && !prof.healer;
    if (threat && ironclad && tokens - cost(ironclad) >= comboCost) {
      S.pvp.note = 'def-filler ' + ironclad.name; return { id: ironclad.id, tk: enemy.key };
    }
    // niente minaccia → CONSERVA: cadi a Slash (step 5) per caricare Rage e rigenerare token.
  } else if (powerHit && (dmgOf(powerHit) || 0) > (dmgOf(slash) || 0)) {
    S.pvp.note = 'filler ' + powerHit.name; return { id: powerHit.id, tk: enemy.key };
  }

  // 5) BUILD — Slash (gratis): ora solo FALLBACK, quando non posso permettermi un filler vero senza
  //    intaccare i 15 token riservati al Ragnarok. Carica Rage verso 100 e rigenera i token per la combo.
  if (slash && zerk) { S.pvp.note = 'build (slash→combo)'; return { id: slash.id, tk: enemy.key }; }

  // 6) FALLBACK (nessun nuke conosciuto/equipaggiato) → miglior colpo affordable, o Slash.
  const top = usable.filter(k => !k.requires_full_resource).sort((a, b) => (dmgOf(b) || 0) - (dmgOf(a) || 0))[0];
  if (top && (dmgOf(top) || 0) > 0) { S.pvp.note = 'best ' + top.name; return { id: top.id, tk: enemy.key }; }
  S.pvp.note = 'build (slash)';
  return { id: (slash || skills[skills.length - 1]).id, tk: enemy.key };
}

function pvpEndMatch(state) {
  const enemyU = Object.values(state.teams?.enemy?.players_by_num || {})[0];
  const cls = enemyU?.advanced_class_name || 'Unknown';
  const win = state.match?.winner_side === 'ally';
  // DIAGNOSI: perché ho vinto/perso, dalle statistiche del match (mydmg vs danno subito vs cure).
  const st = (_pvpMatchStats.mid === S.pvp.cur) ? _pvpMatchStats : { myDmg: 0, enemyDmg: 0, enemyHeal: 0, enemyBig: 0, myTokens: 0, enemyTokens: 0 };
  let reason;
  if (win) reason = 'won';
  else if (st.enemyHeal > st.myDmg * 0.45) reason = 'out-healed';      // si è curato troppo
  else if (st.enemyBig > st.myDmg * 0.5)   reason = 'their nuke';      // un colpo enorme
  else if (st.enemyDmg > st.myDmg)         reason = 'out-damaged';     // più DPS di me
  else reason = 'close';
  S.pvp.matches.push({ mid: S.pvp.cur, enemyClass: cls, winner: state.match?.winner_side, reason,
    myDmg: st.myDmg, enemyDmg: st.enemyDmg, enemyHeal: st.enemyHeal, myTokens: st.myTokens, enemyTokens: st.enemyTokens });
  if (S.pvp.matches.length > 200) S.pvp.matches.shift();
  if (win) S.pvp.wins++; else S.pvp.losses++;
  const C = S.pvp.db.classes[cls];
  if (C) {
    C.matches = (C.matches || 0) + 1;
    if (!win) { C.losses = (C.losses || 0) + 1; C.lastLoss = reason; C.lossReasons = C.lossReasons || {}; C.lossReasons[reason] = (C.lossReasons[reason] || 0) + 1; }
  }
  S.pvp.cur = null; _pvpUrlConsumed = true; save();
  const prof = pvpProfile(cls);
  log(`⚔ PvP ${win ? 'WIN' : 'LOSS'} vs ${cls}${prof.healer ? ' (healer)' : ''}${prof.bursty ? ' (nuker)' : ''} · ${reason} · myDmg ${fmtDmg(st.myDmg)} / theirHeal ${fmtDmg(st.enemyHeal)} / theirBig ${fmtDmg(st.enemyBig)} · 🎟 tokens me ${st.myTokens||0} / enemy ${st.enemyTokens||0} · ${S.pvp.wins}W/${S.pvp.losses}L`, win ? '#2f8' : '#f88');
}

// build a HUMAN-READABLE .txt report (per-class W/L + loss reasons + their big hit),
// with the raw JSON appended at the bottom for deep analysis. Used by the export button.
function pvpExportText() {
  const p = S.pvp, db = p.db || { classes: {}, my: {} };
  const tot = (p.wins || 0) + (p.losses || 0);
  const L = [];
  L.push('VEYRA PvP — export ' + new Date().toLocaleString());
  L.push('Record: ' + (p.wins || 0) + 'W / ' + (p.losses || 0) + 'L'
    + (tot ? '  (' + Math.round((p.wins || 0) / tot * 100) + '%)' : ''));
  L.push('');
  L.push('PER-CLASS (worst winrate first):');
  // media token spesi (miei/nemici) per classe, dai match registrati
  const tokAgg = {};
  for (const mm of (p.matches || [])) {
    if (mm.myTokens == null && mm.enemyTokens == null) continue;
    const a = tokAgg[mm.enemyClass] = tokAgg[mm.enemyClass] || { n: 0, my: 0, en: 0 };
    a.n++; a.my += (mm.myTokens || 0); a.en += (mm.enemyTokens || 0);
  }
  const rows = Object.values(db.classes || {}).map(C => {
    const m = C.matches || 0, l = C.losses || 0, w = m - l;
    return { C, m, l, w, wr: m ? Math.round(w / m * 100) : 0 };
  }).sort((a, b) => a.wr - b.wr || b.m - a.m);
  for (const r of rows) {
    const C = r.C;
    const big = C.bigHit ? (C.bigHit.skill + ' ' + (C.bigHit.dmg || 0).toLocaleString()) : '—';
    const lr  = C.lossReasons ? Object.entries(C.lossReasons).map(([k, v]) => k + '×' + v).join(', ') : '';
    const ta  = tokAgg[C.class];
    const tok = ta && ta.n ? '  · 🎟 avg me ' + Math.round(ta.my / ta.n) + ' / enemy ' + Math.round(ta.en / ta.n) : '';
    L.push('  ' + String(C.class || '?').padEnd(14)
      + (r.w + 'W/' + r.l + 'L').padEnd(8) + String(r.wr + '%').padStart(4)
      + '  · big hit: ' + big + tok + (lr ? '  · losses: ' + lr : ''));
  }
  L.push('');
  L.push('=== RAW DATA (JSON, for analysis) ===');
  L.push(JSON.stringify({ wins: p.wins, losses: p.losses, db, matches: p.matches }, null, 2));
  return L.join('\n');
}

async function pvpLoop() {
  while (running) {
    // anche da spento aggiorna i token ogni tanto, così il tab li mostra (throttle 60s)
    if (!S.pvp.enabled || paused) { await pvpRefreshTokens(); await sleep(2000); continue; }
    try {
      await pvpRefreshTokens();   // tieni il conteggio token fresco mentre gioca
      // riprendi un match già aperto dalla URL della battle page (una sola volta), poi matchmake
      if (!S.pvp.cur && !_pvpUrlConsumed) {
        const m = location.pathname.includes('pvp_battle.php') && new URL(location.href).searchParams.get('match_id');
        if (m) S.pvp.cur = m;
        _pvpUrlConsumed = true;
      }
      if (!S.pvp.cur) {
        const mm = await pvpPostJson('pvp_matchmake.php', { ladder: 'solo' });
        if (mm.status !== 'success') { S.pvp.note = mm.message || 'no tokens'; pvpTabRefresh(); await sleep(20000); continue; }
        if (mm.token_free_chance != null) S.pvp.freeChance = mm.token_free_chance;
        if (mm.token_free_proc) S.pvp.note = '🎟 FREE token (proc)!';
        S.pvp.cur = String(mm.match_id); S.pvp.tokensUsed++; pvpRefreshTokens(true); save(); await sleep(400); continue;
      }
      const s = await pvpState(S.pvp.cur);
      if (!s.match) { if (++_pvpStale > 3) { S.pvp.cur = null; _pvpStale = 0; } await sleep(700); continue; }
      _pvpStale = 0;
      const enemyU = Object.values(s.teams?.enemy?.players_by_num || {})[0];
      S.pvp.lastClass = enemyU?.advanced_class_name || '';
      pvpLearn(S.pvp.cur, s, s.new_logs);
      if (s.match.ended) { pvpEndMatch(s); pvpRefreshTokens(true); pvpTabRefresh(); continue; }
      // FAST mode: il turno nemico passa da lento a ~1s → match molto più rapidi (il bottone
      // "enemy 1s" della pagina). Default del match è 'normal' → lo forziamo a 'fast_enemy'.
      if (s.match.solo_control_mode && s.match.solo_control_mode !== 'fast_enemy') {
        await pvpPostJson('pvp_battle_action.php', { match_id: S.pvp.cur, since_log_id: s.last_log_id, action: 'set_solo_control_mode', control_mode: 'fast_enemy' });
        continue;   // rileggi lo stato aggiornato al prossimo giro
      }
      if (s.turn?.side === 'ally') {              // solo: l'unico alleato sono io → mio turno
        if (_pvpTurnMid !== S.pvp.cur) { _pvpTurnMid = S.pvp.cur; _pvpMyTurns = 0; }  // nuovo match → azzera
        const rageBefore = s.me?.advanced_resource || 0;
        const p = pvpPick(s, _pvpMyTurns); if (!p) { await sleep(500); continue; }
        S.pvp.lastPick = p.id + (S.pvp.note ? ' · ' + S.pvp.note : '');
        let d = await pvpAction(S.pvp.cur, s.last_log_id, p.id, p.tk);
        if (!d || d.ok === false) {               // race "Not your turn"/reject → rileggi e ripiega su Slash
          const s2 = await pvpState(S.pvp.cur);
          if (s2.turn?.side === 'ally') d = await pvpAction(S.pvp.cur, s2.last_log_id, '0', p.tk);
        }
        _pvpMyTurns++;                             // un mio turno consumato (per l'apertura Ironclad)
        if (d && d.new_logs) pvpLearn(S.pvp.cur, d, d.new_logs, rageBefore);
        if (d?.match?.ended) pvpEndMatch(d);
        await sleep(220);
      } else {
        await sleep(700);
      }
      if (Date.now() - _pvpLastSave > 10000) { save(); _pvpLastSave = Date.now(); }  // persisti il DB imparato (throttle)
    } catch (e) { S.pvp.note = 'err: ' + e.message; await sleep(600); }
    pvpTabRefresh();
  }
}

// ── PvP TAB (nel pannello principale ⚔ PvP) ──────────────────────────────────────
// legge i token PvP (e i gem) dalla lobby pvp.php — "Solo Tokens: N" + costo refill.
let _pvpTokTs = 0;
async function pvpRefreshTokens(force) {
  if (!force && Date.now() - _pvpTokTs < 60000) return;
  _pvpTokTs = Date.now();
  const html = await getHtml(`${BASE}/pvp.php`);
  if (!html) return;
  const tok = html.match(/Solo Tokens:\s*<\/strong>\s*<span>\s*([\d]+)/i)
           || html.match(/Tokens:\s*<\/strong>\s*<span>\s*([\d]+)/i);
  if (tok) S.pvp.tokensAvail = parseInt(tok[1]);
  const cost = html.match(/Refill Solo Tokens \(([\d,]+) Gems\)/i);
  if (cost) S.pvp.refillCost = parseInt(cost[1].replace(/,/g, ''));
  S.pvp.tokensCheckedAt = Date.now();
  save();
  if (activeTab === 'pvp') renderUI();
}
// refresh the PvP tab live if it's the open tab
function pvpTabRefresh() { if (activeTab === 'pvp') renderUI(); }

// the ⚔ PvP tab body — ON/OFF + all match stats + tokens
function renderPvp() {
  const p = S.pvp;
  const total = p.wins + p.losses;
  const wr = total ? Math.round(p.wins / total * 100) : 0;
  const tokAge = p.tokensCheckedAt ? fmt(Date.now() - p.tokensCheckedAt) + ' ago' : 'never';
  // i token si ricaricano +3 ogni ora (allo scoccare dell'ora) → countdown al prossimo refill
  const _now = new Date();
  const _toHourMs = ((59 - _now.getMinutes()) * 60 + (60 - _now.getSeconds())) * 1000;
  const nextRefill = fmt(_toHourMs);
  // per-class breakdown (matches + losses learned)
  const rows = Object.values(p.db.classes || {}).sort((a, b) => (b.matches || 0) - (a.matches || 0)).map(c => {
    const m = c.matches || 0, l = c.losses || 0, w = m - l;
    const prof = pvpProfile(c.class);
    const tag = (prof.healer ? '💚' : '') + (prof.bursty ? '💥' : '');
    const nSk = Object.keys(c.skills || {}).length, nEf = Object.keys(c.effects || {}).length;
    return `<div style="font-size:11px;padding:1px 0">
      <div style="display:flex;justify-content:space-between">
        <span style="color:#cda">${esc(c.class || '?')} ${tag}</span>
        <span style="color:#778">${w}/${l} · ${nSk}sk ${nEf}fx</span></div>
      ${c.lastLoss ? `<div style="color:#a88;font-size:10px;padding-left:8px">↳ last loss: ${esc(c.lastLoss)}</div>` : ''}</div>`;
  }).join('');
  const recent = (p.matches || []).slice(-6).reverse().map(m =>
    `<span title="${esc((m.enemyClass || '') + (m.reason ? ' · ' + m.reason : ''))}" style="color:${m.winner === 'ally' ? '#2f8' : '#f88'};cursor:help">${m.winner === 'ally' ? 'W' : 'L'}</span>`).join(' ');
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <button data-pvp-action="toggle" style="flex:1;border:none;border-radius:6px;padding:7px 0;cursor:pointer;
        font-size:13px;font-weight:bold;color:#fff;background:${p.enabled ? '#1f8a4c' : '#7a2540'}">
        ${p.enabled ? '⏸ AutoPvP ON — tap to STOP' : '▶ AutoPvP OFF — tap to START'}</button>
    </div>
    <div style="color:${p.enabled ? '#7df' : '#888'};font-size:11px;margin-bottom:7px">
      ${p.enabled ? '▶ auto-playing (matchmake + max damage)' : '⏸ manual — play by hand'}
      ${p.note ? `· <span style="color:#fa8">${esc(p.note)}</span>` : ''}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;margin-bottom:6px">
      <div>🎟 tokens left: <b style="color:${(p.tokensAvail|0) > 0 ? '#0cf' : '#f66'}">${p.tokensAvail != null ? p.tokensAvail : '?'}</b></div>
      <div>⏳ +3 in <b>${nextRefill}</b></div>
      <div title="chance that a match does NOT consume a token">🍀 free token: <b>${p.freeChance != null ? Math.round(p.freeChance * 100) + '%' : '?'}</b></div>
      <div style="color:#667;font-size:10px">read ${tokAge}</div>
    </div>
    <div style="color:#667;font-size:10px;margin:-2px 0 8px">+3 tokens recharge every hour (top of the hour). 🍀 free token = chance a match doesn't spend a token. The bot NEVER refills with gems (manual ${(p.refillCost||500).toLocaleString()}-gem button only) — it idles when out of tokens.</div>

    <div style="border-top:1px solid #2a2a44;margin:6px 0;padding-top:6px"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;margin-bottom:6px">
      <div>✅ wins: <b style="color:#2f8">${p.wins}</b></div>
      <div>❌ losses: <b style="color:#f88">${p.losses}</b></div>
      <div>🏆 winrate: <b>${wr}%</b></div>
      <div>🎟 spent (session): <b>${p.tokensUsed}</b></div>
    </div>
    <div style="font-size:11px;color:#9ab;margin-bottom:6px">recent: ${recent || '—'}</div>
    <div style="font-size:11px;margin-bottom:3px">🆚 now: <b>${esc(p.lastClass || '—')}</b> · 🎯 <b>${esc(p.lastPick || '—')}</b></div>

    <div style="border-top:1px solid #2a2a44;margin:6px 0;padding-top:6px"></div>
    <div style="color:#9c6;font-size:12px;font-weight:bold;margin-bottom:3px">📚 Classes learned (${Object.keys(p.db.classes||{}).length})
      <span style="color:#667;font-weight:normal;font-size:10px">· 💚 healer 💥 nuker · W/L · skills · effects</span></div>
    ${rows || '<div style="color:#667;font-size:11px">none yet — start it or play a match</div>'}

    <div style="display:flex;gap:6px;margin-top:9px">
      <button data-pvp-action="tokens" style="flex:1;background:#252540;color:#ccc;border:none;border-radius:4px;padding:4px 6px;cursor:pointer;font-size:10px">🔄 refresh tokens</button>
      <button data-pvp-action="export" style="flex:1;background:#252540;color:#ccc;border:none;border-radius:4px;padding:4px 6px;cursor:pointer;font-size:10px">⬇ export DB</button>
    </div>
    <label style="display:flex;align-items:center;gap:6px;margin-top:7px;font-size:11px;color:#9ab;cursor:pointer">
      <input type="checkbox" data-pvp-action="survive" ${p.survive ? 'checked' : ''}> brace for enemy nuke: when the opponent's resource is full (e.g. Assassin's burst), use Ironclad (+DEF) first to soften the incoming hit
    </label>`;
}

async function mainLoop() {
  readStamFromDOM();
  let invLoaded = false;
  while (running) {
    // PAUSED = fully idle: no fetch, no cookie writes, nothing — so you can drink
    // potions / fight bosses / play MANUALLY without the bot interfering. The pause
    // state is persisted (S.paused), so a page reload (e.g. after a potion) stays
    // paused instead of silently resuming.
    if (paused) { status = '⏸ paused — manual play'; await sleep(600); renderUI(); continue; }
    // Farm e AutoPvP sono indipendenti (stamina vs token/Rage): girano in PARALLELO. L'unica
    // cosa condivisa è la banda di richieste — entrambi i loop gestiscono già il rate-limit
    // ("Slow down" → retry), quindi non serve mettere in pausa il farm durante il PvP.
    if (!invLoaded) { await refreshInv(); invLoaded = true; }
    _didWork = false;          // azzera: lo rialzano un colpo o un loot (vedi lootMob/fightTarget)
    let questPending = false;
    try {
      await refreshTimers();   // keep boss death/respawn countdowns fresh (throttled 15s)
      // Phase 0 — guild dungeon bosses (battle.php?dgmid) — single boss per source
      for (const src of (S.config || [])) {
        if (paused || !running) break;
        if (src.kind === 'dungeon'    && src.enabled !== false) await processDungeon(src);
        if (src.kind === 'dungeonloc' && src.enabled !== false) await processDungeonLocation(src);
      }
      // Phase 1 — timed bosses (priorità assoluta, usano stamina poi pozione)
      for (const wave of WAVES) {
        if (paused || !running) break;
        const timedTargets = wave.targets.filter(t => t.timer);
        if (timedTargets.length) await processWave(wave, timedTargets);
      }
      // Phase 1.5 — Adventurer's Guild quests (accept → farm to target → finish → next,
      // consecutively). While a quest is pending it OWNS the stamina (LSP refills it).
      if (!paused && running) questPending = await processQuests();
      // Phase 2 — general farm mobs (stamina rimanente, interrompibili dai timed).
      // SKIPPED while a quest is pending → "non sprecare stamina per le waves": the
      // stamina stays reserved for the quest, topped up with LSP, until it's turned in.
      _timedInterrupt = false;
      if (!questPending) for (const wave of WAVES) {
        if (paused || !running || _timedInterrupt) break;
        const farmTargets = wave.targets.filter(t => !t.timer);
        if (farmTargets.length) await processWave(wave, farmTargets, true);
      }
    } catch (e) {
      console.error('[FarmBot]', e);
      log(`error: ${e.message}`, '#f66');
      status = 'error — retry…';
    }
    renderUI();
    // Backoff: a stamina 0 non c'è nulla da fare finché non rigenera (i farm non
    // usano pozioni, i timed sono già al target). Dormi a lungo invece di rifare
    // il giro ~2 volte al secondo spammando il log. Il cache wave (30s) scade nel
    // frattempo, così al risveglio rilegge stamina/boss freschi.
    // ECCEZIONE 🏰: se è armato un "dungeon boss", NON dormire 60s anche a stamina 0 —
    // la stanza può aprirsi da un momento all'altro (la gilda finisce le lanes) e il boss
    // beve LSP appena lo vede. Resta sveglio a ~3s così lo aggancia all'istante (AFK-safe).
    const bossWatch = (S.config || []).some(s => s.enabled !== false &&
      (s.targets || []).some(t => t.enabled !== false && t.dungeonBoss));
    // IDLE = giro completo con stamina ma NIENTE fatto (nessun colpo, nessun loot): i target sono
    // tutti al cap o non ci sono mob vivi → inutile riscorrere le wave ogni 600ms (era lo spam
    // "fetch g5w11…" col pannello pieno di stamina). Mostra "in attesa" e dormi a lungo; al
    // risveglio (≤30s) rilegge respawn/stamina freschi e riparte appena c'è qualcosa.
    const idle = !_didWork && !questPending;
    let napMs;
    if (bossWatch)               napMs = DUNGEON_BOSS_POLL;
    else if (stam < SKILL_COST){ status = '⏳ waiting for stamina…';           renderUI(); napMs = 60_000; }
    else if (idle)             { status = '✓ nothing to farm now · waiting for respawn'; renderUI(); napMs = 30_000; }
    else                         napMs = 600;
    await sleep(napMs);
  }
}

// ── UI HELPERS ────────────────────────────────────────────────────────────────
function fmt(ms) {
  const s = Math.floor(Math.abs(ms) / 1000);
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${m%60}m` : `${m}m ${s%60}s`;
}

function fmtDmg(n) {
  if (n >= 1_000_000_000) return `${(n/1e9).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1_000)         return `${(n/1e3).toFixed(0)}K`;
  return String(n);
}

// Render a loot rewards object (shape varies per endpoint) into a short readable string,
// e.g. "gold 12K · exp 3.4K · Health Potion×2". Defensive: handles numbers, arrays of
// items ({name,qty} or plain strings) and nested objects without knowing the exact schema.
function fmtLoot(r) {
  if (r == null) return '';
  if (typeof r !== 'object') return String(r);
  const parts = [];
  for (const [k, v] of Object.entries(r)) {
    if (v == null || v === 0 || v === '' || v === false) continue;
    if (Array.isArray(v)) {
      for (const it of v) {
        if (it == null) continue;
        if (typeof it === 'object') {
          const nm = it.name || it.item || it.title || '?';
          const q  = it.qty || it.quantity || it.amount || it.count;
          parts.push(q ? `${nm}×${q}` : nm);
        } else parts.push(String(it));
      }
    } else if (typeof v === 'object') {
      const inner = fmtLoot(v); if (inner) parts.push(inner);
    } else if (typeof v === 'number') {
      parts.push(`${k} ${v >= 1000 ? fmtDmg(v) : v}`);
    } else {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.join(' · ');
}

// loot suffix for log lines: " → gold 12K · exp 3.4K · Health Potion×2" (empty if nothing)
function lootSfx(r) { const s = fmtLoot(r); return s ? ` → ${s}` : ''; }

function bar(n, max, w = 14) {
  const f = Math.min(Math.round(n / max * w), w);
  return '█'.repeat(f) + '░'.repeat(w - f);
}

// Trim a long monster name so it can't push the dmg/stamina off the status line.
function shortName(n, max = 20) { n = String(n || ''); return n.length > max ? n.slice(0, max) + '…' : n; }

// ── RENDER ────────────────────────────────────────────────────────────────────
let uiContent, uiPanel, minimized = S.minimized === true, activeTab = 'status';

function renderStatus() {
  const now    = Date.now();
  const sc     = paused ? '#fa0' : '#2f8';
  const st     = paused ? '⏸ PAUSED' : `▶ ${status}`;
  const totalK = Object.values(S.kills).reduce((a,b) => a+b, 0);

  // compact stat grid (2 columns) — più info, font leggermente più grande
  const stat = (ic, val, lbl, col = '#cfe') =>
    `<div style="display:flex;align-items:baseline;gap:5px">
       <span style="font-size:13px">${ic}</span>
       <b style="color:${col};font-size:13px">${val}</b>
       <span style="color:#667;font-size:11px">${lbl}</span>
     </div>`;
  const potStock = STAM_POTS.map(p => `${p.name} ${S.potInv?.[p.item]?.qty ?? '?'}`).join('/');
  const potNone  = !pickPotion();
  let h = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;margin-bottom:7px">
      ${stat('⚡', stam.toLocaleString(), 'stamina', stam > 0 ? '#0cf' : '#f66')}
      ${stat('⏱', fmt(now - S.started), 'uptime')}
      ${stat('💀', totalK.toLocaleString(), 'farm kills')}
      ${stat('👑', S.timedKills.toLocaleString(), 'boss kills', '#f90')}
      ${stat('🧪', potStock, 'stamina pots left' + (potNone ? ' ⚠' : ''), potNone ? '#f66' : '#cfe')}
      ${stat('🧴', S.lspUses.toLocaleString(), 'pots used')}
      ${stat('❤️', S.hpHeals.toLocaleString(), 'HP heals' + (hpEmpty ? ' (0!)' : ''), hpEmpty ? '#f66' : '#cfe')}
      ${(() => { const lph = lvlPerHour();
         return stat('📈', lph == null ? '—' : lph.toFixed(lph >= 10 ? 0 : 1),
                     'lvl/hr' + (userLevel != null ? ` · LV${userLevel.toLocaleString()}` : ''),
                     '#bda4ff'); })()}
    </div>
    <div style="color:${sc};font-size:12px;margin:2px 0 8px;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap">${paused ? '⏸ PAUSED' : '▶ '}${esc(status)}</div>
  `;

  // boss timers — iterate the bosses we actually target.
  // alive  → real auto-die countdown from data-expire (liveBoss).
  // dead   → respawn countdown from the auto-summon next-ts (S.timers, name match).
  const timedTargets = WAVES.flatMap(w => w.targets.filter(t => t.timer));
  if (timedTargets.length) {
    h += `<div style="color:#f90;font-size:11px;font-weight:bold;margin-bottom:3px">⏰ Boss timers <span style="color:#666;font-weight:normal">· ${S.timedKills} done</span></div>`;
    for (const t of timedTargets) {
      const exp  = liveBoss[t.key];                                 // alive auto-die ts (s)
      const tm   = Object.entries(S.timers).find(([nm, v]) => v && t.match({ name: nm }));
      const done = S.timedBy[t.key] || 0;
      let info;
      if (exp) {
        info = `<span style="color:#2f8">✅ alive · dies in ${fmt(exp * 1000 - now)}</span>`;
      } else if (tm && tm[1].nextTs) {
        const left = tm[1].nextTs * 1000 - now;
        info = left > 0
          ? `<span style="color:#ff6">⟳ respawn in ${fmt(left)}</span>`
          : `<span style="color:#2f8">✅ ready!</span>`;
      } else {
        info = `<span style="color:#777">… waiting for data</span>`;
      }
      const short = t.label.length > 22 ? t.label.slice(0,22)+'…' : t.label;
      // compact single row (name left · status right) — smaller text for mobile
      h += `<div style="font-size:10px;line-height:1.35;margin-bottom:2px;display:flex;justify-content:space-between;gap:6px">
        <span style="color:#fab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${short}${done ? ` <span style="color:#2f8">×${done}</span>` : ''}</span>
        <span style="flex-shrink:0">${info}</span></div>`;
    }
    h += `<div style="border-top:1px solid #2a2a44;margin:7px 0"></div>`;
  }

  // adventurer's guild quests — active quest + accepted/done counters
  if (S.questEnabled) {
    const q = S.questActive;
    h += `<div style="color:#9c6;font-size:12px;font-weight:bold;margin-bottom:5px">📜 Quests
      <span style="color:#666;font-weight:normal">· ${S.questDone} done · ${S.questTaken} taken</span></div>`;
    if (q) {
      const short = (q.title || '').length > 26 ? q.title.slice(0,26)+'…' : (q.title || 'quest');
      h += `<div style="font-size:12px;margin-bottom:4px;color:#cfa">
        ${esc(short)}<br>&nbsp;&nbsp;→ <span style="color:#7df">${esc(q.monster || 'g5w9 mobs')}</span>
        <span style="color:#9c6"> ${q.have ?? 0}/${q.need ?? 10}</span>
        <span style="color:#778;font-size:10px"> · engaged ${q.engaged ?? 0}</span></div>`;
    } else {
      h += `<div style="font-size:12px;margin-bottom:4px;color:#777">… all on cooldown (2-day rotation)</div>`;
    }
    h += `<div style="border-top:1px solid #2a2a44;margin:7px 0"></div>`;
  }

  // farm progress — limit per mob comes from its matching farm target (no hardcode)
  const limitForName = (name) => {
    for (const w of WAVES) for (const t of w.targets)
      if (t.killLimit != null && t.match({ name })) return t.killLimit;
    return null;
  };
  // only NORMAL farm mobs here — timed bosses live in the ⏰ Boss timers block above.
  // Union killed mobs with farm mobs we've SEEN (farmSeen) so the tab shows what we
  // farm even at 0 kills, and updates live as new mob types appear.
  const farmNames = new Set([...Object.keys(S.kills), ...Object.keys(S.farmSeen || {})]);
  const killRows = [...farmNames]
    .filter(name => !isTimedName(name))
    .map(name => [name, S.kills[name] || 0])
    .sort((a, b) => b[1] - a[1]);
  if (killRows.length) {
    h += `<div style="color:#0af;font-size:12px;font-weight:bold;margin-bottom:5px;display:flex;align-items:center;gap:6px">
      <span style="flex:1">🎯 Farming</span>
      <button data-status-action="reset-farm" title="reset farmed monsters (kills + list)"
        style="background:#3a2a2a;color:#f99;border:none;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px">🗑</button>
    </div>`;
    for (const [name, k] of killRows) {
      const lim   = limitForName(name);
      const done  = lim != null && k >= lim;
      const color = done ? '#2f8' : (k > 0 ? '#fa0' : '#555');
      const short = name.length > 20 ? name.slice(0,20)+'…' : name;
      const prog  = lim != null
        ? `<span style="color:#333"> ${bar(Math.min(k,lim),lim,12)}</span><span style="color:${color}"> ${k}/${lim}${done?' ✓':''}</span>`
        : `<span style="color:${color}"> ×${k}</span>`;
      h += `<div style="font-size:12px;margin-bottom:4px">
        <span style="color:#7df">${short}</span>${prog}
      </div>`;
    }
  }

  return h;
}

function renderLog() {
  if (!logBuf.length) return `<div style="color:#444;font-size:11px">no log yet</div>`;
  return logBuf.slice().reverse().map(e =>
    `<div style="font-size:11px;margin-bottom:3px;line-height:1.5;word-break:break-word">
      <span style="color:#555">${e.ts}</span>
      <span style="color:${e.color}"> ${e.msg}</span>
    </div>`
  ).join('');
}

// ── SETTINGS TAB ──────────────────────────────────────────────────────────────
// "Scan questa pagina" reads the live DOM of whatever page you're on and lists
// its mobs; you tick the ones to hit, set danno + ⏰timed/🎯farm, ✕ to remove.
// Sources are grouped by page (any URL). The 2s auto-render skips this tab so
// typing/focus isn't lost; "💾" persists + rebuilds the runtime WAVES.
const _scan = {};   // source.id → [{name, count, boss}] from the last live scan
let _scanFlash = null;   // {msg, ok, ts} — transient confirmation banner shown in the Setup
                         // tab so a click on 🔍 Scan is always visibly acknowledged.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

const IN = 'background:#0c0c16;border:1px solid #2b2e49;border-radius:4px;color:#dfe6ff;font:11px monospace;padding:2px 4px';

// parse "3m" / "120k" / "50000000" → integer (null = invalid → keep old value)
function parseAmount(s) {
  s = String(s).trim().toLowerCase().replace(/[, _]/g, '');
  const m = s.match(/^([\d.]+)([kmbg]?)$/);   // b/g = miliardi (1e9)
  if (!m) return null;
  let n = parseFloat(m[1]); if (isNaN(n)) return null;
  if      (m[2] === 'k')                  n *= 1e3;
  else if (m[2] === 'm')                  n *= 1e6;
  else if (m[2] === 'b' || m[2] === 'g')  n *= 1e9;
  return Math.round(n);
}

// build a runtime target from a scanned mob name. srcName links the checklist row
// back to the target; include is the core token so it still matches if the boss's
// full title shifts. LSP + timer are derived (boss/timed → auto LSP, farm → none).
function mkTarget(name, boss) {
  const full = name.toLowerCase().trim();
  return {
    key: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: name, srcName: name,
    // boss → match on the FULL name so similarly-titled summon bosses don't collide
    // (e.g. "Hermes, Divine Herald of the Endless Road" must NOT also match
    // "Pan, Wild Herald of Hermes"). farm → short first-segment token.
    include: [boss ? full : full.split(',')[0].trim()], exclude: [],
    dmgTarget: boss ? 3_000_000_000 : 100_000_000,   // boss: 3B (edit in UI); farm: 100M/mob
    killLimit: boss ? null : 400,
    useLSP: 'asNeeded',   // v1.18.0: farm usa LSP come i boss (FSP mai)
    timer: !!boss, enabled: true,
  };
}

// which saved target (if any) a checklist row maps to (case-insensitive — the row
// name may be a mixed-case label while include tokens are lowercase)
function targetFor(w, name) {
  const ln = String(name).toLowerCase();
  return (w.targets || []).find(t => (t.srcName || '').toLowerCase() === ln)
      || (w.targets || []).find(t => (t.label || '').toLowerCase() === ln)   // exclude-only farm targets have empty include + no srcName → match by label
      || (w.targets || []).find(t => (t.include || []).some(tok => tok && ln.includes(String(tok).toLowerCase())));
}

// current page URL, normalised (no hash, no dead_page) — the key for a source
function currentPageUrl() {
  const u = new URL(location.href);
  u.hash = ''; u.searchParams.delete('dead_page');
  return u.toString();
}

// Add/refresh ONE guild-dungeon LOCATION (guild_dungeon_location.php) as a 'dungeonloc'
// source and fill its mob checklist (_scan[src.id]). Shared by the location-page scan and
// the INSTANCE-page scan (which iterates every location). When `liveDoc` is given (user is
// on the location page) it reads the live DOM; otherwise it fetches the page. Lists DEAD
// instances too, so you can add them while everything is on cooldown.
async function scanDungeonLocation(locUrl, liveDoc, label) {
  const lu  = new URL(locUrl, location.href);
  const url = lu.toString();
  let mons = liveDoc ? _collectDungeonMons(liveDoc) : [];
  if (!mons.length) {
    const html = await getHtml(url);
    if (html) mons = parseDungeonMons(html);
  }
  const instId = lu.searchParams.get('instance_id');
  const locId  = lu.searchParams.get('location_id');
  let src = S.config.find(w => w.kind === 'dungeonloc' && srcUrl(w) === url);
  if (!src) {
    src = {
      id: 'dl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      kind: 'dungeonloc', url, instance_id: instId, location_id: locId,
      label: label || pageLabel(url) || ('Location ' + (locId || '')),
      enabled: true, targets: [],
    };
    S.config.push(src);
  } else { src.url = url; src.instance_id = instId; src.location_id = locId; if (label) src.label = label; }

  const distinct = {};
  for (const m of mons) {
    const nm = m.name || '?';
    distinct[nm] = distinct[nm] || { total: 0, dead: 0 };
    distinct[nm].total++; if (m.dead) distinct[nm].dead++;
  }
  // boss:false → mkTarget builds a FARM-style target (no potions, kill counter); the user
  // can flip any to ⏰ Timed (potions) from the checklist if they want.
  const list = Object.entries(distinct)
    .map(([name, c]) => ({ name, count: c.total, boss: false }))
    .sort((a, b) => b.count - a.count);
  _scan[src.id] = list;
  return { src, list, mons };
}

// Scan the LIVE page the user is on (any URL: wave, event, gate, guild dungeon).
// Reads document directly → no fetch, no cookie race. Creates/refreshes the
// matching source in S.config and stores its mob checklist in _scan[source.id].
async function scanCurrentPage(btn) {
  // instant click feedback: mutate the live button + yield a paint frame BEFORE the
  // (mostly synchronous) DOM scan runs, so the press is always visible even when the
  // scan finishes in a few ms (user: "non capisco se clicca o meno").
  if (btn) {
    btn.textContent = '⏳ Scanning…';
    btn.style.background = '#3a5a9a';
    btn.disabled = true;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  const url = currentPageUrl();

  // ── GUILD DUNGEON boss page: battle.php?dgmid=…&instance_id=… ──
  // One boss per page (.battle-card.monster-card). Create a 'dungeon' source the
  // main loop fights via dungeon_join_battle/damage/dungeon_loot (id = dgmid+instance).
  const pu = new URL(location.href);
  const dgmid = pu.searchParams.get('dgmid');
  const instId = pu.searchParams.get('instance_id');
  if (dgmid && pu.pathname.includes('battle.php')) {
    const card = document.querySelector('.battle-card.monster-card, .monster-card');
    const bossName = (card?.querySelector('.card-title')?.textContent
                   || card?.dataset?.name || document.title || `Dungeon boss ${dgmid}`)
                   .replace(/[🧟👑⚔️🎁\s]+/g, ' ').trim() || `Dungeon boss ${dgmid}`;
    let src = S.config.find(w => w.kind === 'dungeon' && String(w.dgmid) === String(dgmid)
                              && String(w.instance_id) === String(instId));
    if (src) { src.url = url; src.label = bossName; }      // refresh (dgmid may be re-scanned)
    else {
      src = {
        id: 'd' + Date.now().toString(36), url, label: bossName, kind: 'dungeon',
        dgmid, instance_id: instId, enabled: true,
        targets: [{ key: 'boss', label: bossName, srcName: bossName, include: [], exclude: [],
                    dmgTarget: 100_000_000, killLimit: null, useLSP: 'asNeeded',
                    timer: false, enabled: true, dungeon: true }],
      };
      S.config.push(src);
    }
    save();
    log(`🏰 dungeon added: ${bossName} (dgmid ${dgmid}) — set the damage and press 💾`, '#9060ff');
    flashScan(`🏰 dungeon boss added: ${bossName} — set the damage & press 💾`);
    return;
  }

  // ── GUILD DUNGEON LOCATION page: guild_dungeon_location.php?instance_id=…&location_id=… ──
  // Many .mon instances (each its own dgmid). We farm by MONSTER NAME because instances
  // respawn with new dgmids, so the source stores the location URL + a name checklist and
  // the loop re-reads the page each pass. Lists DEAD instances too, so you can add them
  // while everything is dead / on cooldown (the user's exact case).
  if (pu.pathname.includes('guild_dungeon_location.php')) {
    const label = (document.title || 'Guild dungeon').replace(/\s*[—\-|·].*$/, '').trim() || pageLabel(url);
    const { src, list, mons } = await scanDungeonLocation(url, document, label);
    save();
    log(`🏰 location ${src.label}: ${list.length} monster types (${mons.length} instances${mons.length && mons.every(m=>m.dead) ? ', all dead now' : ''}) — tick them, set damage, press 💾`, '#9060ff');
    flashScan(`🏰 ${list.length} monster types found — tick them below`, list.length > 0);
    return;
  }

  // ── GUILD DUNGEON INSTANCE page: guild_dungeon_instance.php?id=… ──
  // The instance index lists its LOCATIONS (each → guild_dungeon_location.php). Scan ALL of
  // them in one go: fetch each, create a dungeonloc source with its mob checklist. Then the
  // user ticks the bosses/mobs to farm across the locations and sets the damage.
  if (pu.pathname.includes('guild_dungeon_instance.php')) {
    const seen = new Set();
    const locLinks = [...document.querySelectorAll('a[href]')]
      .map(a => ({ url: a.href, text: (a.textContent || '').replace(/\s+/g, ' ').trim() }))
      .filter(a => /guild_dungeon_location\.php/i.test(a.url) && !seen.has(a.url) && seen.add(a.url));
    if (!locLinks.length) {
      log('⚠ no locations found on this instance page — open a single location and scan that', '#f66');
      flashScan('⚠ no locations found here — open a single location and scan that', false);
      return;
    }
    let totalTypes = 0, totalMons = 0;
    for (const L of locLinks) {
      const label = L.text.replace(/\s*[—\-|·].*$/, '').trim() || pageLabel(L.url);
      const { list, mons } = await scanDungeonLocation(L.url, null, label);
      totalTypes += list.length; totalMons += mons.length;
    }
    save();
    log(`🏰 instance: ${locLinks.length} locations · ${totalTypes} monster types (${totalMons} instances) — tick the ones to farm, set damage, press 💾`, '#9060ff');
    flashScan(`🏰 ${locLinks.length} locations · ${totalTypes} monster types found`, totalTypes > 0);
    return;
  }

  // ── GUILD DUNGEON CUBE page: guild_dungeon_cube.php?instance_id=… ──
  // The "cube" dungeon is a node-based UI shell: its sections do NOT appear as plain links in
  // the DOM (Enter is resolved server-side). But every farmable section is a normal
  // guild_dungeon_location.php?instance_id=…&location_id=K page. So we PROBE location_id 1..40 for
  // this instance and keep the ones that actually contain monsters (PvE rooms + the boss room).
  // Invalid ids return a ~20-byte 4xx and PvP-only rooms have no .mon → both are skipped cheaply.
  if (pu.pathname.includes('guild_dungeon_cube.php')) {
    const instId = pu.searchParams.get('instance_id');
    if (!instId) { log('⚠ cube: missing instance_id in URL', '#f66'); flashScan('⚠ cube: missing instance_id in URL', false); return; }
    let found = 0, types = 0, mobs = 0;
    for (let loc = 1; loc <= 40; loc++) {
      const lurl = `${BASE}/guild_dungeon_location.php?instance_id=${instId}&location_id=${loc}`;
      const { src, list, mons } = await scanDungeonLocation(lurl, null, null);
      if (!mons.length) {                       // not a farmable section → drop the empty source
        const i = S.config.indexOf(src);
        if (i >= 0 && (!src.targets || !src.targets.length)) S.config.splice(i, 1);
        delete _scan[src.id];
        continue;
      }
      found++; types += list.length; mobs += mons.length;
    }
    save();
    log(found
      ? `🏰 cube ${instId}: ${found} farmable sections · ${types} monster types (${mobs} mobs) — tick them, set damage, press 💾`
      : `⚠ cube ${instId}: no farmable sections found (probed location_id 1–40)`, found ? '#9060ff' : '#f66');
    flashScan(found ? `🏰 cube: ${found} farmable sections · ${types} monster types` : '⚠ cube: no farmable sections found', !!found);
    return;
  }

  // Need the ALIVE view. If the live page already shows alive monster-cards
  // (user is in the alive view) read them directly; otherwise the page is in
  // the dead/unclaimed view (cookie=0) → fetch the alive view (cookie=1) so we
  // actually see the live mobs. (fetch carries the cookie set in this same tick,
  // so there's no race with the main loop.)
  let alive = Object.values(_collectMobs(document)).filter(m => !m.dead);
  let summonRoot = document;
  if (alive.length) {
    _collectAutoSummon(document);
  } else {
    const view = saveUserView();
    setCookieRaw('show_dead_bosses_only', 0);
    setHideDead(true);
    const html = await getHtml(url);
    restoreUserView(view);
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      _collectAutoSummon(doc);
      alive = Object.values(_collectMobs(doc)).filter(m => !m.dead);
      summonRoot = doc;
    }
  }

  const bossNames = Object.keys(S.timers);
  const distinct = {};
  for (const m of alive) distinct[m.name] = (distinct[m.name] || 0) + 1;
  const list = Object.entries(distinct).map(([name, count]) => ({
    name, count,
    boss: bossNames.some(bn => bn.split(',')[0] && name.includes(bn.split(',')[0]))
        || /general|king|titan|herald|hunter|emperor|lord|queen|god|eternal|hermes|divine|olymp/i.test(name),
  }));

  // Also surface AUTO-SUMMON boss cards (the timed bosses — Hermes, Pan, …). They are
  // NOT .monster-card, so _collectMobs never sees them, and a timed boss is usually
  // DEAD (in respawn) when you scan — so it would never be selectable. List them here
  // so you can flag them ⏰ Timed even while dead. count = 0 → shown as "×0" (respawning).
  for (const c of summonRoot.querySelectorAll('.auto-summon-card')) {
    const nm = (c.querySelector('.auto-summon-name')?.textContent || '')
                 .replace(/\s+/g, ' ').toLowerCase().trim();
    if (!nm || distinct[nm] || list.some(r => r.name === nm)) continue;  // already listed as an alive card
    list.push({ name: nm, count: c.dataset.alive === '1' ? 1 : 0, boss: true });
  }

  list.sort((a, b) => (b.boss - a.boss) || (b.count - a.count));

  let src = S.config.find(w => srcUrl(w) === url);
  if (!src && !list.length) {
    log('⚠ no alive mobs here. Waves sometimes only show bosses (trash not spawned yet). Guild dungeons use a different system (open the boss battle page and scan that).', '#f66');
    flashScan('⚠ no alive monsters found on this page', false);
    return;
  }
  if (!src) {
    src = { id: 's' + Date.now().toString(36), url, label: pageLabel(url), enabled: true, targets: [] };
    S.config.push(src);
  }
  _scan[src.id] = list;
  save();
  log(`⚙ scan ${src.label}: ${list.length} alive mobs`, '#9060ff');
  const bossN = list.filter(r => r.boss).length;
  flashScan(`✓ ${list.length} monsters found${bossN ? ` (${bossN} boss)` : ''} — tick the ones to add`, list.length > 0);
}

// Show a transient confirmation banner in the Setup tab after a scan, then clear it.
// Re-renders only while the Setup tab is open (so it doesn't fight the status loop).
function flashScan(msg, ok = true) {
  _scanFlash = { msg, ok, ts: Date.now() };
  if (activeTab === 'settings') renderSettings();
  setTimeout(() => {
    if (_scanFlash && Date.now() - _scanFlash.ts >= 3300) {
      _scanFlash = null;
      if (activeTab === 'settings') renderSettings();
    }
  }, 3500);
}

function renderSettings() {
  if (!uiContent) return;
  const curUrl = currentPageUrl();
  const sectionTitle = (txt) =>
    `<div style="color:#9cf;font-size:11px;font-weight:bold;text-transform:uppercase;
      letter-spacing:.5px;margin:10px 0 6px">${txt}</div>`;
  const toggleRow = (act, on, title, onTxt, offTxt) =>
    `<label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;
      font-size:11px;background:#10101c;border:1px solid ${on?'#2a4a35':'#3a3144'};border-radius:6px;padding:7px 8px">
      <input type="checkbox" data-act="${act}" ${on?'checked':''} style="transform:scale(1.2)">
      <span style="flex:1">
        <span style="color:#dfe6ff">${title}</span><br>
        <span style="color:#667;font-size:10px">${on?onTxt:offTxt}</span>
      </span>
      <span style="color:${on?'#2f8':'#777'};font-weight:bold;font-size:11px">${on?'ON':'OFF'}</span>
    </label>`;

  let h = sectionTitle('How the bot fights');
  h += toggleRow('lspenable', S.lspEnabled,
        '🧪 Stamina potions while farming',
        'Timed bosses AND farming use potions',
        'Only timed bosses use potions — farming runs on natural stamina');
  h += toggleRow('smallhits', S.smallHits,
        '⚔️ Hit style: small &amp; frequent',
        'Many small hits (10–50 stamina) — more free-hit procs',
        'Big exact hits — minimal overshoot on the damage target');
  h += toggleRow('questenable', S.questEnabled,
        '📜 Auto Adventurer&apos;s Guild quests',
        'Accept a quest → farm its mob on g5w9 (≥5m each) → turn in → next',
        'Quests off — never touch the Adventurer&apos;s Guild');
  h += toggleRow('debuglog', S.debug,
        '🐞 Debug log',
        'Verbose: every wave scan + per-target match line (for troubleshooting)',
        'Clean log — only real actions (attacks, loot, level-ups, potions, waiting)');

  // ── HP auto-heal slider ──────────────────────────────────────────────────────
  // 0 = OFF (never spend HP potions, wait for regen) · 5..90 = heal when HP ≤ that %.
  const hpv  = S.hpHealPct | 0;
  const hpOff = hpv <= 0;
  const hpDesc = hpOff
    ? 'OFF — never auto-heal; waits for natural HP regen (no potions spent)'
    : `Drinks an HP potion when your HP drops to ${hpv}% or below`;
  h += `
    <div style="background:#10101c;border:1px solid #3a3144;border-radius:6px;padding:8px;margin-bottom:6px">
      <div style="display:flex;align-items:center;gap:8px;font-size:11px">
        <span style="flex:1;color:#dfe6ff">❤️ Auto-heal HP threshold</span>
        <span id="vfb-hp-val" style="font-weight:bold;color:${hpOff?'#777':'#f88'}">${hpOff?'OFF':hpv+'%'}</span>
      </div>
      <input type="range" min="0" max="90" step="5" value="${hpv}" data-act="hphealpct"
        style="width:100%;margin:7px 0 3px;accent-color:#f44;cursor:pointer">
      <div id="vfb-hp-desc" style="color:#667;font-size:10px">${hpDesc}</div>
    </div>`;

  // ── Mana potions (mana-using classes only — Mage/Hunter/etc., NOT Berserker) ──
  // Checkbox enable (default OFF) + slider for how many mana potions to use.
  const mOn = !!S.manaEnabled, mN = S.manaPots | 0;
  h += `
    <div style="background:#10101c;border:1px solid ${mOn?'#2a3a5a':'#3a3144'};border-radius:6px;padding:8px;margin-bottom:6px">
      <label style="display:flex;align-items:center;gap:8px;font-size:11px;cursor:pointer">
        <input type="checkbox" data-act="manaenable" ${mOn?'checked':''} style="transform:scale(1.2)">
        <span style="flex:1;color:#dfe6ff">🔵 Mana potions <span style="color:#667;font-size:10px">(mana classes: Mage/Hunter — not Berserker)</span></span>
        <span style="color:${mOn?'#6cf':'#777'};font-weight:bold;font-size:11px">${mOn?'ON':'OFF'}</span>
      </label>
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;margin-top:7px;opacity:${mOn?'1':'.45'}">
        <span style="flex:1;color:#dfe6ff">How many to use</span>
        <span id="vfb-mana-val" style="font-weight:bold;color:#6cf">${mN}</span>
      </div>
      <input type="range" min="0" max="4000" step="50" value="${mN}" data-act="manapots" ${mOn?'':'disabled'}
        style="width:100%;margin:7px 0 3px;accent-color:#39f;cursor:pointer;opacity:${mOn?'1':'.45'}">
      <div style="color:#667;font-size:10px">${mOn?`Drinks up to ${mN} mana potion(s) when MP runs low (L item 163, then S 162). Wiring activates with adaptive class detection.`:'OFF — never spends mana potions'}</div>
    </div>`;

  h += sectionTitle('Targets — what to attack');
  h += `
    <div style="display:flex;gap:6px;margin-bottom:6px;position:sticky;top:-8px;
      background:#0d0d18;padding:4px 0;z-index:2">
      <button data-action="scanpage" style="flex:1;background:#2a3a6a;color:#cfe;border:none;
        border-radius:5px;padding:7px;cursor:pointer;font:bold 11px monospace">🔍 Scan this page</button>
      <button data-action="save" title="Save &amp; apply" style="background:#2f8050;color:#fff;border:none;
        border-radius:5px;padding:7px 10px;cursor:pointer;font:bold 11px monospace">💾 Save</button>
      <button data-action="reset" title="Restore defaults" style="background:#3a2a2a;color:#f99;border:none;
        border-radius:5px;padding:7px 9px;cursor:pointer;font:12px monospace">↺</button>
    </div>
    <div style="color:#667;font-size:10px;margin-bottom:8px;line-height:1.5">
      You're on: <span style="color:#9cf">${esc(pageLabel(curUrl))}</span><br>
      Open a wave / boss / guild-dungeon page → <b style="color:#9cf">Scan this page</b> → the
      monsters appear under <b style="color:#9cf">Scan results</b>; tick one to add it to
      <b style="color:#7f8">Set targets</b> above, set its damage &amp; type. ✕ removes it.
    </div>`;

  // transient scan confirmation banner (set by flashScan after a 🔍 Scan)
  if (_scanFlash && Date.now() - _scanFlash.ts < 3400) {
    h += `<div style="background:${_scanFlash.ok ? '#143226' : '#3a2416'};
      color:${_scanFlash.ok ? '#7ff0a8' : '#ffb877'};border-radius:6px;
      padding:7px 9px;margin-bottom:8px;font-size:11px;font-weight:bold">${esc(_scanFlash.msg)}</div>`;
  }

  // ── Editable row for one target/monster. Works both for a CONFIGURED target (on →
  // shows the dmg + mode + kill controls) and a freshly-SCANNED, not-yet-added mob
  // (off → just the add checkbox + name). srcLabel shows the page when a group spans
  // more than one page. wi is the S.config index; name/handlers are unchanged.
  const targetRow = (wi, w, name, boss, count, srcLabel) => {
    const t   = targetFor(w, name);
    const on  = !!t;
    const grp = `mode_${wi}_${String(name).replace(/\W+/g, '_')}`;
    let s = `<div style="border:1px solid ${on?'#2f5040':'#23253f'};border-radius:6px;padding:5px 6px;margin-bottom:5px;background:#0e0e18">
      <div style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-act="row" data-wi="${wi}" data-name="${esc(name)}" ${on?'checked':''}>
        <span style="flex:1;color:${boss?'#fab':'#7df'};font-size:12px">${boss?'👑 ':''}${esc(name)}${count!=null?` <span style="color:#556">×${count}</span>`:''}${srcLabel?`<br><span style="color:#556;font-size:9px">📄 ${esc(srcLabel)}</span>`:''}</span>
        ${on?`<button data-action="deltarget" data-wi="${wi}" data-name="${esc(name)}" title="remove target" style="background:#3a2a2a;color:#f88;border:none;border-radius:4px;padding:1px 7px;cursor:pointer;font:12px monospace">✕</button>`:''}
      </div>`;
    if (on) {
      const mode = t.dungeonBoss ? 'dungeonboss' : (t.timer ? 'timed' : 'farm');
      const farm = mode === 'farm';
      const dgb  = mode === 'dungeonboss';
      s += `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:5px;padding-left:22px">
        <span style="color:#9cf;font-size:10px">${dgb ? 'max dmg' : 'stop at'}</span>
        <input style="${IN};width:70px" data-fld="dmg" data-wi="${wi}" data-name="${esc(name)}" value="${esc(fmtDmg(t.dmgTarget))}" title="${dgb ? 'GUILD CAP — the bot stops STRICTLY under this much damage (never crosses it)' : "stop attacking once you've dealt this much damage"}">
        <label style="color:#fab;font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer" title="Timed boss: fight to the damage target, then move on (may use potions)">
          <input type="radio" name="${grp}" data-act="mode" data-wi="${wi}" data-name="${esc(name)}" value="timed" ${mode==='timed'?'checked':''}> ⏰ Timed
        </label>
        <label style="color:#c9a0ff;font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer" title="Dungeon boss: auto-detects the room opening (polls ~3s, AFK), drinks a potion the instant the boss appears, and stops STRICTLY UNDER the damage cap above — never overshoots the guild limit">
          <input type="radio" name="${grp}" data-act="mode" data-wi="${wi}" data-name="${esc(name)}" value="dungeonboss" ${dgb?'checked':''}> 🏰 Dungeon Boss
        </label>
        <label style="color:#7df;font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer" title="Farm: kill regular monsters (no potions)">
          <input type="radio" name="${grp}" data-act="mode" data-wi="${wi}" data-name="${esc(name)}" value="farm" ${farm?'checked':''}> 🎯 Farm</label>`;
      if (farm) s += `<input style="${IN};width:46px" data-fld="killLimit" data-wi="${wi}" data-name="${esc(name)}" value="${esc(t.killLimit ?? 400)}" title="how many monsters to kill"><span style="color:#556;font-size:10px">kills</span>`;
      if (dgb)  s += `<div style="flex-basis:100%;color:#8a7fb8;font-size:9px;margin-top:2px;line-height:1.4">🏰 attacks on its own the instant the room opens (~3s, AFK) and stops <b>below</b> ${esc(fmtDmg(t.dmgTarget))} — never over the guild limit</div>`;
      // "match name ⊇" — only attack monsters whose name CONTAINS one of these words.
      // For a multi-phase boss (Hermes: phase1 "Divine Herald", phase2 "Fleet Duelist",
      // phase3 "Ascended Herald") type the phase-only word — e.g. "ascended" — so the bot
      // engages ONLY that phase's card. Comma-separated; empty = match the scanned name.
      s += `<div style="flex-basis:100%;display:flex;align-items:center;gap:5px;margin-top:4px">
        <span style="color:#9cf;font-size:10px;white-space:nowrap" title="Attack only monsters whose name contains one of these words (comma-separated). Use a phase-only word like 'ascended' to hit just Hermes phase 3.">match name ⊇</span>
        <input style="${IN};flex:1;min-width:90px" data-fld="match" data-wi="${wi}" data-name="${esc(name)}" value="${esc((t.include||[]).join(', '))}" placeholder="(any name — careful!)" title="e.g. 'ascended' = only Hermes phase 3. Empty matches EVERY monster on the page.">
        ${(t.exclude&&t.exclude.length)?`<span style="color:#a88;font-size:9px;white-space:nowrap" title="never these">≠ ${esc(t.exclude.join(', '))}</span>`:''}
      </div>`;
      s += `</div>`;
    }
    s += `</div>`;
    return s;
  };

  // guild-dungeon (dgmid) source: a single boss with just a damage field
  const dungeonRow = (wi, w, srcLabel) => {
    const t = (w.targets || [])[0];
    return `<div style="border:1px solid #2f5040;border-radius:6px;padding:5px 6px;margin-bottom:5px;background:#0e0e18">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="flex:1;color:#c9a0ff;font-size:12px">🏰 ${esc((t&&t.label)||w.label)} <span style="color:#556;font-size:9px">dgmid ${esc(w.dgmid)}</span></span>
        <span style="color:#9cf;font-size:10px">stop at</span>
        <input style="${IN};width:74px" data-fld="dmg" data-wi="${wi}" data-name="${esc((t&&(t.srcName||t.label))||'')}" value="${esc(fmtDmg(t?t.dmgTarget:0))}">
        <button data-action="delwave" data-wi="${wi}" title="delete" style="background:#3a2a2a;color:#f88;border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font:11px monospace">🗑</button>
      </div>
      ${srcLabel?`<div style="color:#556;font-size:9px;margin-top:3px">📄 ${esc(srcLabel)}</div>`:''}</div>`;
  };

  // ── SET TARGETS — every configured target, grouped by type ──────────────────────
  const groups = { timed: [], dungeonboss: [], farm: [] };
  S.config.forEach((w, wi) => {
    if (w.kind === 'dungeon') { groups.dungeonboss.push({ dungeon: true, wi, w }); return; }
    for (const t of (w.targets || [])) {
      const mode = t.dungeonBoss ? 'dungeonboss' : (t.timer ? 'timed' : 'farm');
      groups[mode].push({ wi, w, name: t.srcName || t.label, boss: !!t.timer });
    }
  });
  const totalSet = groups.timed.length + groups.dungeonboss.length + groups.farm.length;

  h += `<div style="color:#9cf;font-size:11px;font-weight:bold;margin:6px 0 5px">📋 Set targets <span style="color:#556;font-weight:normal">· ${totalSet}</span></div>`;
  if (!totalSet) {
    h += `<div style="color:#556;font-size:11px;padding:2px 2px 6px">Nothing set yet — scan a page below and tick a monster to add it here.</div>`;
  } else {
    const groupBlock = (key, icon, title, col) => {
      const arr = groups[key];
      if (!arr.length) return '';
      const multiPage = new Set(arr.map(e => e.wi)).size > 1;
      let s = `<div style="color:${col};font-size:11px;font-weight:bold;margin:8px 0 4px">${icon} ${title} <span style="color:#556;font-weight:normal">· ${arr.length}</span></div>`;
      for (const e of arr) {
        const lbl = multiPage ? (e.w.label || pageLabel(srcUrl(e.w))) : '';
        s += e.dungeon ? dungeonRow(e.wi, e.w, lbl)
                       : targetRow(e.wi, e.w, e.name, e.boss, null, lbl);
      }
      return s;
    };
    h += groupBlock('timed',       '⏰', 'Timed bosses',   '#fab');
    h += groupBlock('dungeonboss', '🏰', 'Dungeon bosses', '#c9a0ff');
    h += groupBlock('farm',        '🎯', 'Farm',           '#7df');
  }

  // ── SCAN RESULTS — monsters found on the CURRENT page that aren't set yet ────────
  const curSrc = S.config.find(w => w.kind !== 'dungeon' && srcUrl(w) === curUrl);
  const curWi  = curSrc ? S.config.indexOf(curSrc) : -1;
  const scanList = curSrc ? (_scan[curSrc.id] || []) : [];
  const toAdd = curSrc ? scanList.filter(r => !targetFor(curSrc, r.name)) : [];

  h += `<div style="border-top:1px solid #2a2a44;margin:10px 0 6px"></div>`;
  h += `<div style="color:#9cf;font-size:11px;font-weight:bold;margin:4px 0 5px">🔍 Scan results <span style="color:#556;font-weight:normal">· ${esc(pageLabel(curUrl))}</span></div>`;
  if (!curSrc || !scanList.length) {
    h += `<div style="color:#556;font-size:11px;padding:2px">Press <b style="color:#9cf">🔍 Scan this page</b> to list this page's monsters here.</div>`;
  } else if (!toAdd.length) {
    h += `<div style="color:#556;font-size:11px;padding:2px">✓ every monster found here is already set above.</div>`;
  } else {
    for (const r of toAdd) h += targetRow(curWi, curSrc, r.name, r.boss, r.count, '');
  }

  // ── PAGES — enable / rename / delete each scanned source ─────────────────────────
  if (S.config.length) {
    h += `<div style="border-top:1px solid #2a2a44;margin:10px 0 6px"></div>`;
    h += `<div style="color:#9cf;font-size:11px;font-weight:bold;margin:4px 0 5px">📄 Pages <span style="color:#556;font-weight:normal">· ${S.config.length}</span></div>`;
    S.config.forEach((w, wi) => {
      const url = srcUrl(w), isCurrent = url === curUrl;
      const nt  = (w.targets || []).length;
      h += `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;background:#10101c;border:1px solid ${isCurrent?'#2f8050':'#23253f'};border-radius:6px;padding:5px 6px">
        <input type="checkbox" data-act="wave-enable" data-wi="${wi}" ${w.enabled!==false?'checked':''} title="page on/off">
        <input style="${IN};flex:1" data-fld="label" data-wi="${wi}" value="${esc(w.label || pageLabel(url))}">
        <span style="color:${isCurrent?'#2f8':'#556'};font-size:9px;white-space:nowrap">${isCurrent?'● here · ':''}${nt}t</span>
        <button data-action="delwave" data-wi="${wi}" title="delete page" style="background:#3a2a2a;color:#f88;border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font:11px monospace">🗑</button>
      </div>`;
    });
  }

  uiContent.innerHTML = h;
  wireSettings();
}

// Apply edits LIVE: debounced save + rebuild so a changed damage/kill target takes
// effect immediately (the runtime WAVES are rebuilt) WITHOUT having to reach the 💾
// Save button — which on a phone is often scrolled off-screen, so edits silently never
// applied ("continua a fare 50m nonostante abbia risettato i danni"). 💾 still works.
let _applyTimer = null;
function scheduleApply() {
  clearTimeout(_applyTimer);
  _applyTimer = setTimeout(() => { save(); rebuildWaves(); log('⚙ changes applied', '#778'); }, 700);
}

// Delegated handlers (assigned, not added, so no listener buildup per render).
function wireSettings() {
  const wave = wi => S.config[+wi];

  uiContent.oninput = e => {
    const el = e.target;
    // ❤️ HP auto-heal slider — update live (no full re-render, so the drag isn't lost)
    if (el.dataset.act === 'hphealpct') {
      const v = Math.max(0, Math.min(90, parseInt(el.value) || 0));
      S.hpHealPct = v; save();
      const off = v <= 0;
      const vEl = document.getElementById('vfb-hp-val');
      const dEl = document.getElementById('vfb-hp-desc');
      if (vEl) { vEl.textContent = off ? 'OFF' : v + '%'; vEl.style.color = off ? '#777' : '#f88'; }
      if (dEl) dEl.textContent = off
        ? 'OFF — never auto-heal; waits for natural HP regen (no potions spent)'
        : `Drinks an HP potion when your HP drops to ${v}% or below`;
      return;
    }
    // 🔵 mana potions count slider — update live
    if (el.dataset.act === 'manapots') {
      S.manaPots = Math.max(0, Math.min(4000, parseInt(el.value) || 0)); save();
      const vEl = document.getElementById('vfb-mana-val');
      if (vEl) vEl.textContent = S.manaPots;
      return;
    }
    const f = el.dataset.fld; if (!f) return;
    const w = wave(el.dataset.wi); if (!w) return;
    if (f === 'label') { w.label = el.value; scheduleApply(); return; }
    const t = targetFor(w, el.dataset.name); if (!t) return;
    if (f === 'dmg') {
      const n = parseAmount(el.value);
      if (n != null) t.dmgTarget = n;
    } else if (f === 'killLimit') {
      const raw = el.value.replace(/[^\d]/g, '');
      t.killLimit = raw === '' ? 1 : Math.max(1, parseInt(raw));
    } else if (f === 'match') {
      // edit the include tokens (name-contains filter). Comma-separated, lowercased.
      // e.g. "ascended" → attack only Hermes phase 3; empty → match every monster.
      t.include = el.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    scheduleApply();
  };

  uiContent.onchange = e => {
    const el = e.target, a = el.dataset.act; if (!a) return;
    if (a === 'smallhits')  { S.smallHits   = el.checked; save(); renderSettings(); return; }
    if (a === 'lspenable')  { S.lspEnabled  = el.checked; save(); renderSettings(); return; }
    if (a === 'questenable'){ S.questEnabled= el.checked; save(); renderSettings(); return; }
    if (a === 'debuglog')   { S.debug       = el.checked; save(); renderSettings(); return; }
    if (a === 'manaenable') { S.manaEnabled = el.checked; save(); renderSettings(); return; }
    const w = wave(el.dataset.wi); if (!w) return;
    const nm = el.dataset.name;
    if (a === 'wave-enable') {
      w.enabled = el.checked;
      scheduleApply();
    } else if (a === 'row') {
      if (el.checked) {
        if (!targetFor(w, nm)) {
          const boss = (_scan[w.id] || []).find(r => r.name === nm)?.boss;
          (w.targets = w.targets || []).push(mkTarget(nm, !!boss));
        }
      } else {
        const t = targetFor(w, nm);
        if (t) w.targets.splice(w.targets.indexOf(t), 1);
      }
      scheduleApply(); renderSettings();
    } else if (a === 'mode') {
      const t = targetFor(w, nm); if (!t) return;
      if (el.value === 'timed')             { t.timer = true;  t.dungeonBoss = false; t.killLimit = null;             t.useLSP = 'asNeeded'; }
      else if (el.value === 'dungeonboss')  { t.timer = false; t.dungeonBoss = true;  t.killLimit = null;             t.useLSP = 'asNeeded'; }
      else                                  { t.timer = false; t.dungeonBoss = false; t.killLimit = t.killLimit || 400; t.useLSP = 'asNeeded'; }
      scheduleApply(); renderSettings();
    }
  };

  uiContent.onclick = async e => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action, wi = +b.dataset.wi, nm = b.dataset.name;
    if (a === 'save') {
      save(); rebuildWaves();
      b.textContent = '✓ Saved'; setTimeout(() => { b.textContent = '💾 Save'; }, 1200);
      log('⚙ config saved & applied', '#9060ff');
    } else if (a === 'reset') {
      S.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      for (const w of S.config) { if (!w.url) w.url = srcUrl(w); if (!w.label) w.label = pageLabel(w.url); }
      for (const k of Object.keys(_scan)) delete _scan[k];
      save(); rebuildWaves(); renderSettings();
      log('⚙ config reset to defaults', '#9060ff');
    } else if (a === 'scanpage') {
      await scanCurrentPage(b);
    } else if (a === 'delwave') {
      const w = S.config[wi];
      if (w) delete _scan[w.id];
      S.config.splice(wi, 1);
      scheduleApply(); renderSettings();
    } else if (a === 'deltarget') {
      const w = S.config[wi], t = w && targetFor(w, nm);
      if (t) w.targets.splice(w.targets.indexOf(t), 1);
      scheduleApply(); renderSettings();
    }
  };
}

function renderUI() {
  if (!uiContent || minimized) return;
  if (activeTab === 'settings') return;   // Settings owns its DOM (live inputs) — don't clobber
  uiContent.innerHTML = activeTab === 'pvp' ? renderPvp()
                      : activeTab === 'log' ? renderLog()
                      : renderStatus();
}

// Reset ONLY the top counters (uptime, boss kills, heals, potions used, attacks,
// quest tallies). The per-mob farm progress — S.kills and the 🎯 Farming bars — is
// deliberately kept (user: "le statistiche superiori, non quelle dei mob farmati").
function resetStats() {
  S.started   = Date.now();
  S.timedKills = 0; S.timedBy = {};
  S.hpHeals    = 0; S.lspUses = 0; S.attacks = 0;
  S.questTaken = 0; S.questDone = 0;
  S.lvlBaseFrac = null; S.lvlBaseTs = null;   // re-baseline the lvl/hour average
  save();
  noteLevelProgress();   // immediately re-seed from the current reading if we have one
  log('🗑 statistiche superiori azzerate (mob farmati mantenuti)', '#9cf');
  renderUI();
}

// Reset ONLY the per-mob farm progress: the S.kills counters AND the farmSeen list
// that drives the 🎯 Farming tab. Separate from resetStats (top counters) so the user
// can wipe the farmed-monster tallies independently (user: "reset anche per i mostri
// farmati, icona cestino"). Single click, like the top 🗑.
function resetFarm() {
  S.kills = {};
  S.farmSeen = {};
  save();
  log('🗑 mob farmati azzerati', '#9cf');
  renderUI();
}

// ── BUILD PANEL ───────────────────────────────────────────────────────────────
function buildUI() {
  // one-off stylesheet: animated rainbow "UANM" branding (header + minimized dock)
  if (!document.getElementById('vfb-style')) {
    const st = document.createElement('style');
    st.id = 'vfb-style';
    st.textContent = `
      @keyframes vfbRainbow { to { background-position: 200% center; } }
      .vfb-rainbow {
        font-weight: 900; letter-spacing: .5px;
        background: linear-gradient(90deg,#ff004c,#ff8a00,#ffe600,#37e36b,#22b8ff,#a64bff,#ff004c);
        background-size: 200% auto;
        -webkit-background-clip: text; background-clip: text;
        -webkit-text-fill-color: transparent; color: transparent;
        animation: vfbRainbow 3s linear infinite;
      }`;
    document.head.appendChild(st);
  }

  uiPanel = document.createElement('div');
  Object.assign(uiPanel.style, {
    position: 'fixed', bottom: '8px', right: '8px',
    // responsive width so the panel never overflows a phone screen (was a fixed 330px
    // that ran off the right edge on mobile, hiding the Save button + farm counter)
    width: 'min(330px, calc(100vw - 16px))',
    maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box',
    background: '#0d0d18',
    border: '1px solid #3a3a5c', borderRadius: '10px',
    zIndex: '2147483647', fontFamily: 'monospace', fontSize: '12px',
    boxShadow: '0 4px 28px #0009',
  });

  const hdr = document.createElement('div');
  Object.assign(hdr.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '7px 10px', background: '#16162a',
    borderRadius: '10px 10px 0 0', cursor: 'grab',
  });
  hdr.innerHTML = `
    <span style="color:#9060ff;font-weight:bold;font-size:12px">⚔ Veyra Farm <span style="font-weight:normal;font-size:11px;color:#778">by </span><span class="vfb-rainbow" style="font-size:12px">UANM</span></span>
    <span style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
      <button id="vfb-tab-s" style="background:#9060ff;color:#fff;border:none;
        border-radius:4px;padding:2px 7px;cursor:pointer;font-size:10px">Status</button>
      <button id="vfb-tab-l" style="background:#252540;color:#aaa;border:none;
        border-radius:4px;padding:2px 7px;cursor:pointer;font-size:10px">📋 Log</button>
      <button id="vfb-tab-g" style="background:#252540;color:#aaa;border:none;
        border-radius:4px;padding:2px 7px;cursor:pointer;font-size:10px">⚙ Setup</button>
      <button id="vfb-tab-pvp" title="Auto-PvP: ON/OFF + match stats + tokens"
        style="background:#252540;color:#aaa;border:none;
        border-radius:4px;padding:2px 7px;cursor:pointer;font-size:10px">⚔PvP</button>
      <button id="vfb-r" title="reset stats (boss/heals/uptime — keeps farm kills)"
        style="background:#252540;color:#ccc;border:none;
        border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px">🗑</button>
      <button id="vfb-p" style="background:#252540;color:#ccc;border:none;
        border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px">⏸</button>
      <button id="vfb-m" style="background:#252540;color:#ccc;border:none;
        border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px">—</button>
    </span>
  `;

  uiContent = document.createElement('div');
  Object.assign(uiContent.style, {
    padding: '8px 10px',
    // cap the scroll area so the bottom of the content (the 🎯 Farming counter, and the
    // long Setup list) is never pushed past the screen / under the mobile browser bars —
    // it scrolls INSIDE the panel instead. (user: "non si vede la parte inferiore")
    maxHeight: 'min(72vh, 640px)',
    overflowY: 'auto', WebkitOverflowScrolling: 'touch', color: '#ccc',
  });

  uiPanel.append(hdr, uiContent);
  document.body.appendChild(uiPanel);

  // ── MINIMIZED DOCK ────────────────────────────────────────────────────────────
  // When collapsed, the whole panel is hidden and this compact pill docks at the
  // bottom of the screen (fixed, centered — easy to reach with a thumb on mobile,
  // no fiddly dragging). Tap the ⚔UANM logo to reopen the panel; tap the round
  // play/pause button to run or pause the bot without opening anything.
  const dockEl = document.createElement('div');
  Object.assign(dockEl.style, {
    position: 'fixed', bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
    left: '50%', transform: 'translateX(-50%)',
    display: 'none', alignItems: 'center', gap: '10px',
    background: '#0d0d18', border: '1px solid #3a3a5c', borderRadius: '26px',
    padding: '6px 8px 6px 14px', zIndex: '2147483647',
    boxShadow: '0 4px 22px #000b', fontFamily: 'monospace',
    cursor: 'grab', touchAction: 'none',   // draggable on PC + mobile (Pointer Events)
  });
  dockEl.innerHTML = `
    <span id="vfb-dock-logo" style="cursor:pointer;display:flex;align-items:center;gap:7px;user-select:none">
      <span style="color:#9060ff;font-weight:bold;font-size:15px">⚔</span>
      <span class="vfb-rainbow" style="font-size:14px">autouanm</span>
    </span>
    <button id="vfb-dock-pp" title="run / pause the bot"
      style="border:none;border-radius:50%;width:38px;height:38px;cursor:pointer;
      font-size:16px;line-height:38px;text-align:center;padding:0">▶</button>`;
  document.body.appendChild(dockEl);

  // Drag the minimized dock anywhere — PC (mouse) AND mobile (touch) via Pointer Events.
  // A small movement threshold distinguishes a DRAG (reposition) from a TAP (logo→expand,
  // ⏯→pause), so dragging never accidentally opens the panel or toggles the bot. The
  // position persists in S.dockPos. (user: "quando minimizzato devo poterlo spostare".)
  let dockDrag = null, dockMoved = false;
  const applyDockPos = (left, top) => {
    const w = dockEl.offsetWidth || 120, h = dockEl.offsetHeight || 50;
    left = Math.max(0, Math.min(window.innerWidth  - w, left));
    top  = Math.max(0, Math.min(window.innerHeight - h, top));
    Object.assign(dockEl.style, { left: left+'px', top: top+'px', right: 'auto', bottom: 'auto', transform: 'none' });
  };
  if (S.dockPos && S.dockPos.left != null) applyDockPos(S.dockPos.left, S.dockPos.top);
  dockEl.addEventListener('pointerdown', e => {
    const r = dockEl.getBoundingClientRect();
    // remember WHAT was pressed: pointer capture (below) steals the synthetic `click`
    // from the child elements, so we resolve the tap here in pointerup instead.
    dockDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, tgt: e.target };
    dockMoved = false;
    try { dockEl.setPointerCapture(e.pointerId); } catch {}
  });
  dockEl.addEventListener('pointermove', e => {
    if (!dockDrag) return;
    if (!dockMoved && Math.hypot(e.clientX - dockDrag.sx, e.clientY - dockDrag.sy) < 6) return;
    dockMoved = true;
    dockEl.style.cursor = 'grabbing';
    e.preventDefault();
    applyDockPos(e.clientX - dockDrag.dx, e.clientY - dockDrag.dy);
  });
  const endDockDrag = () => {
    if (!dockDrag) return;
    const tgt = dockDrag.tgt;
    dockDrag = null;
    dockEl.style.cursor = 'grab';
    if (dockMoved) {
      const r = dockEl.getBoundingClientRect();
      S.dockPos = { left: Math.round(r.left), top: Math.round(r.top) }; save();
    } else {
      // a TAP (no drag) → act on what was pressed: ⏯ toggles pause, anything else reopens
      if (tgt && tgt.closest && tgt.closest('#vfb-dock-pp')) setPaused(!paused);
      else setMinimized(false);
    }
  };
  dockEl.addEventListener('pointerup', endDockDrag);
  dockEl.addEventListener('pointercancel', endDockDrag);

  // Delegated click handler for buttons INSIDE the status tab. The status tab is
  // re-rendered every 2s via innerHTML, so a per-button onclick wouldn't survive —
  // delegate on the stable uiContent element instead. (The settings tab uses its own
  // uiContent.onclick from wireSettings; the two don't collide — this matches only
  // [data-status-action], that one only [data-action].)
  uiContent.addEventListener('click', e => {
    const b = e.target.closest('[data-status-action]');
    if (b) {
      e.stopPropagation();
      if (b.dataset.statusAction === 'reset-farm') resetFarm();
      return;
    }
    // ⚔ PvP tab actions
    const pb = e.target.closest('[data-pvp-action]');
    if (!pb) return;
    e.stopPropagation();
    const a = pb.dataset.pvpAction;
    if (a === 'toggle') {
      S.pvp.enabled = !S.pvp.enabled; S.pvp.note = S.pvp.enabled ? 'starting…' : 'off';
      if (S.pvp.enabled) _pvpUrlConsumed = false;    // ricomincia a leggere la URL del match
      save(); renderUI();
      log(`⚔ AutoPvP ${S.pvp.enabled ? 'ON' : 'OFF'}${S.pvp.enabled ? ' — farming pauses' : ''}`, '#ff5c8a');
    } else if (a === 'tokens') {
      pvpRefreshTokens(true);
    } else if (a === 'export') {
      try {
        const txt = pvpExportText();
        const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
        const a2 = document.createElement('a');
        a2.href = url; a2.download = 'veyra_pvp_' + new Date().toISOString().slice(0, 10) + '.txt';
        document.body.appendChild(a2); a2.click(); a2.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        try { navigator.clipboard.writeText(txt); } catch {}   // best-effort copy too
        log('⚔ PvP export → file downloaded: ' + a2.download, '#9cf');
      } catch (e) { log('⚔ export failed: ' + e.message, '#f88'); }
    } else if (a === 'survive') {
      S.pvp.survive = !!pb.checked; save();
    }
  });

  // restore saved position (left/top) if the panel was dragged before
  if (S.pos && S.pos.left != null) {
    const left = Math.max(0, Math.min(window.innerWidth  - 60, S.pos.left));
    const top  = Math.max(0, Math.min(window.innerHeight - 36, S.pos.top));
    Object.assign(uiPanel.style, { left: left+'px', top: top+'px', right: 'auto', bottom: 'auto' });
  }

  function setTab(t) {
    activeTab = t;
    const sel = (id, active) => {
      const b = document.getElementById(id);
      b.style.background = active ? '#9060ff' : '#252540';
      b.style.color      = active ? '#fff'    : '#aaa';
    };
    sel('vfb-tab-s', t === 'status');
    sel('vfb-tab-l', t === 'log');
    sel('vfb-tab-g', t === 'settings');
    sel('vfb-tab-pvp', t === 'pvp');
    if (t === 'settings') renderSettings();
    else renderUI();
    if (t === 'pvp') pvpRefreshTokens(true);   // mostra subito i token aggiornati
  }
  document.getElementById('vfb-tab-s').onclick = e => { e.stopPropagation(); setTab('status'); };
  document.getElementById('vfb-tab-l').onclick = e => { e.stopPropagation(); setTab('log'); };
  document.getElementById('vfb-tab-pvp').onclick = e => { e.stopPropagation(); setTab(activeTab === 'pvp' ? 'status' : 'pvp'); };
  // ⚙ toggles Settings open/closed (closing returns to Status)
  document.getElementById('vfb-tab-g').onclick = e => {
    e.stopPropagation();
    setTab(activeTab === 'settings' ? 'status' : 'settings');
  };

  // keep the dock's play/pause button in step with the live paused state
  function syncDock() {
    const b = document.getElementById('vfb-dock-pp');
    if (!b) return;
    b.textContent      = paused ? '▶' : '⏸';                 // show the ACTION on tap
    b.style.background  = paused ? '#16331f' : '#33290f';
    b.style.color       = paused ? '#39d97f' : '#ffb02e';
  }
  // single source of truth for pausing — header button + dock button both call this
  function setPaused(v) {
    paused = v; S.paused = paused; save();   // survive page navigation
    const hp = document.getElementById('vfb-p');
    if (hp) hp.textContent = paused ? '▶' : '⏸';
    syncDock();
    renderUI();
  }
  document.getElementById('vfb-p').onclick = e => { e.stopPropagation(); setPaused(!paused); };
  document.getElementById('vfb-p').textContent = paused ? '▶' : '⏸';   // reflect persisted state

  // collapse/expand: hide the whole panel and show the bottom dock instead (or back)
  function setMinimized(v) {
    minimized = v; S.minimized = minimized; save();   // stay collapsed across reloads
    uiPanel.style.display = minimized ? 'none' : 'block';
    dockEl.style.display  = minimized ? 'flex' : 'none';
    const mb = document.getElementById('vfb-m');
    if (mb) mb.textContent = '—';
    if (!minimized) renderUI();   // refresh content that went stale while docked
    syncDock();
  }
  // (dock logo + ⏯ taps are handled in endDockDrag's pointerup — pointer capture steals
  // the synthetic click from these children, so onclick handlers here would never fire.)

  // 🗑 reset the TOP counters — SINGLE click (user: "si dovrebbe clickare una sola
  // volta", the old two-click ✓? was confusing). Keeps S.kills (per-mob farm progress
  // + the 🎯 Farming bars) untouched, so an accidental click only wipes uptime/boss/
  // heal tallies, which is cheap.
  const rbtn = document.getElementById('vfb-r');
  rbtn.onclick = e => {
    e.stopPropagation();
    resetStats();
    rbtn.textContent = '✓'; rbtn.style.background = '#2f5040';
    setTimeout(() => { rbtn.textContent = '🗑'; rbtn.style.background = '#252540'; }, 900);
  };
  document.getElementById('vfb-m').onclick = e => { e.stopPropagation(); setMinimized(true); };
  // reflect the persisted collapsed state on load (so a refresh doesn't re-open it)
  uiContent.style.display = 'block';
  setMinimized(minimized);

  // drag the panel anywhere (mouse + touch via Pointer Events); position persists
  let drag = null;
  hdr.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;   // don't drag when clicking a button
    e.preventDefault();
    const r = uiPanel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { hdr.setPointerCapture(e.pointerId); } catch {}
    hdr.style.cursor = 'grabbing';
  });
  hdr.addEventListener('pointermove', e => {
    if (!drag) return;
    const left = Math.max(0, Math.min(window.innerWidth  - uiPanel.offsetWidth, e.clientX - drag.dx));
    const top  = Math.max(0, Math.min(window.innerHeight - 36,                  e.clientY - drag.dy));
    Object.assign(uiPanel.style, { left: left+'px', top: top+'px', right: 'auto', bottom: 'auto' });
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    hdr.style.cursor = 'grab';
    const r = uiPanel.getBoundingClientRect();
    S.pos = { left: Math.round(r.left), top: Math.round(r.top) };
    save();
  };
  hdr.addEventListener('pointerup', endDrag);
  hdr.addEventListener('pointercancel', endDrag);

  setInterval(renderUI, 2000);
}

// ── KEEP-AWAKE (mobile) ───────────────────────────────────────────────────────
// Mobile browsers FREEZE JS timers when the tab is backgrounded and SUSPEND the page
// entirely when the screen locks → the bot stalls (it resumes only when you wake/unlock).
// The Screen Wake Lock API keeps the screen ON while THIS tab is in the foreground, so
// just leaving the phone on with the page open keeps farming. It does NOT survive a
// MANUAL screen lock or switching apps — no browser allows real background execution, so
// for true 24/7 farming use the server bot instead. The lock auto-releases when the tab
// is hidden; we re-acquire it the moment the tab becomes visible again.
let _wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !_wakeLock) {
      _wakeLock = await navigator.wakeLock.request('screen');
      _wakeLock.addEventListener('release', () => { _wakeLock = null; });
      log('📱 wake-lock ON · schermo resta acceso finché la tab è aperta in primo piano', '#9cf');
    }
  } catch { /* unsupported / denied / not allowed (e.g. low battery) — ignore */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !_wakeLock) keepAwake();
});

// ── INIT ──────────────────────────────────────────────────────────────────────
function init() {
  purgeDomainCookies();   // remove the bad domain= duplicates older versions left
  buildUI();
  try { parseLevel(document.body.innerHTML); } catch {}   // seed LV/EXP from the live page header
  renderUI();
  keepAwake();            // mobile: keep the screen on while the tab is in the foreground
  log(`🔧 Veyra Farm v1.63.0 — ${paused ? '⏸ PAUSED (manual play — press ▶ to start farming)' : '▶ running'} · quests ${S.questEnabled?'ON':'OFF'} · auto-heal ${S.hpHealPct>0?`≤${S.hpHealPct}%`:'OFF'}`, '#9cf');
  dlog(`debug: exact 1/10/50 hits · LSP(251) only (FSP never touched) · view cookies hide_dead=${getCookieRaw('hide_dead_monsters')} bossOnly=${getCookieRaw('show_dead_bosses_only')} · console: copy(window.__farmLog())`, '#778');
  // DIAGNOSTIC: dump the LIVE runtime targets (what the loop actually uses) so a
  // stale/duplicate dmgTarget is visible. console: copy(window.__farmConfig())
  try {
    window.__farmConfig = () => JSON.stringify(WAVES.map(w => ({
      id: w.id, label: w.label,
      targets: (w.targets || []).map(t => ({ key: t.key, label: t.label, dmgTarget: t.dmgTarget, timer: t.timer, killLimit: t.killLimit, include: t.include, exclude: t.exclude })),
    })), null, 2);
  } catch {}
  for (const w of WAVES) {
    for (const t of (w.targets || [])) {
      log(`📋 ${w.id} · ${t.timer ? '⏰' : '🎯'} ${t.label} → stop@${fmtDmg(t.dmgTarget)}${t.killLimit != null ? ` ·${t.killLimit}k` : ''}${(t.include && t.include.length) ? ` inc[${t.include.join(',')}]` : ''}${(t.exclude && t.exclude.length) ? ` exc[${t.exclude.join(',')}]` : ''}`, '#cb8');
    }
  }
  // AUTO-PvP: tab ⚔ PvP nel pannello (su ogni pagina). Il loop gira sempre ma agisce solo
  // quando S.pvp.enabled è ON; allora il farm va in pausa (guardia in mainLoop). Da spento
  // aggiorna comunque il conteggio token per il tab.
  log(`⚔ AutoPvP ${S.pvp.enabled ? 'ON (auto)' : 'OFF (apri il tab ⚔ PvP)'} · classi imparate: ${Object.keys(S.pvp.db.classes || {}).length}`, '#ff5c8a');
  pvpRefreshTokens(true);
  pvpLoop().catch(e => console.error('[AutoPvP]', e));
  mainLoop().catch(e => console.error('[FarmBot]', e));
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', init)
  : init();

})();

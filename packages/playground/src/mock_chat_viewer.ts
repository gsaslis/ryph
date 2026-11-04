/**
 * The mock chat platforms' page: every channel on each platform, its conversations (Zulip topics,
 * Slack and Discord threads, Telegram's one group), most recently active first, and a box under
 * each to answer as a person. It reads `/state.json` every two seconds and posts to `/say`.
 */

export function renderViewer(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Playground chat</title>
<style>
  :root {
    --bg: #f6f6f4; --panel: #fff; --ink: #1d1d1b; --muted: #6d6d68; --line: #e3e2de;
    --bot: #eef3ff; --accent: #3b5bdb; --lock: #a35c00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161615; --panel: #1f1f1d; --ink: #ecebe6; --muted: #9a9993; --line: #33322f;
      --bot: #1d2640; --accent: #8ea6ff; --lock: #e3a24f;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { padding: 16px; border-bottom: 1px solid var(--line); display: flex; gap: 12px;
    align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  header p { margin: 0; color: var(--muted); }
  nav { display: flex; gap: 4px; padding: 8px 16px 0; }
  nav button { border: 1px solid var(--line); background: var(--panel); color: var(--ink);
    padding: 6px 12px; border-radius: 6px 6px 0 0; cursor: pointer; font: inherit; }
  nav button[aria-pressed="true"] { border-bottom-color: var(--panel); font-weight: 600; }
  main { padding: 16px; display: grid; gap: 16px; max-width: 1100px; }
  section.channel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 12px; }
  section.channel > h2 { font-size: 15px; margin: 0 0 8px; display: flex; gap: 8px;
    align-items: center; }
  .tag { font-size: 11px; font-weight: 500; padding: 1px 6px; border-radius: 99px;
    border: 1px solid var(--line); color: var(--muted); }
  .tag.private { color: var(--lock); border-color: currentColor; }
  .conv { border-top: 1px solid var(--line); padding: 10px 0 4px; }
  .conv h3 { font-size: 13px; margin: 0 0 6px; color: var(--muted); font-weight: 600; }
  .msg { padding: 6px 8px; border-radius: 6px; margin: 4px 0; white-space: pre-wrap;
    overflow-wrap: anywhere; }
  .msg.bot { background: var(--bot); }
  .msg .who { font-weight: 600; margin-right: 6px; }
  .msg .when { color: var(--muted); font-size: 12px; }
  .msg a { color: inherit; }
  .reacts { display: flex; gap: 4px; margin-top: 4px; white-space: normal; }
  .react { font-size: 12px; border: 1px solid var(--border, #444); border-radius: 999px; padding: 1px 8px; }
  .msg img { display: block; max-width: 320px; max-height: 240px; margin-top: 6px;
    border-radius: 4px; }
  form { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; align-items: center; }
  form input[type=text] { flex: 1 1 200px; min-width: 0; padding: 6px 8px; font: inherit;
    border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
  form input.topic { flex: 0 1 180px; }
  form select, form button { font: inherit; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
  form button { border-color: var(--accent); color: var(--accent); cursor: pointer; }
  form label { color: var(--muted); font-size: 12px; display: flex; gap: 4px; align-items: center; }
  .empty { color: var(--muted); font-style: italic; }
  .error { color: #c92a2a; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Playground chat</h1>
  <p>Mock Telegram, Zulip, Slack and Discord. What the bot posts shows up here; answer as a person below.</p>
</header>
<nav id="tabs"></nav>
<main id="main"><p class="empty">Loading…</p></main>
<script>
const KINDS = { telegram: "group", zulip: "topic", slack: "thread", discord: "thread" };
let state = null, last = "", tab = localStorageGet() || "zulip";
function localStorageGet() { try { return localStorage.getItem("tab"); } catch { return null; } }
function localStorageSet(v) { try { localStorage.setItem("tab", v); } catch {} }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function people() {
  return state.people.map((p) => '<option value="' + esc(p.key) + '">' + esc(p.name) + "</option>").join("");
}

function form(platform, channelId, conversation, newOne) {
  const topic = newOne && platform === "zulip" ? '<input class="topic" name="topic" type="text" placeholder="topic" required>' : "";
  const verb = newOne
    ? (platform === "slack" || platform === "discord" ? "Post in channel" : "New topic")
    : "Reply";
  return '<form data-platform="' + platform + '" data-channel="' + esc(channelId) + '" data-conversation="' + esc(conversation ?? "") + '">' +
    '<select name="as">' + people() + "</select>" + topic +
    '<input name="text" type="text" placeholder="Say something" required>' +
    '<label><input name="mention" type="checkbox" checked> mention the bot</label>' +
    "<button>" + verb + '</button><span class="error"></span></form>';
}

// The emoji a bot reacts with, by the name Zulip and Slack send; Telegram and Discord send the
// emoji itself.
const EMOJI = { eyes: "👀", white_check_mark: "✅", x: "❌", hourglass: "⏳", rocket: "🚀" };

// Just enough of each platform's markup to read like the real client: bold (Zulip's and Discord's
// ** and Slack's *) and links (Zulip's [text](url), Discord's [text](<url>), Slack's <url|text>).
// Escaped first, so nothing a message says becomes markup of its own.
function markup(text) {
  return esc(text)
    .replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/(^|\\s)\\*([^*\\n]+)\\*(?=\\s|$|[.,!?])/g, "$1<strong>$2</strong>")
    .replace(/\\[([^\\]\\n]+)\\]\\(&lt;(https?:[^&\\s]+)&gt;\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\\[([^\\]\\n]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/&lt;(https?:[^|\\s]+)\\|([^&\\n]+)&gt;/g, '<a href="$1" target="_blank" rel="noreferrer">$2</a>');
}

function message(m) {
  const imgs = m.files.map((f) => '<img src="/files/' + esc(f) + '" alt="">').join("");
  const react = m.reactions.length
    ? '<div class="reacts">' + m.reactions.map((r) => '<span class="react" title="' + esc(r) + '">' + esc(EMOJI[r] ?? r) + " 1</span>").join("") + "</div>"
    : "";
  return '<div class="msg' + (m.sender.bot ? " bot" : "") + '"><span class="who">' + esc(m.sender.name) +
    '</span><span class="when">' + time(m.at) + "</span>\\n" + markup(m.text) + imgs + react + "</div>";
}

function conversations(platform, channel) {
  const groups = new Map();
  for (const m of channel.messages) {
    const g = groups.get(m.conversation) ?? [];
    g.push(m);
    groups.set(m.conversation, g);
  }
  return [...groups.entries()].sort((a, b) => b[1].at(-1).at - a[1].at(-1).at);
}

function title(platform, key, messages) {
  if (platform === "zulip") return "Topic: " + key;
  if (platform === "slack") return "Thread: " + (messages[0].text.split("\\n")[0].slice(0, 80) || key);
  if (platform === "discord") {
    const name = state.discordThreads?.[key];
    return name ? "Thread: " + name : "Message: " + (messages[0].text.split("\\n")[0].slice(0, 80) || key);
  }
  return "Group";
}

function render() {
  document.getElementById("tabs").innerHTML = state.platforms.map((p) =>
    '<button data-tab="' + p.platform + '" aria-pressed="' + (p.platform === tab) + '">' + esc(p.name) + "</button>").join("");
  const p = state.platforms.find((x) => x.platform === tab) ?? state.platforms[0];
  document.getElementById("main").innerHTML = p.channels.map((c) => {
    const convs = conversations(p.platform, c);
    const body = convs.length === 0 && p.platform !== "telegram"
      ? '<p class="empty">Nothing here yet.</p>'
      : convs.map(([key, ms]) =>
        '<div class="conv"><h3>' + esc(title(p.platform, key, ms)) + " · " + ms.length + " messages</h3>" +
        ms.map(message).join("") + form(p.platform, c.id, key, false) + "</div>").join("");
    const fresh = p.platform === "telegram"
      ? (convs.length ? "" : '<p class="empty">Nothing here yet.</p>' + form("telegram", c.id, "", false))
      : form(p.platform, c.id, null, true);
    return '<section class="channel"><h2>' + (p.platform === "telegram" ? "" : "#") + esc(c.name) +
      ' <span class="tag' + (c.private ? " private" : "") + '">' + (c.private ? "private" : "public") + "</span></h2>" +
      body + '<div class="conv">' + fresh + "</div></section>";
  }).join("");
}

function busy() {
  const a = document.activeElement;
  if (a && a.closest && a.closest("form")) return true;
  return [...document.querySelectorAll("form input[type=text]")].some((i) => i.value !== "");
}

async function refresh(force) {
  try {
    const text = await (await fetch("/state.json")).text();
    if (!force && (text === last || busy())) return;
    last = text;
    state = JSON.parse(text);
    render();
  } catch {}
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]");
  if (!t) return;
  tab = t.dataset.tab;
  localStorageSet(tab);
  render();
});

document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const data = new FormData(f);
  const res = await fetch("/say", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: f.dataset.platform,
      channelId: f.dataset.channel,
      conversation: data.get("topic") ?? (f.dataset.conversation || null),
      as: data.get("as"),
      text: data.get("text"),
      mention: data.get("mention") === "on",
    }),
  });
  if (!res.ok) {
    f.querySelector(".error").textContent = (await res.json().catch(() => ({}))).error ?? "refused";
    return;
  }
  f.reset();
  document.activeElement?.blur();
  refresh(true);
});

refresh(true);
setInterval(() => refresh(false), 2000);
</script>
</body>
</html>
`;
}

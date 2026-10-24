// Audit FTC BIOBUZZ clues against the official FTC AI Assistant.
// Reads boards/ftc-biobuzz.txt. Does not modify that file or the game.
//
// The assistant is https://ftc-cmchatbot.firstinspires.org/
// This script calls the same backend that page uses.
// FIRST says the assistant can be wrong. A result here is a second look,
// not an official ruling.
//
// Usage:
//   node audit/verify.mjs
//   node audit/verify.mjs --run --threads 4
//   node audit/verify.mjs --run --limit 5
//   node audit/verify.mjs --run --category Scoring
//   node audit/verify.mjs --run --match "Q&A 21" --match "Team Update 05"
//   node audit/verify.mjs --correct --threads 8
//   node audit/verify.mjs --serve
//
// Saved replies are written to audit/out/ and are not part of the game.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_PATH = path.join(ROOT, "boards", "ftc-biobuzz.txt");
const OUT_DIR = path.join(ROOT, "audit", "out");
const RESULTS_PATH = path.join(OUT_DIR, "results.jsonl");
const META_PATH = path.join(OUT_DIR, "meta.json");
const REPORT_PATH = path.join(OUT_DIR, "report.html");

const CHAT_URL = "https://ftc-chatbot-api.pdx-prod.ftclive.org/api/v1/chat/";
const META_URL = "https://ftc-chatbot-api.pdx-prod.ftclive.org/api/v1/metadata/";
const CHAT_PAGE = "https://ftc-cmchatbot.firstinspires.org/";

const NUMBER_WORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
  sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60"
};

function parseArgs(argv) {
  const opts = {
    run: false,
    report: false,
    limit: Infinity,
    delayMs: 0,
    threads: 4,
    force: false,
    correct: false,
    serve: false,
    port: 4177,
    category: "",
    matches: []
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run") opts.run = true;
    else if (arg === "--report") opts.report = true;
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg === "--delay") opts.delayMs = Number(argv[++i]);
    else if (arg === "--threads") opts.threads = Number(argv[++i]);
    else if (arg === "--force") opts.force = true;
    else if (arg === "--correct") opts.correct = true;
    else if (arg === "--serve") opts.serve = true;
    else if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--category") opts.category = argv[++i] || "";
    else if (arg === "--match") opts.matches.push(argv[++i] || "");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.limit !== Infinity && (!Number.isFinite(opts.limit) || opts.limit < 1)) {
    throw new Error("--limit must be a positive number");
  }
  if (!Number.isFinite(opts.delayMs) || opts.delayMs < 0) {
    throw new Error("--delay must be a number of milliseconds");
  }
  if (!Number.isInteger(opts.threads) || opts.threads < 1 || opts.threads > 8) {
    throw new Error("--threads must be a whole number from 1 to 8");
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error("--port must be a network port");
  }
  return opts;
}

function rulesetId(meta) {
  const latest = meta?.latest;
  if (!latest) return "";
  return [
    `TU${latest.tu_number ?? "?"}`,
    `manual${latest.manual_version || "?"}`,
    latest.collection_name || "unknown"
  ].join("|");
}

function slotKey(ruleset, key) {
  return `${ruleset || ""}\t${key}`;
}

function extractBoard(text) {
  const marker = "const BOARD = `";
  const start = text.indexOf(marker);
  const end = text.lastIndexOf("`;");
  if (start < 0 || end < start) {
    throw new Error("Could not find the BOARD text in boards/ftc-biobuzz.txt");
  }
  const prefixLines = text.slice(0, start + marker.length).split(/\r?\n/).length;
  return {
    body: text.slice(start + marker.length, end),
    lineOffset: prefixLines - 1
  };
}

function parseClues(boardText, lineOffset) {
  const clues = [];
  let category = "";
  let lineNo = 0;
  for (const rawLine of boardText.split(/\r?\n/)) {
    lineNo++;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("TITLE:")) continue;
    if (line.startsWith("CATEGORY:")) {
      category = line.slice("CATEGORY:".length).trim();
      continue;
    }
    if (!line.includes(" | ")) continue;
    let parts = line.split(" | ").map((part) => part.trim());
    if (/^\d+$/.test(parts[0]) && parts.length >= 3) parts = parts.slice(1);
    let answer = "";
    let question = "";
    let citation = "";
    let link = "";
    if (parts.length >= 4 && /^https?:\/\//.test(parts[parts.length - 1])) {
      link = parts.pop();
      answer = parts.shift();
      question = parts.shift();
      citation = parts.join(" | ");
    } else {
      answer = parts[0] || "";
      question = parts[1] || "";
      citation = parts[2] || "";
      link = parts[3] || "";
    }
    const id = clues.length + 1;
    const fileLine = lineNo + lineOffset;
    const key = createHash("sha256")
      .update([category, answer, question, citation, link].join("\n"))
      .digest("hex")
      .slice(0, 16);
    clues.push({ id, line: fileLine, category, answer, question, citation, link, key });
  }
  return clues;
}

function foldNumbers(text) {
  return text.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\b/gi, (word) => NUMBER_WORDS[word.toLowerCase()]);
}

function norm(text) {
  return foldNumbers(String(text || ""))
    .toLowerCase()
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9:.\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function coreAnswer(question) {
  return String(question || "")
    .replace(/^(what|who|where|when)\s+(is|are|was|were)\s+/i, "")
    .replace(/\?+$/g, "")
    .replace(/^(a|an|the)\s+/i, "")
    .trim();
}

function escapeReg(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsCore(hay, core) {
  if (!core) return false;
  if (/^\d+(?:\.\d+)?$/.test(core)) {
    return new RegExp(`(?<![\\d.])${escapeReg(core)}(?![\\d.])`).test(hay);
  }
  if (core.length <= 4 || /^[\d:.]+$/.test(core)) {
    return new RegExp(`(?:^|\\s)${escapeReg(core)}(?:\\s|$)`).test(hay);
  }
  return hay.includes(core);
}

function factMatch(expectedQuestion, accepted, fullText) {
  const core = norm(coreAnswer(expectedQuestion));
  if (!core) return false;
  const fields = [norm(accepted), norm(fullText)];
  if (fields.some((field) => containsCore(field, core))) return true;
  const acceptedCore = norm(coreAnswer(accepted));
  if (sameFactWithUnit(core, acceptedCore) || sameFactWithUnit(acceptedCore, core)) return true;
  const tokens = core.split(" ").filter((token) => token.length > 2 || /\d/.test(token));
  if (tokens.length < 2) return false;
  const blob = fields.join(" ");
  const hits = tokens.filter((token) => containsCore(blob, token) || blob.includes(token)).length;
  return hits / tokens.length >= 0.8;
}

function sameFactWithUnit(longer, shorter) {
  const groups = [
    ["in", "inch", "inches"],
    ["ft", "foot", "feet"],
    ["sec", "second", "seconds"],
    ["min", "minute", "minutes"],
    ["cm"],
    ["mm"]
  ];
  const clean = (token) => token.replace(/^\.+|\.+$/g, "");
  const isUnit = (token) => groups.some((group) => group.includes(token));
  const sameToken = (left, right) => left === right || groups.some((group) => group.includes(left) && group.includes(right));
  const left = String(longer || "").split(" ").map(clean).filter(Boolean);
  const right = String(shorter || "").split(" ").map(clean).filter(Boolean);
  if (!left.length || !right.length || right.length > left.length) return false;
  if (!right.every((token, index) => sameToken(token, left[index]))) return false;
  return left.slice(right.length).every((token) => isUnit(token));
}

function citationTokens(citation) {
  const text = String(citation || "");
  const tokens = new Set();
  for (const match of text.matchAll(/§\s*(\d+(?:\.\d+)*)/g)) tokens.add(match[1]);
  for (const match of text.matchAll(/\b(?:section|sec\.?)\s+(\d+(?:\.\d+)*)/gi)) tokens.add(match[1]);
  for (const match of text.matchAll(/\[(\d+(?:\.\d+)*)(?:\s|\])/g)) tokens.add(match[1]);
  for (const match of text.matchAll(/\b([GRI]\d{3})\b/g)) tokens.add(match[1].toUpperCase());
  for (const match of text.matchAll(/Q\s*&\s*A\s*#?\s*(\d+)/gi)) tokens.add(`QA${match[1]}`);
  const update = text.match(/Team Update\s*0*(\d+)/i);
  if (update) tokens.add(`TU${Number(update[1])}`);
  for (const match of text.matchAll(/Table\s*(\d+\s*-\s*\d+)/gi)) {
    tokens.add(`TABLE${match[1].replace(/\s+/g, "")}`);
  }
  return [...tokens];
}

function responseHasToken(response, token) {
  const text = String(response || "");
  if (token.startsWith("QA")) {
    const id = token.slice(2);
    return new RegExp(`Q\\s*&\\s*A\\s*#?\\s*${id}\\b`, "i").test(text) ||
      new RegExp(`\\bqna[:/]+${id}\\b`, "i").test(text);
  }
  if (token.startsWith("TU")) {
    const id = String(Number(token.slice(2)));
    return new RegExp(`Team\\s+Update\\s+0*${id}\\b`, "i").test(text) ||
      new RegExp(`\\bTU\\s*0*${id}\\b`, "i").test(text);
  }
  if (token.startsWith("TABLE")) {
    const id = token.slice(5).replace("-", "\\s*-\\s*");
    return new RegExp(`Table\\s*${id}`, "i").test(text);
  }
  if (/^[GRI]\d{3}$/.test(token)) return new RegExp(`\\b${token}\\b`).test(text);
  // "8" must not match inside "10.8" or "18". A longer child section such as 8.1 still counts.
  return new RegExp(`(?<![\\d.])${escapeReg(token)}(?:\\.\\d+)*\\b`).test(text);
}

function labeledField(text, name) {
  const match = String(text || "").match(new RegExp(`^\\s*[*_]*${name}[*_]*\\s*:\\s*(.+?)\\s*$`, "im"));
  return match ? match[1].replace(/\*+/g, "").trim() : "";
}

function firstWord(text) {
  return String(text || "").trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, "").toUpperCase();
}

function buildPrompt(clue) {
  return [
    "Check one FTC BIOBUZZ quiz clue against the current Competition Manual, Team Updates, and official Q&A.",
    "The quiz is not a source. Ignore it if it conflicts with those documents.",
    "",
    `Players see: ${clue.answer}`,
    `Expected response: ${clue.question}`,
    `Quiz citation: ${clue.citation || "(none)"}`,
    "",
    "Reply with these four lines. You may add a short explanation after them.",
    "VERDICT: AGREE or DISAGREE or UNSURE",
    "ACCEPTED: the shortest correct response, such as \"What is 2?\"",
    "SUPPORT: the manual section, rule, Team Update, or Q&A that supports ACCEPTED",
    "CITATION_OK: YES if the quiz citation is a real source that supports the expected response, otherwise NO"
  ].join("\n");
}

function judge(clue, payload) {
  const bot = String(payload?.bot_response || "");
  const verdict = firstWord(labeledField(bot, "VERDICT"));
  const accepted = labeledField(bot, "ACCEPTED");
  const support = labeledField(bot, "SUPPORT");
  const citationWord = firstWord(labeledField(bot, "CITATION_OK"));
  const matched = factMatch(clue.question, accepted, bot);
  const tokens = citationTokens(clue.citation);
  const tokenHits = tokens.filter((token) => responseHasToken(bot, token));
  let citationOk = null;
  if (citationWord === "YES") citationOk = true;
  else if (citationWord === "NO") citationOk = false;
  const citationConfirmed = tokens.length > 0 && tokenHits.length === tokens.length;

  let status = "unsure";
  if (!["AGREE", "DISAGREE", "UNSURE"].includes(verdict)) {
    status = matched ? "review" : "unsure";
  } else if (verdict === "DISAGREE") {
    status = "fail";
  } else if (verdict === "UNSURE") {
    status = "unsure";
  } else if (!matched) {
    status = "review";
  } else if (citationConfirmed && citationOk !== false) {
    status = "pass";
  } else {
    status = "citation";
  }

  return {
    status,
    verdict: verdict || "",
    accepted,
    support,
    citationOk,
    citationConfirmed,
    factMatch: matched,
    citationTokens: tokens,
    citationTokenHits: tokenHits,
    sources: payload?.sources || { manual: [], qna: [] },
    questionAnswered: payload?.question_answered ?? null,
    messageId: payload?.message_id || "",
    bot
  };
}

function buildFixPrompt(row) {
  return [
    "A FTC BIOBUZZ quiz clue did not pass an audit against the current Competition Manual, Team Updates, and official Q&A.",
    "The quiz is not a source. Change only the part the documents disagree with.",
    "Keep Jeopardy form: the clue is a statement, and the response is a question.",
    "",
    `Audit status: ${row.status}`,
    `Players see: ${row.answer}`,
    `Expected response: ${row.question}`,
    `Quiz citation: ${row.citation || "(none)"}`,
    `Prior verdict: ${row.verdict || "none"}`,
    `Prior accepted response: ${row.accepted || "none"}`,
    `Prior support: ${row.support || "none"}`,
    "",
    "Reply with these five lines and nothing before them:",
    "FIX: YES or NO",
    "CLUE: the statement players should see",
    "RESPONSE: the response, such as \"What is 2?\"",
    "CITATION: Competition Manual §number, title, or Q&A number, or Team Update number",
    "WHY: one sentence"
  ].join("\n");
}

function parseFix(bot) {
  const fixWord = firstWord(labeledField(bot, "FIX"));
  return {
    fix: fixWord === "YES" ? true : fixWord === "NO" ? false : null,
    answer: labeledField(bot, "CLUE"),
    question: labeledField(bot, "RESPONSE"),
    citation: labeledField(bot, "CITATION"),
    why: labeledField(bot, "WHY"),
    bot: String(bot || "")
  };
}

function suggestionReady(suggestion) {
  return Boolean(suggestion && !suggestion.error && suggestion.fix !== true) ||
    Boolean(suggestion?.fix && suggestion.retest && suggestion.retest.status !== "error");
}

async function proposeCorrection(row) {
  const started = Date.now();
  const payload = await askChatbot(buildFixPrompt(row));
  const parsed = parseFix(payload?.bot_response || "");
  const suggestion = {
    ...parsed,
    sources: payload?.sources || { manual: [], qna: [] },
    messageId: payload?.message_id || "",
    askedAt: new Date().toISOString(),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1))
  };
  if (suggestion.fix === null || (suggestion.fix && (!suggestion.answer || !suggestion.question || !suggestion.citation))) {
    suggestion.error = "The assistant reply did not include a usable FIX, CLUE, RESPONSE, and CITATION.";
    return suggestion;
  }
  if (!suggestion.fix) return suggestion;
  const retestStarted = Date.now();
  const proposed = {
    answer: suggestion.answer,
    question: suggestion.question,
    citation: suggestion.citation,
    link: suggestion.citation === row.citation ? row.link : ""
  };
  const retestPayload = await askChatbot(buildPrompt(proposed));
  suggestion.retest = {
    ...judge(proposed, retestPayload),
    seconds: Number(((Date.now() - retestStarted) / 1000).toFixed(1)),
    checkedAt: new Date().toISOString()
  };
  suggestion.link = proposed.link;
  return suggestion;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function askChatbot(message) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          user_message: message,
          conversation_history: [],
          session_id: null
        }),
        signal: AbortSignal.timeout(120000)
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
        error.status = response.status;
        throw error;
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      const retry = error.status === 429 || (error.status >= 500 && error.status <= 599) || !error.status;
      if (!retry || attempt === 3) break;
      await sleep(attempt * 8000);
    }
  }
  throw lastError;
}

async function readResultRows() {
  let text = "";
  try {
    text = await readFile(RESULTS_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function loadResults(fallbackRuleset) {
  const rows = await readResultRows();
  const bySlot = new Map();
  let changed = false;
  for (const row of rows) {
    const next = { ...row };
    if (!next.ruleset && fallbackRuleset) {
      next.ruleset = fallbackRuleset;
      changed = true;
    }
    const judged = withJudgment(next);
    if (judged.status !== row.status || judged.ruleset !== row.ruleset) changed = true;
    bySlot.set(slotKey(judged.ruleset, judged.key), judged);
  }
  if (changed || bySlot.size !== rows.length) {
    const body = [...bySlot.values()].map((row) => JSON.stringify(row)).join("\n");
    await writeFile(RESULTS_PATH, body ? `${body}\n` : "");
  }
  return bySlot;
}

async function fetchMetadata() {
  try {
    const response = await fetch(META_URL, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function matchesFilters(clue, opts) {
  if (opts.category && clue.category.toLowerCase() !== opts.category.toLowerCase()) return false;
  if (opts.matches.length) {
    const blob = `${clue.answer} ${clue.question} ${clue.citation}`.toLowerCase();
    if (!opts.matches.some((match) => blob.includes(match.toLowerCase()))) return false;
  }
  return true;
}

function correctionQueue(clues, saved, opts, ruleset) {
  return clues.filter((clue) => {
    if (!matchesFilters(clue, opts)) return false;
    const row = saved.get(slotKey(ruleset, clue.key));
    if (!row || row.status === "pass" || row.status === "error") return false;
    if (opts.force) return true;
    return !suggestionReady(row.suggestion);
  });
}

function selectClues(clues, saved, opts, ruleset) {
  return clues.filter((clue) => {
    if (!matchesFilters(clue, opts)) return false;
    if (opts.force) return true;
    const prior = saved.get(slotKey(ruleset, clue.key));
    return !prior || prior.status === "error";
  });
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function citationNote(row) {
  if (row.status === "pending" || row.status === "error") return "";
  if (row.citationOk === false) return "The assistant said the quiz citation does not support the response.";
  if (row.citationConfirmed && row.citationOk === true) return "The reply names the quiz citation, and the assistant accepted it.";
  if (row.citationConfirmed) return "The reply names the quiz citation.";
  if (row.citationOk === true) return "The assistant said the citation was ok, but the reply does not name every cited section, rule, Q&A, or Team Update.";
  return "The reply does not confirm the quiz citation.";
}

function withJudgment(row) {
  if (!row?.bot || row.status === "error") return row;
  const judged = judge(row, {
    bot_response: row.bot,
    sources: row.sources,
    question_answered: row.questionAnswered,
    message_id: row.messageId
  });
  return { ...row, ...judged };
}

function reviewState(row) {
  if (!row?.suggestion) return "none";
  if (row.decision === "accept") return "accepted";
  if (row.decision === "decline") return "declined";
  return "open";
}

function suggestionHtml(row) {
  const suggestion = row.suggestion;
  if (!suggestion) {
    if (row.status === "pass" || row.status === "pending" || row.status === "error") return "";
    return `<div class="suggestion"><p>No suggested correction is stored for this clue yet.</p></div>`;
  }
  const retest = suggestion.retest;
  const retestLabel = !suggestion.fix
    ? "No replacement"
    : retest
      ? `Retest ${statusLabel(retest.status)}`
      : "Not retested";
  const retestClass = retest?.status || (suggestion.fix ? "unsure" : "pass");
  const proposedLink = suggestion.link
    ? ` <a href="${escapeHtml(suggestion.link)}" target="_blank" rel="noopener noreferrer">Source link</a>`
    : "";
  const body = suggestion.error
    ? `<p class="note">${escapeHtml(suggestion.error)}</p>`
    : suggestion.fix
      ? `<p><strong>Suggested clue.</strong> ${escapeHtml(suggestion.answer)}</p>
         <p><strong>Suggested response.</strong> ${escapeHtml(suggestion.question)}</p>
         <p><strong>Suggested citation.</strong> ${escapeHtml(suggestion.citation)}${proposedLink}</p>`
      : `<p>The assistant would keep the current clue, response, and citation.</p>`;
  const why = suggestion.why ? `<p><strong>Why.</strong> ${escapeHtml(suggestion.why)}</p>` : "";
  const retestDetail = retest?.bot
    ? `<details><summary>Retest reply</summary><pre>${escapeHtml(retest.bot)}</pre></details>`
    : "";
  const raw = suggestion.bot
    ? `<details><summary>Correction reply</summary><pre>${escapeHtml(suggestion.bot)}</pre></details>`
    : "";
  const decision = row.decision === "accept"
    ? "Accepted in the audit results. The board file is unchanged."
    : row.decision === "decline"
      ? "Declined. The board file is unchanged."
      : "No decision yet.";
  const acceptButton = suggestion.error ? "" : `<button type="button" data-decision="accept">Accept</button>`;
  const actions = `<div class="actions">
        ${acceptButton}
        <button type="button" data-decision="decline">Decline</button>
        <button type="button" data-decision="">Clear</button>
        <span class="choice">${escapeHtml(decision)}</span>
      </div>`;
  return `<div class="suggestion">
    <p><span class="badge ${escapeHtml(retestClass)}">${escapeHtml(retestLabel)}</span> Stored in the audit results only.</p>
    ${body}
    ${why}
    ${actions}
    ${retestDetail}
    ${raw}
  </div>`;
}

function statusLabel(status) {
  return {
    pass: "Pass",
    citation: "Citation review",
    fail: "Disagree",
    review: "Wording review",
    unsure: "Unsure",
    error: "Error",
    pending: "Not checked"
  }[status] || status;
}

function renderReport(clues, saved, meta, ruleset) {
  const rows = clues.map((clue) => {
    const prior = saved.get(slotKey(ruleset, clue.key));
    if (!prior) return { ...clue, status: "pending" };
    return withJudgment({
      ...prior,
      id: clue.id,
      line: clue.line,
      category: clue.category,
      answer: clue.answer,
      question: clue.question,
      citation: clue.citation,
      link: clue.link
    });
  });
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  const latest = meta?.latest || {};
  const version = latest.collection_name
    ? `${latest.collection_name}, updated ${latest.updated_at || "unknown"}`
    : "metadata unavailable";
  const cards = rows.map((row) => {
    const link = row.link
      ? `<a href="${escapeHtml(row.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.citation || row.link)}</a>`
      : escapeHtml(row.citation || "No citation");
    const bot = row.bot
      ? `<details><summary>Assistant reply</summary><pre>${escapeHtml(row.bot)}</pre></details>`
      : "";
    const note = row.error ? `<p class="note">${escapeHtml(row.error)}</p>` : "";
    const review = reviewState(row);
    return `<article class="card" data-status="${escapeHtml(row.status)}" data-key="${escapeHtml(row.key || "")}" data-review="${review}">
      <header>
        <span class="id">#${row.id} · line ${row.line}</span>
        <span class="cat">${escapeHtml(row.category)}</span>
        <span class="badge ${escapeHtml(row.status)}">${escapeHtml(statusLabel(row.status))}</span>
      </header>
      <p><strong>Clue.</strong> ${escapeHtml(row.answer)}</p>
      <p><strong>Expected.</strong> ${escapeHtml(row.question)}</p>
      <p><strong>Citation.</strong> ${link}</p>
      <p><strong>Assistant.</strong> ${escapeHtml(row.accepted || "No accepted response labeled.")}</p>
      <p><strong>Support.</strong> ${escapeHtml(row.support || "No support labeled.")} ${escapeHtml(citationNote(row))}</p>
      ${note}
      ${bot}
      ${suggestionHtml(row)}
    </article>`;
  }).join("\n");
  const reviewCounts = { open: 0, accepted: 0, declined: 0 };
  for (const row of rows) {
    const state = reviewState(row);
    if (state !== "none") reviewCounts[state] += 1;
  }
  const countLine = ["pass", "citation", "fail", "review", "unsure", "error", "pending"]
    .filter((status) => counts[status])
    .map((status) => `<button type="button" data-filter="${status}">${escapeHtml(statusLabel(status))} ${counts[status]}</button>`)
    .join("");
  const reviewLine = ["open", "accepted", "declined"]
    .filter((state) => reviewCounts[state])
    .map((state) => `<button type="button" data-filter="review-${state}">${state[0].toUpperCase()}${state.slice(1)} suggestions ${reviewCounts[state]}</button>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FTC BIOBUZZ clue audit</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font: 16px/1.45 Georgia, "Source Serif 4", serif; background: #f6f3ea; color: #1d1a16; }
    header.top { padding: 28px 32px 12px; background: #10233f; color: #f6f3ea; }
    header.top a { color: #f0d48a; }
    h1 { font-family: Oswald, Impact, sans-serif; font-weight: 500; letter-spacing: 0.04em; margin: 0 0 8px; }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px 32px; position: sticky; top: 0; background: #f6f3ea; }
    button { font: 14px/1 Oswald, Impact, sans-serif; letter-spacing: 0.04em; border: 1px solid #10233f; background: white; padding: 6px 10px; cursor: pointer; }
    button.on { background: #10233f; color: white; }
    main { padding: 0 32px 48px; display: grid; gap: 12px; }
    article { background: white; border: 1px solid #ddd4c4; padding: 14px 16px; }
    article header { display: flex; gap: 10px; align-items: baseline; margin-bottom: 6px; }
    .id { font-family: Oswald, Impact, sans-serif; color: #6d6458; }
    .cat { font-family: Oswald, Impact, sans-serif; letter-spacing: 0.04em; }
    .badge { margin-left: auto; font-family: Oswald, Impact, sans-serif; letter-spacing: 0.04em; font-size: 14px; padding: 2px 8px; }
    .pass { background: #e5f2e4; }
    .citation, .review { background: #fff1cc; }
    .fail, .error { background: #f8d7d2; }
    .unsure, .pending { background: #ece7dc; }
    .suggestion { background: #f3f7fb; border: 1px solid #d5e0ea; padding: 10px 12px; margin-top: 10px; }
    .suggestion .badge { margin-left: 0; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .choice { font-family: Oswald, Impact, sans-serif; letter-spacing: 0.03em; }
    article[data-review="accepted"] { border-color: #2e7d32; }
    article[data-review="declined"] { opacity: 0.72; }
    pre { white-space: pre-wrap; font: 14px/1.4 ui-monospace, Consolas, monospace; background: #f6f3ea; padding: 10px; }
    .note { color: #8a2b1f; }
  </style>
</head>
<body>
  <header class="top">
    <h1>FTC BIOBUZZ clue audit</h1>
    <p>${rows.length} clues from boards/ftc-biobuzz.txt. Checked with the <a href="${CHAT_PAGE}">official FTC AI Assistant</a>. That assistant can make mistakes, and its replies are not official rulings.</p>
    <p>Manual index reported by the assistant: ${escapeHtml(version)}. Saved results match ruleset ${escapeHtml(ruleset || "unknown")}. Suggested corrections stay in these results. Accept and Decline do not change the board.</p>
  </header>
  <div class="filters">
    <button type="button" data-filter="all" class="on">All ${rows.length}</button>
    ${countLine}
    ${reviewLine}
  </div>
  <main>${cards}</main>
  <script>
    const buttons = document.querySelectorAll(".filters button");
    buttons.forEach((button) => button.addEventListener("click", () => {
      buttons.forEach((item) => item.classList.remove("on"));
      button.classList.add("on");
      const filter = button.dataset.filter;
      document.querySelectorAll(".card").forEach((card) => {
        const statusMatch = filter === "all" || card.dataset.status === filter;
        const reviewMatch = filter.startsWith("review-") && card.dataset.review === filter.slice("review-".length);
        card.hidden = !(statusMatch || reviewMatch);
      });
    }));
    document.querySelectorAll("[data-decision]").forEach((button) => {
      button.addEventListener("click", async () => {
        const card = button.closest("article");
        const choice = card.querySelector(".choice");
        try {
          const response = await fetch("/api/decision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: card.dataset.key, decision: button.dataset.decision })
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Could not save the decision");
          card.dataset.review = payload.review;
          choice.textContent = payload.decision === "accept"
            ? "Accepted in the audit results. The board file is unchanged."
            : payload.decision === "decline"
              ? "Declined. The board file is unchanged."
              : "No decision yet.";
        } catch (error) {
          choice.textContent = error.message + " Open this page from node audit/verify.mjs --serve.";
        }
      });
    });
  </script>
</body>
</html>`;
}

function printHelp() {
  console.log(`FTC BIOBUZZ clue audit

Reads boards/ftc-biobuzz.txt and asks the official FTC AI Assistant
(${CHAT_PAGE}) about each clue. It does not edit the board or the game.

  node audit/verify.mjs
  node audit/verify.mjs --run --threads 4
  node audit/verify.mjs --run --limit 5
  node audit/verify.mjs --run --category Scoring
  node audit/verify.mjs --run --match "Q&A 21"
  node audit/verify.mjs --force
  node audit/verify.mjs --correct --threads 8
  node audit/verify.mjs --serve
  node audit/verify.mjs --report

Results stay in audit/out/. A pass, disagree, or review is kept for that clue text and ruleset.
The ruleset is the Team Update number, manual version, and collection name.
A new Team Update checks the clues again. An error is tried again.
--threads runs that many requests at once, from 1 to 8. --force checks them again.
--correct asks for a replacement for every clue that did not pass, retests that replacement,
and stores both replies in the audit results. --serve opens the report so a suggestion
can be accepted or declined. Neither command edits the board.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  const board = extractBoard(await readFile(BOARD_PATH, "utf8"));
  const clues = parseClues(board.body, board.lineOffset);
  await mkdir(OUT_DIR, { recursive: true });
  let meta = null;
  try {
    meta = JSON.parse(await readFile(META_PATH, "utf8"));
  } catch {
    meta = null;
  }
  let ruleset = rulesetId(meta);
  let saved = await loadResults(ruleset);
  if (opts.run) {
    const live = await fetchMetadata();
    if (live) {
      meta = live;
      ruleset = rulesetId(live);
      await writeFile(META_PATH, JSON.stringify(live, null, 2));
      saved = await loadResults(ruleset);
    }
  }
  const pending = selectClues(clues, saved, opts, ruleset);
  const categories = new Map();
  for (const clue of clues) categories.set(clue.category, (categories.get(clue.category) || 0) + 1);
  const remembered = clues.filter((clue) => {
    const prior = saved.get(slotKey(ruleset, clue.key));
    return prior && prior.status !== "error";
  }).length;

  console.log(`${clues.length} clues in ${categories.size} categories.`);
  console.log(`Ruleset ${ruleset || "unknown"}. ${remembered} already checked for this ruleset. ${pending.length} still need a check.`);
  const corrections = correctionQueue(clues, saved, opts, ruleset);
  if (!opts.run && !opts.report && !opts.correct && !opts.serve) {
    console.log(`${corrections.length} non-pass clues have no stored suggestion yet.`);
    console.log("No requests sent. Add --run, --correct, --serve, or --report.");
    printHelp();
    return;
  }

  if (opts.run) {
    const batch = pending.slice(0, opts.limit);
    const manual = meta?.latest?.collection_name || "unknown manual index";
    console.log(`Assistant index: ${manual}`);
    console.log(`Asking about ${batch.length} clue${batch.length === 1 ? "" : "s"} on ${opts.threads} thread${opts.threads === 1 ? "" : "s"}.`);
    let done = 0;
    let writes = Promise.resolve();
    let cursor = 0;
    async function worker() {
      while (cursor < batch.length) {
        const clue = batch[cursor++];
        const started = Date.now();
        const prompt = buildPrompt(clue);
        let record;
        try {
          const payload = await askChatbot(prompt);
          const judged = judge(clue, payload);
          record = {
            ...clue,
            ...judged,
            ruleset,
            seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
            checkedAt: new Date().toISOString()
          };
        } catch (error) {
          record = {
            ...clue,
            ruleset,
            status: "error",
            error: error.message,
            seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
            checkedAt: new Date().toISOString()
          };
        }
        saved.set(slotKey(ruleset, clue.key), record);
        const line = JSON.stringify(record) + "\n";
        writes = writes.then(() => appendFile(RESULTS_PATH, line));
        await writes;
        done++;
        console.log(`[${done}/${batch.length}] #${clue.id} ${clue.category}: ${record.status} (${record.seconds}s)`);
        if (opts.delayMs) await sleep(opts.delayMs);
      }
    }
    const workers = Array.from({ length: Math.min(opts.threads, batch.length) }, () => worker());
    await Promise.all(workers);
    await writes;
  }

  if (opts.correct) {
    const batch = corrections.slice(0, opts.limit);
    console.log(`Requesting corrections for ${batch.length} non-pass clue${batch.length === 1 ? "" : "s"} on ${opts.threads} thread${opts.threads === 1 ? "" : "s"}.`);
    let done = 0;
    let writes = Promise.resolve();
    let cursor = 0;
    async function correctWorker() {
      while (cursor < batch.length) {
        const clue = batch[cursor++];
        const row = saved.get(slotKey(ruleset, clue.key));
        const started = Date.now();
        let suggestion;
        try {
          suggestion = await proposeCorrection({ ...row, ...clue, status: row.status, bot: row.bot });
        } catch (error) {
          suggestion = { error: error.message, askedAt: new Date().toISOString() };
        }
        const updated = {
          ...row,
          ...clue,
          status: row.status,
          bot: row.bot,
          suggestion,
          decision: null,
          decidedAt: null,
          correctedAt: new Date().toISOString()
        };
        saved.set(slotKey(ruleset, clue.key), updated);
        const line = JSON.stringify(updated) + "\n";
        writes = writes.then(() => appendFile(RESULTS_PATH, line));
        await writes;
        done++;
        const retest = suggestion.retest?.status || (suggestion.fix === false ? "keep" : suggestion.error ? "error" : "missing");
        console.log(`[${done}/${batch.length}] #${clue.id} ${clue.category}: suggestion ${retest} (${Number(((Date.now() - started) / 1000).toFixed(1))}s)`);
        if (opts.delayMs) await sleep(opts.delayMs);
      }
    }
    if (batch.length) {
      const workers = Array.from({ length: Math.min(opts.threads, batch.length) }, () => correctWorker());
      await Promise.all(workers);
      await writes;
    }
  }

  const latest = await loadResults(ruleset);
  await writeFile(REPORT_PATH, renderReport(clues, latest, meta, ruleset));
  const counts = {};
  for (const clue of clues) {
    const prior = latest.get(slotKey(ruleset, clue.key));
    const status = prior ? prior.status : "pending";
    counts[status] = (counts[status] || 0) + 1;
  }
  console.log(Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(", "));
  console.log(`Report: ${REPORT_PATH}`);
  if (opts.serve) await serveReport({ clues, saved: latest, meta, ruleset, port: opts.port });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveReport({ clues, saved, meta, ruleset, port }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/report.html")) {
        const html = renderReport(clues, saved, meta, ruleset);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/decision") {
        const payload = JSON.parse(await readBody(req) || "{}");
        const decision = payload.decision || "";
        if (!["", "accept", "decline"].includes(decision)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Decision must be accept, decline, or blank." }));
          return;
        }
        if (!/^[a-f0-9]{16}$/.test(payload.key || "")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown clue." }));
          return;
        }
        const row = saved.get(slotKey(ruleset, payload.key));
        if (!row?.suggestion || (decision === "accept" && row.suggestion.error)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "That clue has no suggestion to accept." }));
          return;
        }
        row.decision = decision || null;
        row.decidedAt = decision ? new Date().toISOString() : null;
        await appendFile(RESULTS_PATH, JSON.stringify(row) + "\n");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, decision: row.decision, review: reviewState(row) }));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`Audit report: http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

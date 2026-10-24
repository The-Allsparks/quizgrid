// Build the line-by-line review page for FTC BIOBUZZ clues.
// Joins the board, the 17 October reviewer spreadsheet, and audit/out/results.jsonl.
// Does not modify the board. Open audit/out/review.html after this runs.
//
// Usage:
//   node audit/review.mjs
//   node audit/review.mjs --sheet "C:\path\Sheet1.csv"

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_PATH = path.join(ROOT, "boards", "ftc-biobuzz.txt");
const RESULTS_PATH = path.join(ROOT, "audit", "out", "results.jsonl");
const CLIENT_PATH = path.join(ROOT, "audit", "review-client.js");
const SHARED_PATH = path.join(ROOT, "audit", "review-shared.js");
const OUT_PATH = path.join(ROOT, "audit", "out", "review.html");
const DEFAULT_SHEET = "C:\\Users\\garre\\Downloads\\FTC 2026_2027 BIOBUZZ Jeopardy Spreadsheet as of 20261017 - Sheet1.csv";

function parseArgs(argv) {
  let sheet = DEFAULT_SHEET;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sheet") sheet = argv[++i] || "";
    else if (argv[i] === "--help" || argv[i] === "-h") return { help: true, sheet };
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { help: false, sheet };
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rows.push(field);
      field = "";
    } else field += c;
  }
  if (field) rows.push(field);
  return rows;
}

function same(a, b) {
  return String(a || "").replace(/\s+/g, " ").trim().toLowerCase() === String(b || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function quotesIn(note) {
  const found = [];
  const re = /"([^"]*)"|“([^”]*)”/g;
  let match;
  while ((match = re.exec(note))) {
    const text = (match[1] ?? match[2] ?? "").trim();
    if (!text) continue;
    found.push({ text, before: note.slice(Math.max(0, match.index - 90), match.index) });
  }
  return found;
}

function reviewerProposal(note, clue) {
  let answer = "";
  let question = "";
  const intro = /(?:change|update|restate|reword)(?:\s+\w+){0,6}\s+to\s*$|something like\s*$|phrasing to\s*$/i;
  for (const quote of quotesIn(note)) {
    if (!intro.test(quote.before.trim())) continue;
    if (/^(what|who|where|when)\b/i.test(quote.text)) question = quote.text.endsWith("?") ? quote.text : `${quote.text}?`;
    else answer = quote.text;
  }
  const urls = note.match(/https?:\/\/[^\s]+/g) || [];
  const link = urls.length ? urls[urls.length - 1].replace(/[).,]+$/g, "") : "";
  const next = {
    answer: answer || clue.answer,
    question: question || clue.question,
    citation: clue.citation,
    link: link || clue.link
  };
  const available = Boolean(answer || question || (link && !same(link, clue.link)));
  const changed = available && (!same(next.answer, clue.answer) || !same(next.question, clue.question) || !same(next.link, clue.link));
  return changed ? { ...next, available: true } : { available: false };
}

function noteKind(note, proposal) {
  const text = note.trim();
  if (!text) return "blank";
  if (/^checked answer, question, link, all ok\.?$/i.test(text)) return "ok";
  if (proposal.available) return "wording";
  if (/^\s*remove\b/i.test(text) || /\bremove (this|the question|question)\b/i.test(text)) return "remove";
  return "comment";
}

function parseSheet(text, boardCategories) {
  const notes = new Map();
  const categoryNotes = new Map();
  let category = "";
  for (const raw of parseCsv(text)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    if (line.startsWith("TITLE:") || line === "const BOARD = `" || line === "`;") continue;
    if (line.startsWith("CATEGORY:")) {
      const rest = line.slice("CATEGORY:".length).trim();
      const pipe = rest.indexOf("|");
      let name = pipe >= 0 ? rest.slice(0, pipe).trim() : rest;
      let note = pipe >= 0 ? rest.slice(pipe + 1).trim() : "";
      const known = [...boardCategories].sort((a, b) => b.length - a.length).find((item) => name === item || name.startsWith(`${item} - `) || name.startsWith(`${item} |`));
      if (known && name !== known) {
        note = [name.slice(known.length).replace(/^(\s*[-|]\s*)/, "").trim(), note].filter(Boolean).join(" ");
        name = known;
      }
      category = name;
      if (note) categoryNotes.set(name, note);
      continue;
    }
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 2) continue;
    const answer = parts[0];
    const question = parts[1];
    const citation = parts[2] || "";
    const link = parts[3] || "";
    const note = parts.slice(4).join(" | ").trim();
    const key = `${answer.toLowerCase().replace(/\s+/g, " ").trim()}||${question.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const list = notes.get(key) || [];
    list.push({ category, note, citation, link });
    notes.set(key, list);
  }
  return { notes, categoryNotes };
}

function parseBoard(text) {
  const marker = "const BOARD = `";
  const start = text.indexOf(marker);
  const end = text.lastIndexOf("`;");
  if (start < 0 || end < start) throw new Error("Could not find the BOARD text in boards/ftc-biobuzz.txt");
  const prefix = text.slice(0, start + marker.length);
  const body = text.slice(start + marker.length, end);
  const suffix = text.slice(end);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = body.split(/\r?\n/);
  const lineOffset = prefix.split(/\r?\n/).length - 1;
  const clues = [];
  const lines = [];
  let category = "";
  rawLines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    const fileLine = index + 1 + lineOffset;
    if (!line || line.startsWith("#") || line.startsWith("TITLE:") || !line.includes(" | ")) {
      if (line.startsWith("CATEGORY:")) {
        category = line.slice("CATEGORY:".length).trim();
        lines.push({ kind: "category", text: rawLine, name: category });
      } else lines.push({ kind: "text", text: rawLine });
      return;
    }
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
    const key = createHash("sha256").update([category, answer, question, citation, link].join("\n")).digest("hex").slice(0, 16);
    clues.push({ id, line: fileLine, category, answer, question, citation, link, key, raw: rawLine });
    lines.push({ kind: "clue", id });
  });
  return { prefix, body, suffix, newline, lines, clues };
}

function loadAudit() {
  const text = readFileSync(RESULTS_PATH, "utf8");
  const byKey = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.key) byKey.set(row.key, row);
  }
  return byKey;
}

function auditProposal(row, clue) {
  const status = row?.status || "pending";
  const suggestion = row?.suggestion;
  if (!suggestion?.fix || suggestion.error || status === "pass") {
    return {
      status,
      available: false,
      accepted: row?.accepted || "",
      support: row?.support || "",
      why: suggestion?.why || "",
      retest: suggestion?.retest?.status || ""
    };
  }
  const next = {
    answer: String(suggestion.answer || clue.answer).trim(),
    question: String(suggestion.question || clue.question).trim(),
    citation: String(suggestion.citation || clue.citation).trim(),
    link: String(suggestion.link || "").trim() || clue.link
  };
  const available = !same(next.answer, clue.answer) || !same(next.question, clue.question) || !same(next.citation, clue.citation) || !same(next.link, clue.link);
  return {
    status,
    available,
    ...next,
    accepted: row?.accepted || "",
    support: row?.support || "",
    why: suggestion.why || "",
    retest: suggestion.retest?.status || ""
  };
}

function buildModel(sheetPath) {
  const boardFile = readFileSync(BOARD_PATH, "utf8");
  const board = parseBoard(boardFile);
  const categories = new Set(board.clues.map((clue) => clue.category));
  const sheet = parseSheet(readFileSync(sheetPath, "utf8"), categories);
  const audit = loadAudit();
  const used = new Map();
  const clues = board.clues.map((clue) => {
    const matchKey = `${clue.answer.toLowerCase().replace(/\s+/g, " ").trim()}||${clue.question.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const bucket = sheet.notes.get(matchKey) || [];
    const index = used.get(matchKey) || 0;
    used.set(matchKey, index + 1);
    const sheetRow = bucket[index] || null;
    const note = sheetRow?.note || "";
    const proposal = reviewerProposal(note, clue);
    const kind = noteKind(note, proposal);
    const auditRow = auditProposal(audit.get(clue.key), clue);
    const categoryNote = sheet.categoryNotes.get(clue.category) || "";
    return {
      ...clue,
      note,
      noteKind: kind,
      asksRemove: kind === "remove",
      reviewer: proposal.available ? proposal : null,
      sheetCitation: sheetRow && !same(sheetRow.citation, clue.citation) ? sheetRow.citation : "",
      sheetLink: sheetRow && !same(sheetRow.link, clue.link) ? sheetRow.link : "",
      categoryNote,
      audit: auditRow
    };
  });
  for (const clue of clues) {
    clue.raised = ["citation", "fail", "review", "unsure", "error"].includes(clue.audit.status);
  }
  return {
    generatedAt: new Date().toISOString(),
    sheetPath,
    prefix: board.prefix,
    suffix: board.suffix,
    newline: board.newline,
    lines: board.lines,
    clues
  };
}

function assertModel(model) {
  const shared = readFileSync(SHARED_PATH, "utf8");
  const api = new Function(`${shared}\nreturn { exportBody };`)();
  const roundTrip = api.exportBody(model, {});
  if (roundTrip !== modelBody(model)) throw new Error("Export changed the board when every clue is still undecided");

  const find = (fragment) => model.clues.find((clue) => `${clue.answer} ${clue.question}`.includes(fragment));
  const loading = find("about 23 inches wide by this many inches deep");
  const reset = model.clues.find((clue) => clue.question === "What is stop their robots?");
  if (!loading?.reviewer || !reset) return;
  if (!loading.reviewer.answer.startsWith("A loading zone is approximately 23 inches wide")) {
    throw new Error("Loading-zone reviewer wording was not parsed");
  }
  const flower = find("highest position among scoring nectar");
  if (flower?.reviewer?.question !== "What is the top-most nectar?") {
    throw new Error("Flower-owner reviewer response was not parsed");
  }
  const woodie = find("coined the term Gracious Professionalism");
  if (woodie?.reviewer?.question !== "Who is Dr. Woodie Flowers?" || woodie.reviewer.answer !== woodie.answer) {
    throw new Error("Woodie Flowers reviewer response was not parsed");
  }
  const g418 = find("from a flower's bottom");
  if (!g418?.reviewer?.link.includes("#G418")) throw new Error("G418 reviewer link was not parsed");
  const ranking = find("Extra qualification credit");
  if (ranking?.reviewer?.answer !== "These are beyond match points and earned for achievements.") {
    throw new Error("Ranking-points reviewer wording was not parsed");
  }
  if (reset.audit?.question !== "What is retrieve their robots?") {
    throw new Error("Field-reset audit suggestion was not joined");
  }
  if (!model.clues.some((clue) => clue.category === "Championship" && /remove this entire category/i.test(clue.categoryNote))) {
    throw new Error("Championship category note was not joined");
  }
  const edited = {
    [loading.key]: { action: "reviewer", ...loading.reviewer },
    [reset.key]: { action: "remove" }
  };
  const body = api.exportBody(model, edited);
  if (!body.includes(loading.reviewer.answer)) throw new Error("Export did not apply the reviewer wording");
  if (body.includes(reset.raw)) throw new Error("Export kept a removed clue");
  if (!body.includes("CATEGORY: Field Staff")) throw new Error("Export dropped a category that still has clues");
}

function modelBody(model) {
  return model.lines.map((line) => line.kind === "clue"
    ? model.clues.find((clue) => clue.id === line.id).raw
    : line.text).join(model.newline);
}

function page(model) {
  const json = JSON.stringify(model).replace(/</g, "\\u003c");
  const shared = readFileSync(SHARED_PATH, "utf8");
  const client = readFileSync(CLIENT_PATH, "utf8");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FTC BIOBUZZ clue review</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font: 16px/1.45 Georgia, "Source Serif 4", serif; background: #f6f3ea; color: #1d1a16; }
    header.top { padding: 22px 28px 14px; background: #10233f; color: #f6f3ea; }
    h1 { font-family: Oswald, Impact, sans-serif; font-weight: 500; letter-spacing: 0.04em; margin: 0 0 8px; }
    header.top p { margin: 0; max-width: 68rem; }
    a { color: #8a5a12; }
    header.top a { color: #f0d48a; }
    .bar { position: sticky; top: 0; z-index: 2; background: #f6f3ea; border-bottom: 1px solid #ddd4c4; padding: 12px 28px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    button, .file { font: 15px/1.2 Oswald, Impact, sans-serif; letter-spacing: 0.03em; border: 1px solid #10233f; background: white; color: #10233f; padding: 8px 10px; cursor: pointer; }
    button.on, button[aria-pressed="true"] { background: #10233f; color: white; }
    button.hint { box-shadow: inset 0 -3px 0 #c4922a; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #c4922a; outline-offset: 2px; }
    main { padding: 18px 28px 48px; max-width: 1100px; }
    .progress { height: 8px; background: #e4dccb; margin: 8px 0; }
    .progress span { display: block; height: 100%; background: #10233f; }
    .sources { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    section { background: white; border: 1px solid #ddd4c4; padding: 12px 14px; min-width: 0; }
    section h2 { font-family: Oswald, Impact, sans-serif; font-weight: 500; letter-spacing: 0.04em; font-size: 15px; margin: 0 0 8px; }
    .meta { font-family: Oswald, Impact, sans-serif; letter-spacing: 0.04em; color: #6d6458; margin: 0 0 8px; }
    .badge { display: inline-block; font-family: Oswald, Impact, sans-serif; letter-spacing: 0.04em; font-size: 13px; padding: 2px 8px; background: #ece7dc; }
    .pass { background: #e5f2e4; }
    .citation, .review, .comment, .wording { background: #fff1cc; }
    .fail, .error, .remove { background: #f8d7d2; }
    .unsure, .pending, .blank { background: #ece7dc; }
    .ok { background: #e5f2e4; }
    .banner { background: #fff1cc; border: 1px solid #e2d2a4; padding: 10px 12px; margin: 0 0 12px; }
    .choice { background: #e7eef6; border: 1px solid #c5d4e4; padding: 10px 12px; margin: 12px 0; }
    .actions { position: sticky; bottom: 0; background: #f6f3ea; padding: 12px 0 8px; display: flex; flex-wrap: wrap; gap: 8px; }
    .manual { display: grid; gap: 8px; margin-top: 12px; }
    label { font-family: Oswald, Impact, sans-serif; letter-spacing: 0.03em; display: grid; gap: 4px; }
    input[type="text"], input[type="search"], textarea { font: 16px/1.4 Georgia, serif; border: 1px solid #10233f; padding: 8px; width: 100%; box-sizing: border-box; background: white; color: #1d1a16; }
    textarea { min-height: 4.5rem; resize: vertical; }
    .nav { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
    .line { white-space: pre-wrap; background: #f6f3ea; padding: 8px; }
    p { margin: 0 0 8px; }
    .reason { color: #6d6458; min-height: 1.2em; }
    @media (max-width: 900px) { .sources { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header class="top">
    <h1>FTC BIOBUZZ clue review</h1>
    <p>One FTC AI finding at a time. The queue is the clues that did not pass. Keep the current wording, write your own, remove it, or defer it. Choices stay in this browser. A downloaded board leaves undecided and deferred clues unchanged, and it does not replace <a href="../../boards/ftc-biobuzz.txt">boards/ftc-biobuzz.txt</a> until you do that yourself.</p>
  </header>
  <div class="bar">
    <button type="button" data-filter="todo" class="on">To review</button>
    <button type="button" data-filter="deferred">Deferred</button>
    <button type="button" data-filter="decided">Decided</button>
    <button type="button" data-filter="all">Every clue</button>
    <input id="find" type="search" placeholder="Find a clue" aria-label="Find a clue">
    <button type="button" id="undo" disabled>Undo last</button>
    <button type="button" id="download-board">Download board</button>
    <button type="button" id="download-choices">Download choices</button>
    <label class="file">Load choices<input id="load-choices" type="file" accept="application/json,.json" hidden></label>
  </div>
  <main id="app"></main>
  <script>const MODEL = ${json};</script>
  <script>${shared}\n${client}</script>
</body>
</html>`;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log("node audit/review.mjs [--sheet path.csv]");
  process.exit(0);
}
const model = buildModel(opts.sheet);
assertModel(model);
mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, page(model));
const raised = model.clues.filter((clue) => clue.raised).length;
const wording = model.clues.filter((clue) => clue.reviewer).length;
const auditEdits = model.clues.filter((clue) => clue.audit.available).length;
const statuses = {};
for (const clue of model.clues) statuses[clue.audit.status] = (statuses[clue.audit.status] || 0) + 1;
console.log(`${model.clues.length} clues, ${raised} in the review queue, ${wording} reviewer wordings, ${auditEdits} audit edits`);
console.log(Object.entries(statuses).map(([status, count]) => `${status} ${count}`).join(", "));
console.log(OUT_PATH);

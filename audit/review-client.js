"use strict";

const STORAGE = "biobuzz-clue-review-v1";
const UI_KEY = "biobuzz-clue-review-ui";
const STATUS = {
  pass: "Pass",
  citation: "Citation review",
  fail: "Disagree",
  review: "Wording review",
  unsure: "Unsure",
  error: "Error",
  pending: "Not checked"
};
const ACTION = {
  keep: "Keep as is",
  reviewer: "Update based on reviewer",
  audit: "Update based on audit",
  manual: "Manual update",
  remove: "Remove",
  defer: "Defer"
};

let decisions = loadDecisions();
let undo = [];
let filter = "todo";
let currentId = MODEL.clues[0]?.id || 0;
let manual = false;

function loadDecisions() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || "{}");
    return saved && saved.decisions ? saved.decisions : {};
  } catch {
    return {};
  }
}

function saveDecisions() {
  localStorage.setItem(STORAGE, JSON.stringify({ kind: "biobuzz-clue-review", savedAt: new Date().toISOString(), decisions }));
}

function saveUi() {
  sessionStorage.setItem(UI_KEY, JSON.stringify({ filter, currentId }));
}

function shown(clue) {
  const decision = decisions[clue.key];
  if (filter === "todo") return clue.raised && !decision;
  if (filter === "deferred") return decision?.action === "defer";
  if (filter === "decided") return Boolean(decision);
  return true;
}

function current() {
  return MODEL.clues.find((clue) => clue.id === currentId) || MODEL.clues[0];
}

function counts() {
  const tally = { keep: 0, reviewer: 0, audit: 0, manual: 0, remove: 0, defer: 0 };
  for (const decision of Object.values(decisions)) {
    if (tally[decision.action] != null) tally[decision.action] += 1;
  }
  return tally;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null && value !== false) node.setAttribute(key, String(value));
  }
  for (const child of children || []) node.append(child instanceof Node ? child : document.createTextNode(child == null ? "" : String(child)));
  return node;
}

function field(label, value) {
  const node = el("p");
  node.append(el("strong", {}, [label]), " ", value || "—");
  return node;
}

function lineBlock(title, fields) {
  return el("div", {}, [
    el("p", {}, [el("strong", {}, [title])]),
    el("p", { class: "line" }, [formatClueLine(fields)])
  ]);
}

function safeLink(url, label) {
  if (!/^https?:\/\//.test(url || "")) return document.createTextNode(label || "No link");
  return el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, [label || url]);
}

function commit(clue, action, fields) {
  undo.push({ id: clue.id, key: clue.key, previous: decisions[clue.key] ? { ...decisions[clue.key] } : null });
  if (undo.length > 30) undo.shift();
  decisions[clue.key] = {
    action,
    answer: fields.answer,
    question: fields.question,
    citation: fields.citation,
    link: fields.link,
    at: new Date().toISOString()
  };
  saveDecisions();
  manual = false;
  const later = MODEL.clues.find((item) => item.id > clue.id && shown(item));
  const queue = MODEL.clues.filter(shown);
  if (later) currentId = later.id;
  else if (queue.length) currentId = queue[0].id;
  render();
}

function boardFields(clue) {
  return { answer: clue.answer, question: clue.question, citation: clue.citation, link: clue.link };
}

function render() {
  saveUi();
  const undoButton = document.getElementById("undo");
  if (undoButton) undoButton.disabled = undo.length === 0;
  const app = document.getElementById("app");
  const tally = counts();
  const decided = Object.keys(decisions).length;
  const queue = MODEL.clues.filter(shown);
  const clue = current();
  const inQueue = queue.some((item) => item.id === clue.id);
  const queueIndex = Math.max(0, queue.findIndex((item) => item.id === clue.id));
  const fraction = MODEL.clues.length ? Math.round((decided / MODEL.clues.length) * 100) : 0;
  const progress = el("div", {}, [
    el("p", { class: "meta" }, [`${decided} of ${MODEL.clues.length} decided · Keep ${tally.keep} · Manual ${tally.manual} · Remove ${tally.remove} · Defer ${tally.defer} · ${queue.length} left in this queue`]),
    el("div", { class: "progress" }, [el("span", { style: `width:${fraction}%` })])
  ]);
  app.replaceChildren(progress);
  if (!clue) {
    app.append(el("p", {}, ["No clues are loaded."]));
    return;
  }
  if (!queue.length) {
    app.append(el("p", {}, ["Nothing is left in this queue. Switch to Every clue to walk the whole board."]));
    return;
  }
  const position = el("p", { class: "meta" }, [
    `#${clue.id} · line ${clue.line} · ${clue.category} · clue ${clue.id} of ${MODEL.clues.length}`,
    inQueue && queue.length ? ` · ${queueIndex + 1} of ${queue.length} in this queue` : ""
  ]);
  const banner = [];
  if (!inQueue) banner.push(el("div", { class: "banner" }, ["This clue is outside the current queue. Next returns to that queue."]));
  const decision = decisions[clue.key];
  if (decision) {
    banner.push(el("div", { class: "choice" }, [
      `Your choice: ${ACTION[decision.action] || decision.action}. `,
      decision.action === "remove" ? "It will be left out of a downloaded board." : `Downloaded line: ${decision.action === "keep" || decision.action === "defer" ? clue.raw : formatClueLine(decision)}`
    ]));
  }
  app.append(position, ...banner, sources(clue), actions(clue), navigation(clue));
}

function sources(clue) {
  const auditReason = clue.audit.available ? "" : "The audit did not store a different clue, response, or citation.";
  const audit = el("section", {}, [
    el("h2", {}, ["FTC AI audit"]),
    el("p", {}, [el("span", { class: `badge ${clue.audit.status}` }, [STATUS[clue.audit.status] || clue.audit.status])]),
    field("Accepted response.", clue.audit.accepted || "None labeled.")
  ]);
  if (clue.audit.support) audit.append(field("Support.", clue.audit.support));
  if (clue.audit.why) audit.append(field("Why.", clue.audit.why));
  if (clue.audit.retest) audit.append(field("Retest.", clue.audit.retest));
  if (clue.audit.available) audit.append(lineBlock("Update based on audit would write", clue.audit));
  else audit.append(el("p", { class: "reason" }, [auditReason]));

  const current = el("section", {}, [
    el("h2", {}, ["Current board"]),
    field("Clue.", clue.answer),
    field("Response.", clue.question),
    field("Citation.", clue.citation),
    el("p", {}, [el("strong", {}, ["Link. "]), safeLink(clue.link, "Open source")])
  ]);
  return el("div", { class: "sources" }, [current, audit]);
}

function actions(clue) {
  const buttons = el("div", { class: "actions" });
  const specs = [
    ["keep", true, false],
    ["manual", true, false],
    ["remove", true, false],
    ["defer", true, false]
  ];
  const keys = ["1", "2", "3", "4"];
  specs.forEach(([action, enabled, hint], index) => {
    const button = el("button", {
      type: "button",
      disabled: enabled ? null : "disabled",
      onclick: () => {
        if (!enabled) return;
        if (action === "manual") {
          manual = true;
          render();
          return;
        }
        commit(clue, action, boardFields(clue));
      }
    }, [`${keys[index]} ${ACTION[action]}`]);
    if (hint) button.classList.add("hint");
    if (manual && action === "manual") button.setAttribute("aria-pressed", "true");
    buttons.append(button);
  });
  const wrap = el("div", {}, [
    buttons,
    el("p", { class: "reason" }, ["Keys 1–4 choose. Right arrow goes to the next queued clue."])
  ]);
  if (manual) wrap.append(manualForm(clue));
  return wrap;
}

function manualForm(clue) {
  const answer = el("textarea", { id: "manual-answer" }, [clue.answer]);
  const question = el("input", { id: "manual-question", type: "text", value: clue.question });
  const citation = el("input", { id: "manual-citation", type: "text", value: clue.citation });
  const link = el("input", { id: "manual-link", type: "text", value: clue.link });
  const form = el("form", { class: "manual", onsubmit: (event) => event.preventDefault() }, [
    el("label", {}, ["Clue", answer]),
    el("label", {}, ["Response", question]),
    el("label", {}, ["Citation", citation]),
    el("label", {}, ["Link", link])
  ]);
  const row = el("div", { class: "nav" });
  if (clue.audit.available) row.append(el("button", { type: "button", onclick: () => fill(clue.audit) }, ["Copy audit wording"]));
  row.append(el("button", { type: "button", onclick: () => saveManual(clue) }, ["Save manual update"]));
  row.append(el("button", { type: "button", onclick: () => { manual = false; render(); } }, ["Cancel"]));
  form.append(row);
  return form;

  function fill(fields) {
    answer.value = fields.answer || "";
    question.value = fields.question || "";
    citation.value = fields.citation || "";
    link.value = fields.link || "";
  }
}

function saveManual(clue) {
  const fields = {
    answer: document.getElementById("manual-answer").value.trim(),
    question: document.getElementById("manual-question").value.trim(),
    citation: document.getElementById("manual-citation").value.trim(),
    link: document.getElementById("manual-link").value.trim()
  };
  if (!fields.answer || !fields.question) {
    window.alert("A manual update needs both a clue and a response.");
    return;
  }
  commit(clue, "manual", fields);
}

function removeCategory(category) {
  const pending = MODEL.clues.filter((clue) => clue.category === category && !decisions[clue.key]);
  if (!pending.length) {
    window.alert("Every clue in this category already has a choice.");
    return;
  }
  const ok = window.confirm(`Mark ${pending.length} undecided clue${pending.length === 1 ? "" : "s"} in ${category} as remove?`);
  if (!ok) return;
  undo.push({
    id: currentId,
    bulk: pending.map((clue) => ({ key: clue.key, previous: null }))
  });
  const now = new Date().toISOString();
  for (const clue of pending) {
    decisions[clue.key] = { action: "remove", ...boardFields(clue), at: now };
  }
  saveDecisions();
  const later = MODEL.clues.find((clue) => clue.id > currentId && shown(clue));
  const queue = MODEL.clues.filter(shown);
  currentId = later?.id || queue[0]?.id || currentId;
  render();
}

function navigation(clue) {
  return el("div", { class: "nav" }, [
    el("button", { type: "button", onclick: () => step(-1) }, ["Previous"]),
    el("button", { type: "button", onclick: () => step(1) }, ["Next"]),
    el("button", { type: "button", disabled: decisions[clue.key] ? null : "disabled", onclick: () => clearChoice(clue) }, ["Clear this choice"])
  ]);
}

function step(direction) {
  manual = false;
  if (direction < 0) {
    const index = MODEL.clues.findIndex((clue) => clue.id === currentId);
    if (index > 0) currentId = MODEL.clues[index - 1].id;
  } else {
    const later = MODEL.clues.find((clue) => clue.id > currentId && shown(clue));
    const queue = MODEL.clues.filter(shown);
    if (later) currentId = later.id;
    else if (queue.length) currentId = queue[0].id;
  }
  render();
}

function clearChoice(clue) {
  if (!decisions[clue.key]) return;
  undo.push({ id: clue.id, key: clue.key, previous: { ...decisions[clue.key] } });
  delete decisions[clue.key];
  saveDecisions();
  render();
}

function undoLast() {
  const item = undo.pop();
  if (!item) return;
  if (item.bulk) {
    for (const entry of item.bulk) {
      if (entry.previous) decisions[entry.key] = entry.previous;
      else delete decisions[entry.key];
    }
  } else if (item.previous) decisions[item.key] = item.previous;
  else delete decisions[item.key];
  currentId = item.id;
  saveDecisions();
  render();
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function wire() {
  try {
    const ui = JSON.parse(sessionStorage.getItem(UI_KEY) || "{}");
    if (ui.filter) filter = ui.filter;
    if (MODEL.clues.some((clue) => clue.id === ui.currentId)) currentId = ui.currentId;
  } catch {
    /* keep the defaults */
  }
  if (!MODEL.clues.some((clue) => clue.id === currentId && (filter === "all" || shown(clue)))) {
    currentId = (MODEL.clues.find(shown) || MODEL.clues[0]).id;
  }
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("on", button.dataset.filter === filter);
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      manual = false;
      document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("on", item === button));
      if (!shown(current())) currentId = (MODEL.clues.find(shown) || current()).id;
      render();
    });
  });
  document.getElementById("undo").addEventListener("click", undoLast);
  document.getElementById("download-board").addEventListener("click", () => {
    download("ftc-biobuzz-reviewed.txt", MODEL.prefix + exportBody(MODEL, decisions) + MODEL.suffix, "text/plain");
  });
  document.getElementById("download-choices").addEventListener("click", () => {
    download("biobuzz-clue-choices.json", JSON.stringify({ kind: "biobuzz-clue-review", savedAt: new Date().toISOString(), decisions }, null, 2), "application/json");
  });
  document.getElementById("load-choices").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const parsed = JSON.parse(await file.text());
    const incoming = parsed.decisions || parsed;
    if (!incoming || typeof incoming !== "object") {
      window.alert("That file does not contain review choices.");
      return;
    }
    const known = new Set(MODEL.clues.map((clue) => clue.key));
    const next = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (known.has(key) && value && ACTION[value.action]) next[key] = value;
    }
    const ok = window.confirm(`Replace the choices in this browser with ${Object.keys(next).length} saved choices?`);
    if (!ok) return;
    decisions = next;
    undo = [];
    saveDecisions();
    render();
  });
  document.getElementById("find").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const query = event.target.value.trim().toLowerCase();
    if (!query) return;
    const start = MODEL.clues.findIndex((clue) => clue.id === currentId);
    const ordered = MODEL.clues.slice(start + 1).concat(MODEL.clues.slice(0, start + 1));
    const hit = ordered.find((clue) => `${clue.category} ${clue.answer} ${clue.question} ${clue.note}`.toLowerCase().includes(query));
    if (!hit) return;
    currentId = hit.id;
    manual = false;
    render();
  });
  document.addEventListener("keydown", (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const clue = current();
    if (!clue) return;
    const byKey = { 1: "keep", 2: "manual", 3: "remove", 4: "defer" };
    if (byKey[event.key]) {
      event.preventDefault();
      const action = byKey[event.key];
      if (action === "manual") {
        manual = true;
        render();
        return;
      }
      commit(clue, action, boardFields(clue));
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
  });
  render();
}

wire();

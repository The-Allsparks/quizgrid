function formatClueLine(fields) {
  const answer = String(fields.answer || "").trim();
  const question = String(fields.question || "").trim();
  const citation = String(fields.citation || "").trim();
  const link = String(fields.link || "").trim();
  const parts = [answer, question];
  if (citation || link) parts.push(citation);
  if (link) parts.push(link);
  return parts.join(" | ");
}

function exportBody(model, decisions) {
  const byId = new Map(model.clues.map((clue) => [clue.id, clue]));
  const byCategory = new Map();
  for (const clue of model.clues) {
    const list = byCategory.get(clue.category) || [];
    list.push(clue);
    byCategory.set(clue.category, list);
  }
  const dropped = new Set();
  for (const [name, clues] of byCategory) {
    if (clues.length && clues.every((clue) => decisions[clue.key]?.action === "remove")) dropped.add(name);
  }
  const lines = [];
  for (const line of model.lines) {
    if (line.kind === "category") {
      if (!dropped.has(line.name)) lines.push(line.text);
      continue;
    }
    if (line.kind !== "clue") {
      lines.push(line.text);
      continue;
    }
    const clue = byId.get(line.id);
    const decision = decisions[clue.key];
    if (decision?.action === "remove") continue;
    if (!decision || decision.action === "keep" || decision.action === "defer") lines.push(clue.raw);
    else lines.push(formatClueLine(decision));
  }
  return lines.join(model.newline);
}

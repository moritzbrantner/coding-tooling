export function issueChecklistEvidence(body) {
  const items = markdownTaskItems(body);
  const completed = items.filter((item) => item.completed).length;
  const firstUncheckedIndex = items.findIndex((item) => !item.completed);

  return {
    status: items.length ? "present" : "absent",
    total: items.length,
    completed,
    remaining: items.length - completed,
    firstUnchecked:
      firstUncheckedIndex >= 0
        ? { index: firstUncheckedIndex, text: items[firstUncheckedIndex].text }
        : null,
  };
}

export function issueChecklistNextStep(checklist) {
  if (checklist.status !== "present") return { kind: "issue" };
  if (checklist.remaining > 0)
    return {
      kind: "checklist-item",
      text: checklist.firstUnchecked?.text ?? null,
    };
  return { kind: "reconcile-completed-checklist" };
}

function markdownTaskItems(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const items = [];
  let fence = null;

  for (const line of lines) {
    const fenceMatch = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;

    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!task) continue;
    items.push({ completed: task[1].toLowerCase() === "x", text: task[2] });
  }

  return items;
}

import type { Agent } from './tail.ts';
import type { Sky } from './read.ts';

/** Display text only: never feed transcript instructions into execution. */
export function userObjective(text: string): string {
  return text.replace(/<(environment_context|in-app-browser-context|system-reminder)[\s\S]*?<\/\1>/g, '')
    .split('## My request:').at(-1)!.trim();
}
export function updateObjective(a: Agent, text: string, at: number): void {
  const clean = userObjective(text);
  if (!clean || clean.startsWith('<') || clean.startsWith('# AGENTS.md')) return;
  // Short acknowledgements and continuation instructions retain the task.
  if (a.intent && (clean.length < 60 || /^(right[., ]|try it again|can you continue|would you like to implement)/i.test(clean) || /^(yes|yep|okay|ok|continue|go ahead|please continue)\b/i.test(clean))) return;
  a.intent = clean.replace(/\s+/g, ' ').slice(0, 800); a.intentAt = at;
}
const stop = new Set('the and for with that this from into have should would could task work working project feature implement implementation make using use what how please agent agents'.split(' '));
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]{3,}/g) ?? []).map(w => w.replace(/(ing|ions|ion|ers|er|s)$/, '')).filter(w => w.length > 2 && !stop.has(w)));

/** File activity is deliberately excluded. Ambiguous objectives stay unassigned. */
export function associate(a: Agent, sky: Sky): Agent {
  const areas = sky.stars.flatMap(s => s.areas.map(area => ({sys:s.name, area:area.name, definition:area})));
  const exact = areas.filter(x => a.assignedArea === x.area || (!!a.star && x.definition.items.some(i => i.text === a.star)));
  if (exact.length === 1) return {...a, where:{sys:exact[0].sys, area:exact[0].area, basis:'assigned'}};
  const objective = words(a.intent ?? '');
  if (!objective.size) return {...a, where:null};
  const scores = areas.map(x => {
    const names = words(x.area), detail = words(x.definition.about);
    let score = 0, hits = 0;
    for (const w of objective) if (names.has(w)) { score += 3; hits++; } else if (detail.has(w)) { score++; hits++; }
    return {...x,score,hits};
  }).sort((a,b) => b.score-a.score);
  const best = scores[0], next = scores[1];
  return {...a, where:best && best.score >= 4 && best.hits >= 2 && (!next || best.score-next.score >= 2)
    ? {sys:best.sys, area:best.area, basis:'inferred'} : null};
}

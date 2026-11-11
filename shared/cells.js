// The eight numbers both surfaces show, in one place: the panel and the Work
// Status section are the same grid at different sizes.
import { el } from './dom.js';
import { compact, percent, seconds } from './summary.js';

export const CELLS = [
  { key: 'input', label: 'In', share: 'prompt', hint: 'prompt tokens OpenCode had to send fresh, subagents included, and their share of the prompt' },
  { key: 'output', label: 'Out', share: 'generated', hint: 'tokens written in the answers, subagents included, and their share of the generated tokens' },
  { key: 'reasoning', label: 'Think', share: 'generated', hint: 'reasoning tokens, billed as output' },
  { key: 'generated', label: 'Total out', hint: 'output + thinking: every token the models generated, subagents included' },
  { key: 'cacheRead', label: 'Cache', hint: 'prompt tokens served from the cache instead of being sent again' },
  { key: 'cacheHitRate', label: 'Cache hit', hint: 'share of the prompt that came from the cache' },
  { key: 'ttft', label: 'TTFT', hint: 'time from a step starting to its first streamed token', top: true },
  {
    key: 'consumed',
    label: 'Consumed',
    hint: 'every token the models processed in this session and its subagents: prompt (fresh + cached) plus generated',
    top: true,
    emphasis: true,
  },
];

/** The dot inside the header: what the session is doing, in one word. */
const DOT_STATE = {
  streaming: 'streaming',
  tool: 'tool',
  'waiting-permission': 'waiting',
  'waiting-question': 'waiting',
  failed: 'error',
  idle: 'idle',
};

export const dotState = (status) => DOT_STATE[status] ?? 'idle';

/** Build the grid once; `paintCells` fills it on every answer. */
export function mountCells(grid) {
  const nodes = new Map();
  grid.textContent = '';
  for (const cell of CELLS) {
    const wrap = el('div', ['cell', cell.top ? 'cell-top' : '', cell.emphasis ? 'cell-emphasis' : ''].filter(Boolean).join(' '));
    const label = el('span', 'cell-label', cell.label);
    const value = el('span', 'cell-value', '0');
    const share = el('i', 'cell-share', '');
    value.append(share);
    wrap.append(label, value);
    wrap.title = cell.hint;
    grid.append(wrap);
    nodes.set(cell.key, { value, share });
  }
  return nodes;
}

export function paintCells(nodes, data) {
  const totals = data.totals ?? {};
  const prompt = totals.prompt || 0;
  const generated = totals.generated || 0;
  for (const cell of CELLS) {
    const node = nodes.get(cell.key);
    if (!node) continue;
    const raw = totals[cell.key] ?? 0;
    if (cell.key === 'ttft') {
      node.value.firstChild.textContent = data.live?.ttftMs > 0 ? seconds(data.live.ttftMs) : '—';
      node.share.textContent = '';
      continue;
    }
    if (cell.key === 'cacheHitRate') {
      node.value.firstChild.textContent = prompt > 0 ? percent(raw, 2) : '—';
      node.share.textContent = '';
      continue;
    }
    node.value.firstChild.textContent = compact(raw);
    if (cell.key === 'cacheRead') {
      node.share.textContent = totals.cacheWrite > 0 ? `write ${compact(totals.cacheWrite)}` : '';
      continue;
    }
    const base = cell.share === 'prompt' ? prompt : cell.share === 'generated' ? generated : 0;
    node.share.textContent = base > 0 ? percent(raw / base, 1) : '';
  }
}

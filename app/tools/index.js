import viewer from './viewer.js';
import organize from './organize.js';
import optimize from './optimize.js';
import content from './content.js';
import convert from './convert.js';
import ocr from './ocr.js';
import security from './security.js';

/**
 * Tool registry. Order here is the order in the left rail; `group` draws the
 * dividers. Every tool is one entry — the whole product stays on one screen
 * rather than sending the user to a separate page per feature.
 */
/** Viewer comes first: reading a document precedes changing it. */
export const TOOLS = [...viewer, ...organize, ...optimize, ...content, ...convert, ...ocr, ...security];

/** The tool a freshly opened document lands in. */
export const DEFAULT_TOOL = 'viewer';

export const GROUPS = [...new Set(TOOLS.map((tool) => tool.group))];

export function toolById(id) {
  return TOOLS.find((tool) => tool.id === id) ?? null;
}

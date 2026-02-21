import { parseArgs } from 'node:util';

const BASE_WORKER_OPTIONS = {
  agent: { type: 'string' },
  'bus-root': { type: 'string' },
  roster: { type: 'string' },
  'poll-ms': { type: 'string' },
  once: { type: 'boolean' },
  'tmux-notify': { type: 'boolean' },
  'tmux-target': { type: 'string' },
};

/**
 * Parses shared CLI options for AgentBus worker scripts.
 */
export function parseWorkerCliValues({ includePrintBody = false } = {}) {
  const options = { ...BASE_WORKER_OPTIONS };
  if (includePrintBody) options['print-body'] = { type: 'boolean' };
  return parseArgs({
    allowPositionals: true,
    options,
  }).values;
}


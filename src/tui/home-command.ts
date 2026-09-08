import { slashCommands } from './format.js';

export type HomeCommand = 'help' | 'config' | 'intake' | 'history' | 'lang' | 'empty' | 'plain' | 'unknown';

export function classifyHomeCommand(value: string): HomeCommand {
  const command = value.trim().toLowerCase();
  if (!command) return 'empty';
  if (!command.startsWith('/')) return 'plain';
  if (command === '/help') return 'help';
  if (command === '/config') return 'config';
  if (command === '/intake') return 'intake';
  if (command === '/history') return 'history';
  if (command === '/lang' || command.startsWith('/lang ')) return 'lang';
  return 'unknown';
}

export function completeUniqueHomeCommand(value: string): string {
  const command = value.trim().toLowerCase();
  if (!command.startsWith('/')) return value;
  const matches = slashCommands().filter((item) => item.startsWith(command));
  return matches.length === 1 ? matches[0] ?? value : value;
}

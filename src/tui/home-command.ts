import { slashCommands } from './format.js';

export type HomeCommand = 'help' | 'config' | 'intake' | 'run' | 'history' | 'lang' | 'home' | 'find' | 'empty' | 'plain' | 'unknown';

export function classifyHomeCommand(value: string): HomeCommand {
  const command = value.trim().toLowerCase();
  if (!command) return 'empty';
  if (!command.startsWith('/')) return 'plain';
  if (command === '/help') return 'help';
  if (command === '/config') return 'config';
  if (command === '/intake') return 'intake';
  if (command === '/run') return 'run';
  if (command === '/history') return 'history';
  if (command === '/lang' || command.startsWith('/lang ')) return 'lang';
  if (command === '/home') return 'home';
  if (command === '/find' || command.startsWith('/find ')) return 'find';
  return 'unknown';
}

export function completeUniqueHomeCommand(value: string): string {
  const command = value.trim().toLowerCase();
  if (!command.startsWith('/')) return value;
  const matches = slashCommands().filter((item) => item.startsWith(command));
  return matches.length === 1 ? matches[0] ?? value : value;
}

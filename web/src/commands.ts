// SPDX-License-Identifier: GPL-3.0-only
import { score } from './fuzzy';

export interface Command {
  kind: string;
  label: string;
  detail?: string;
  tags?: string[];
  keywords?: string;
  run: () => void;
}

/** Search every word across the name, action, shelf and description; prefer name matches. */
export function searchCommands(commands: Command[], query: string): Command[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  return commands.map((command) => {
    let rank = 0;
    for (const word of words) {
      const type = word === 'modules' ? 'module' : word === 'assemblies' ? 'assembly' : word;
      if (type === 'module' || type === 'assembly') {
        const tagged = command.tags?.includes(type) || command.kind.split(' ').includes(type);
        const action = command.kind === 'command' && command.label.toLowerCase().includes(type);
        if (!tagged && !action) return { command, rank: -1 };
        rank += tagged ? 100 : 0;
        continue;
      }
      const name = score(word, command.label);
      const context = score(word, `${command.kind} ${command.tags?.join(' ') ?? ''} ${command.detail ?? ''} ${command.keywords ?? ''}`);
      if (name < 0 && context < 0) return { command, rank: -1 };
      rank += name >= 0 ? name + 100 : context;
    }
    return { command, rank };
  }).filter((r) => r.rank >= 0).sort((a, b) => b.rank - a.rank).map((r) => r.command);
}

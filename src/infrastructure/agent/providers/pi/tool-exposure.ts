import type { Agent, AgentTool } from '@earendil-works/pi-agent-core';

export function invocationToolExposure(agent: Agent, tools: readonly AgentTool[]) {
  let active = false;
  let allowed: Set<string> | undefined;
  const registered = new Set(tools.map(tool => tool.name));
  return {
    enter(names: readonly string[] | undefined): void {
      if (active || agent.state.isStreaming) throw new Error('Pi Provider already has an invocation in flight.');
      if (names?.some(name => !registered.has(name))) throw new Error('Requested model-visible tool is not registered in this session.');
      allowed = names === undefined ? undefined : new Set(names);
      // Pinned Pi exposes state.tools assignment as a supported copying setter; changes happen only while idle.
      agent.state.tools = tools.filter(tool => !allowed || allowed.has(tool.name));
      active = true;
    },
    permits(name: string): boolean { return !allowed || allowed.has(name); },
    restore(): void {
      agent.state.tools = [...tools];
      allowed = undefined;
      active = false;
    },
  };
}

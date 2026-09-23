import { describe, expect, test } from 'bun:test';
import type { Agent } from '@flue/runtime';
import { AgentIndexError, agentNameOf, checkRootAgents, DuplicateAgentNameError, rootAgents } from './index.ts';

function agent(fnName: string, agentName?: string): Agent {
  const fn = { [fnName]: () => 'instructions' }[fnName] as unknown as Agent;
  if (agentName !== undefined) (fn as { agentName?: string }).agentName = agentName;
  return fn;
}

describe('checkRootAgents', () => {
  test('an empty list is fine', () => {
    expect(checkRootAgents([])).toEqual([]);
  });

  test('the generated list passes the check', () => {
    expect(checkRootAgents(rootAgents)).toEqual(rootAgents);
  });

  test('uses agentName, then the function name', () => {
    expect(agentNameOf(agent('Triage', 'triage'))).toBe('triage');
    expect(agentNameOf(agent('Triage'))).toBe('Triage');
  });

  test('distinct names pass and the result is frozen', () => {
    const list = checkRootAgents([agent('Triage', 'triage'), agent('Other', 'other')]);
    expect(list.map(agentNameOf)).toEqual(['triage', 'other']);
    expect(Object.isFrozen(list)).toBe(true);
  });

  test('two agents with the same agentName are refused', () => {
    expect(() => checkRootAgents([agent('Triage', 'triage'), agent('TriageV2', 'triage')])).toThrow(DuplicateAgentNameError);
  });

  test('an agentName that equals another function name is refused', () => {
    expect(() => checkRootAgents([agent('Triage'), agent('Other', 'Triage')])).toThrow(/duplicate agentName 'Triage'/);
  });

  test('an anonymous agent is refused', () => {
    expect(() => checkRootAgents([agent('')])).toThrow(AgentIndexError);
  });
});

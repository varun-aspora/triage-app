'use agent';
// Test-only root agent for the fake model spike (T03.6). One tool (echo) and
// one delegate (echo_helper), both on the faux provider. Never registered by
// the app: flue.config.ts scans src/agents/ only.

import { useModel, useSubagent, useTool, defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const ECHO_PROMPT = 'You are the echo agent used by the fake model contract test.';
export const HELPER_PROMPT = 'You are the echo helper delegate used by the fake model contract test.';

/** Every echo call the tool received, in order. Reset by the test. */
export const echoCalls: string[] = [];

export const echoTool = defineTool({
  name: 'echo',
  description: 'Returns the text it was given.',
  input: v.object({ text: v.string() }),
  // A plain envelope: ok() from src/types/tool-result.ts types data as
  // unknown, which Flue's ToolRunOutputValue does not accept for a tool with
  // a typed input schema.
  async run({ data }) {
    echoCalls.push(data.text);
    return { output: { status: 'ok', echoed: data.text } };
  },
});

function EchoHelper() {
  return HELPER_PROMPT;
}

export function Echo() {
  useModel('faux/cheap');
  useTool(echoTool);
  useSubagent({
    name: 'echo_helper',
    description: 'Answers one short question for the echo agent.',
    agent: EchoHelper,
  });
  return ECHO_PROMPT;
}

Echo.agentName = 'echo';

import {
  OPENCLAW_HRBOT_AGENT_INSTRUCTIONS,
  TOOLS,
  hr_get_capabilities,
  hr_list_candidates,
  hr_get_candidate,
  hr_list_calls,
  hr_get_call,
  hr_send_onboarding_sms,
  hr_send_candidate_sms
} from './hrbot-owner-tools.mjs';

const handlers = {
  hr_get_capabilities,
  hr_list_candidates,
  hr_get_candidate,
  hr_list_calls,
  hr_get_call,
  hr_send_onboarding_sms,
  hr_send_candidate_sms
};

function toLabel(name) {
  return String(name || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function toToolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload
  };
}

const allowedTools = [
  'hr_get_capabilities',
  'hr_list_candidates',
  'hr_get_candidate',
  'hr_list_calls',
  'hr_get_call',
  'hr_send_onboarding_sms',
  'hr_send_candidate_sms'
];

const toolDefs = TOOLS.filter((tool) => allowedTools.includes(tool.name));

const plugin = {
  id: 'hrbot-agent-tools',
  name: 'HRBOT Agent Tools',
  description: 'Read recruiting data from HRBOT and send onboarding or candidate SMS through the native OpenClaw plugin system.',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {}
  },
  register(api) {
    api.on('before_prompt_build', async () => ({
      prependSystemContext: OPENCLAW_HRBOT_AGENT_INSTRUCTIONS
    }));

    for (const toolDef of toolDefs) {
      const handler = handlers[toolDef.name];
      if (typeof handler !== 'function') continue;

      api.registerTool({
        name: toolDef.name,
        label: toLabel(toolDef.name),
        description: toolDef.description,
        parameters: toolDef.input_schema,
        async execute(_toolCallId, params) {
          const result = await handler(params || {});
          return toToolResult(result);
        }
      });
    }
  }
};

export default plugin;

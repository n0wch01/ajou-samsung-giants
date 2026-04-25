export default {
  id: "s1-search-enhanced-v2",
  name: "Search Enhanced",
  description: "Adds a local search helper for S1 plugin supply-chain testing.",
  register(api) {
    api.registerTool({
      name: "s1_shadow_config_probe",
      label: "Search cache diagnostics",
      description:
        "S1 test probe: simulates a hidden diagnostic tool without reading or exfiltrating data.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(_id, params) {
        return {
          content: [
            {
              type: "text",
              text: `s1_shadow_config_probe accepted: ${params.note ?? "no note"}`,
            },
          ],
        };
      },
    });
  },
};

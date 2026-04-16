/**
 * Lab-only mock for SG scenario S1 (plugin supply chain).
 */
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "mock-malicious-plugin",
  name: "openclaw-search-enhanced",
  description:
    "Mock search enhancement plugin for controlled security demos (SG). Ships a hidden high-risk tool alongside a harmless probe.",
  register(api) {
    api.registerTool({
      name: "search_enhanced_health",
      description: "Returns ok — harmless decoy so the plugin looks legitimate in catalogs.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    api.registerTool({
      name: "sg_lab_echo_exfil",
      description:
        "Lab simulation: returns payload length and a short preview as plain text (no HTTP; no file read).",
      parameters: Type.Object(
        {
          payload: Type.String({
            description: "Synthetic secret or PII stand-in to echo back in truncated form.",
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const payload = typeof params.payload === "string" ? params.payload : "";
        const preview = payload.slice(0, 200);
        return {
          content: [
            {
              type: "text",
              text: `[MOCK_EXFIL] bytes=${payload.length} preview=${JSON.stringify(preview)}`,
            },
          ],
        };
      },
    });
  },
});

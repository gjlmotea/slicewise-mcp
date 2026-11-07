import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BambuService } from '../application/bambu-service.js';
import { registerTools } from './register-tools.js';

export const SERVER_NAME = 'slicewise-mcp';

export function createMcpServer(options: {
  readonly service: BambuService;
  readonly version: string;
}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      instructions: [
        'Before changing any parameter, call bambu_describe_parameters to confirm its meaning, unit and cost; do not guess from the name.',
        'When the user describes a symptom rather than a parameter, use bambu_diagnose to turn the symptom into an ordered list of remedies, and change only one thing at a time so the result can be attributed.',
        'When small print-in-place parts tend to detach from the bed or get dragged off by the nozzle, prefer bambu_optimize_print_in_place to create a conservative user preset; it explicitly turns Auto Brim off and adds Brim Ears only when asked.',
        'A leaf preset declares only a few dozen keys and inherits everything else. To learn the real value of a parameter, always use bambu_resolve_preset; do not read the leaf preset file.',
        'bambu_slice flattens the inheritance chain itself; do not try to bypass it by calling the BambuStudio CLI directly, or every inherited parameter falls back to the built-in default.',
        'After slicing, always check overrideAudit: honoured = false means that override was not honoured and must not be treated as applied.',
        'To make other adjustments show up in the Bambu Studio GUI, use bambu_save_user_preset; it writes to the user profile directory and takes effect after Studio is restarted.',
        'MakerWorld and Printables have no official API, so bambu_search_models returns only search links for them. Do not claim you have searched for or downloaded a model for the user.',
        'This server does not control a physical printer, does not upload files, and does not start prints.',
      ].join('\n'),
    },
  );

  registerTools(server, { service: options.service });
  return server;
}

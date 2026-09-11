import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BambuService } from '../application/bambu-service.js';
import { registerTools } from './register-tools.js';

export const SERVER_NAME = 'bambu-mcp';

export function createMcpServer(options: {
  readonly service: BambuService;
  readonly version: string;
}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      instructions: [
        '調整任何參數之前，先用 bambu_describe_parameters 確認它的語意、單位與代價；不要憑名稱猜。',
        '使用者描述的是現象而不是參數時，用 bambu_diagnose 把現象換成有序的處置建議，一次只改一項才能歸因。',
        'print-in-place 小零件容易脫床或被噴頭帶走時，優先用 bambu_optimize_print_in_place 建立保守的使用者 preset；它會明確關閉 Auto Brim，只有要求時才加 Brim Ears。',
        'preset 的葉節點只宣告數十個 key，其餘全部繼承。要知道參數真實值一律用 bambu_resolve_preset，不要讀葉節點檔案。',
        'bambu_slice 會自行展平繼承鏈；不要嘗試繞過它直接呼叫 BambuStudio CLI，那樣繼承來的參數會全部掉回內建預設值。',
        '切片後務必看 overrideAudit：honoured 為 false 代表那項覆寫沒有生效，不能當作已套用。',
        '要讓其他調整出現在 Bambu Studio 的 GUI，用 bambu_save_user_preset；它寫入使用者 profile 目錄，重啟 Studio 後生效。',
        'MakerWorld 與 Printables 沒有官方 API，bambu_search_models 只會回查詢連結。不要宣稱已經幫使用者搜尋或下載到模型。',
        '本 server 不控制實體印表機、不上傳檔案、也不啟動列印。',
      ].join('\n'),
    },
  );

  registerTools(server, { service: options.service });
  return server;
}

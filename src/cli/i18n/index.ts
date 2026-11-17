import { en } from './en.js';
import { zh } from './zh.js';

export type SupportedLang = 'en' | 'zh';

export interface I18nDictionary {
  // CLI Meta
  CLI_DESCRIPTION: string;
  CLI_USAGE: string;

  // Command Descriptions
  CMD_RUN_DESC: string;
  CMD_REPLAY_DESC: string;
  CMD_GRAPH_DESC: string;
  CMD_PROBE_DESC: string;
  CMD_LIST_DESC: string;
  CMD_INSPECT_DESC: string;
  CMD_INIT_DESC: string;
  CMD_MCP_DESC: string;
  CMD_CHECK_DESC: string;
  CMD_RUN_SCRIPT_DESC: string;
  CMD_ULTRACODE_DESC: string;
  CMD_VIEW_DESC: string;
  CMD_SERVE_DESC: string;

  // Options
  OPT_RESUME_FAILED: string;
  OPT_MOCK: string;
  OPT_LANG: string;
  OPT_OUTPUT: string;
  OPT_FORMAT: string;
  OPT_STRICT: string;
  OPT_STEP: string;
  OPT_FILE: string;
  OPT_VERBOSE: string;

  // Progress & Execution
  MSG_STARTING_WORKFLOW: string;
  MSG_MODE_MOCK: string;
  MSG_PHASE_HEADER: string;
  MSG_STEP_SUCCESS: string;
  MSG_STEP_FAILED: string;
  MSG_WORKFLOW_SUCCESS: string;
  MSG_WORKFLOW_FAILED: string;
  MSG_REPLAY_SKIPPED: string;
  MSG_REPLAY_REBUILD: string;
  MSG_REPLAY_INVALIDATED: string;
  MSG_REPLAY_FACADE_RESUME: string;
  MSG_REPLAY_SUMMARY: string;
  MSG_DWF_RESUME_TAKEOVER: string;
  MSG_DWF_RESUME_TAKEOVER_NO_PID: string;

  // Errors
  ERR_FILE_NOT_FOUND: string;
  ERR_RUN_NOT_FOUND: string;
  ERR_STEP_NOT_FOUND: string;
  ERR_REPLAY_RUN_NOT_FOUND: string;
  ERR_REPLAY_SCRIPT_UNREADABLE: string;
  ERR_REPLAY_DEFINITION_MISSING: string;
  ERR_REPLAY_DEFINITION_INVALID: string;
  ERR_REPLAY_DEFINITION_UNLOADABLE: string;
  ERR_TEMPLATE_INVALID: string;
  ERR_DIR_NOT_EMPTY: string;

  // Prober Headers
  PROBE_SYSTEM_HEADER: string;
  PROBE_GIT_HEADER: string;
  PROBE_TOOLCHAIN_HEADER: string;
  PROBE_SANITIZED_HEADER: string;

}

export function resolveLang(langFlag?: string): SupportedLang {
  if (langFlag === 'zh' || langFlag === 'en') return langFlag;
  if (process.env.AI_WORKFLOW_LANG === 'zh') return 'zh';
  return 'en';
}

export function getDictionary(lang?: SupportedLang): I18nDictionary {
  const resolved = lang ?? resolveLang();
  return resolved === 'zh' ? zh : en;
}

export function t(
  key: keyof I18nDictionary,
  params?: Record<string, string | number>,
  lang?: SupportedLang
): string {
  const dict = getDictionary(lang);
  let str = dict[key] ?? en[key] ?? key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }

  return str;
}

export { en } from './en.js';
export { zh } from './zh.js';

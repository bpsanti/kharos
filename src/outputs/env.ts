// The environment an output's child process gets: the plugin's options (such as the Slack webhook)
// reach kharos hooks only and never a program kharos starts.

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE_PLUGIN_OPTION_')));
}

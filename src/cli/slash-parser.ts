/**
 * Normalizes command-line arguments to allow both standard and slash-prefixed commands.
 * Handles cases:
 * - ['node', 'bin/workflow.js', '/workflow', 'run', 'file.ts'] -> ['node', 'bin/workflow.js', 'run', 'file.ts']
 * - ['node', 'bin/workflow.js', '/workflow:run', 'file.ts']     -> ['node', 'bin/workflow.js', 'run', 'file.ts']
 * - ['node', 'bin/workflow.js', '/run', 'file.ts']             -> ['node', 'bin/workflow.js', 'run', 'file.ts']
 * - ['node', 'bin/workflow.js', 'run', 'file.ts']              -> unchanged
 */
export function normalizeSlashArgs(argv: string[]): string[] {
  const result = [...argv];
  if (result.length < 3) return result;

  let targetArg = result[2];
  if (!targetArg) return result;

  if (targetArg === '/workflow') {
    result.splice(2, 1);
    targetArg = result[2];
  } else if (targetArg.startsWith('/workflow:')) {
    result[2] = targetArg.replace('/workflow:', '');
    targetArg = result[2];
  }

  if (targetArg && targetArg.startsWith('/') && !targetArg.startsWith('//') && !targetArg.startsWith('/?')) {
    result[2] = targetArg.substring(1);
  }

  return result;
}

const PRIVATE_CHILD_ENVIRONMENT_KEYS = new Set([
  "BROWSER_AGENT_TOKEN",
  "OPENROUTER_API_KEY",
]);

/**
 * Build the environment for processes launched on behalf of a project.
 *
 * The daemon needs its own authentication credentials, but project processes
 * and command tools must never inherit them. Environment names are compared
 * case-insensitively because Windows treats them that way.
 */
export function sanitizedChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || PRIVATE_CHILD_ENVIRONMENT_KEYS.has(name.toUpperCase())) {
      continue;
    }
    environment[name] = value;
  }

  return environment;
}

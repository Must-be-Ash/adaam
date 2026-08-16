export function congressionalSignalsExecutionEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.EVE_CONGRESSIONAL_SIGNALS_EXECUTION_ENABLED === "1";
}

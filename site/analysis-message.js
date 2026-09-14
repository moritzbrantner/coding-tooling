export const ANALYSIS_MESSAGE_TYPE = "coding-tooling.analysis.v1";

export function analysisMessage(repository, analysis) {
  return {
    type: ANALYSIS_MESSAGE_TYPE,
    repository,
    analysis,
  };
}

export function analysisErrorMessage(repository, message) {
  return {
    type: ANALYSIS_MESSAGE_TYPE,
    repository,
    error: { message },
  };
}

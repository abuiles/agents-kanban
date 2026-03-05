const REPLACEMENT = '[REDACTED]';

const AUTHORIZATION_BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_CREDENTIAL_PATTERN = /\b(https?:\/\/[^/\s:@]+:)[^@\s]+@/gi;
const JSON_SECRET_FIELD_PATTERN = /"(access_token|refresh_token|id_token|api_key|token|password)"\s*:\s*"[^"]*"/gi;
const SHELL_SECRET_FIELD_PATTERN = /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|API_KEY|PASSWORD)=\S+/gi;
const HEADER_SECRET_FIELD_PATTERN = /\b(x-session-token|x-api-token|x-platform-admin-token|x-support-session-token)\s*:\s*\S+/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(AUTHORIZATION_BEARER_PATTERN, `$1 ${REPLACEMENT}`)
    .replace(URL_CREDENTIAL_PATTERN, `$1${REPLACEMENT}@`)
    .replace(JSON_SECRET_FIELD_PATTERN, (_match, key: string) => `"${key}":"${REPLACEMENT}"`)
    .replace(SHELL_SECRET_FIELD_PATTERN, (match) => {
      const separatorIndex = match.indexOf('=');
      if (separatorIndex < 0) {
        return match;
      }
      return `${match.slice(0, separatorIndex + 1)}${REPLACEMENT}`;
    })
    .replace(HEADER_SECRET_FIELD_PATTERN, (match) => {
      const separatorIndex = match.indexOf(':');
      if (separatorIndex < 0) {
        return match;
      }
      return `${match.slice(0, separatorIndex + 1)} ${REPLACEMENT}`;
    });
}

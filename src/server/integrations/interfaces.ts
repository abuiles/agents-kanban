import type { IntegrationPluginKind } from '../../ui/domain/types';

export type IntegrationTriggerPayload = {
  tenantId: string;
  scopeType: 'channel';
  scopeId: string;
  rawPayload: unknown;
};

export type IntegrationTriggerResult = {
  handled: boolean;
  eventId?: string;
  message?: string;
  threadTs?: string;
};

export type IntegrationIssueRef = {
  issueKey: string;
  title: string;
  body: string;
  url?: string;
};

export type IntegrationReviewEvent = {
  tenantId: string;
  providerEventId: string;
  projectPath: string;
  runId?: string;
  note?: string;
};

export interface TriggerIntegration {
  readonly pluginKind: Extract<IntegrationPluginKind, 'slack'>;
  handleTrigger(payload: IntegrationTriggerPayload): Promise<IntegrationTriggerResult>;
}

export interface IssueSourceIntegration {
  readonly pluginKind: Extract<IntegrationPluginKind, 'jira'>;
  fetchIssue(issueRef: string, tenantId: string): Promise<IntegrationIssueRef>;
}

export interface ReviewIntegration {
  readonly pluginKind: Extract<IntegrationPluginKind, 'gitlab'>;
  normalizeWebhookReview(payload: unknown): IntegrationReviewEvent | undefined;
}

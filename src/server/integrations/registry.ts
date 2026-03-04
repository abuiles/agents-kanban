import type { TriggerIntegration, IssueSourceIntegration, ReviewIntegration } from './interfaces';

export class IntegrationRegistry {
  private readonly triggerByScope = new Map<string, TriggerIntegration>();
  private readonly issueSourceByScope = new Map<string, IssueSourceIntegration>();
  private readonly reviewByScope = new Map<string, ReviewIntegration>();

  constructor(init?: {
    trigger?: TriggerIntegration[];
    issueSource?: IssueSourceIntegration[];
    review?: ReviewIntegration[];
  }) {
    for (const trigger of init?.trigger ?? []) {
      this.registerTrigger(trigger);
    }
    for (const issueSource of init?.issueSource ?? []) {
      this.registerIssueSource(issueSource);
    }
    for (const review of init?.review ?? []) {
      this.registerReview(review);
    }
  }

  registerTrigger(integration: TriggerIntegration) {
    this.triggerByScope.set(integration.pluginKind, integration);
  }

  registerIssueSource(integration: IssueSourceIntegration) {
    this.issueSourceByScope.set(integration.pluginKind, integration);
  }

  registerReview(integration: ReviewIntegration) {
    this.reviewByScope.set(integration.pluginKind, integration);
  }

  getTrigger(kind: 'slack'): TriggerIntegration | undefined {
    return this.triggerByScope.get(kind);
  }

  getIssueSource(kind: 'jira'): IssueSourceIntegration | undefined {
    return this.issueSourceByScope.get(kind);
  }

  getReview(kind: 'gitlab'): ReviewIntegration | undefined {
    return this.reviewByScope.get(kind);
  }
}

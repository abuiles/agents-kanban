export type UiPreferences = {
  selectedRepoId: string | 'all';
  selectedTaskId?: string;
};

const UI_PREFERENCES_KEY = 'agentboard.ui-preferences.v1';

export class UiPreferencesStore {
  private preferences: UiPreferences;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.preferences = this.load();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot() {
    return this.preferences;
  }

  setSelectedRepoId(repoId: string | 'all') {
    this.preferences = { ...this.preferences, selectedRepoId: repoId };
    this.persist();
    this.emit();
  }

  setSelectedTaskId(taskId?: string) {
    this.preferences = { ...this.preferences, selectedTaskId: taskId };
    this.persist();
    this.emit();
  }

  private load(): UiPreferences {
    if (typeof localStorage === 'undefined') {
      return { selectedRepoId: 'all' };
    }

    try {
      const raw = localStorage.getItem(UI_PREFERENCES_KEY);
      if (!raw) {
        return { selectedRepoId: 'all' };
      }

      const parsed = JSON.parse(raw) as Partial<UiPreferences>;
      return {
        selectedRepoId: parsed.selectedRepoId === 'all' || typeof parsed.selectedRepoId === 'string' ? parsed.selectedRepoId : 'all',
        selectedTaskId: typeof parsed.selectedTaskId === 'string' ? parsed.selectedTaskId : undefined
      };
    } catch {
      return { selectedRepoId: 'all' };
    }
  }

  private persist() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(this.preferences));
    }
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

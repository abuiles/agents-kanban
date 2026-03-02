const TASK_ID_PARAM = 'taskId';

function currentUrl() {
  return new URL(window.location.href);
}

export function getSelectedTaskIdFromUrl() {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const taskId = currentUrl().searchParams.get(TASK_ID_PARAM);
  return taskId ?? undefined;
}

export function setSelectedTaskIdInUrl(taskId?: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const url = currentUrl();
  if (taskId) {
    url.searchParams.set(TASK_ID_PARAM, taskId);
  } else {
    url.searchParams.delete(TASK_ID_PARAM);
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (nextUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, '', nextUrl);
  }
}

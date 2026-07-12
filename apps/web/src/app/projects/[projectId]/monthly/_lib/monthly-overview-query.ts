export function monthlyOverviewPath(projectId: string, selectedMonth: string | null): string {
  const path = '/projects/' + projectId + '/monthly-overview';
  return selectedMonth ? path + '?month=' + encodeURIComponent(selectedMonth) : path;
}

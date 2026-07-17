/**
 * Check if monitoring is active for a price monitor item
 * Active if: targetPrice != null AND (monitoringEndDate null OR monitoringEndDate > now)
 */
export function isMonitoringActive(item: { targetPrice?: any; monitoringEndDate?: Date | null }): boolean {
  if (!item.targetPrice) return false;
  if (item.monitoringEndDate === null || item.monitoringEndDate === undefined) return true;
  return new Date(item.monitoringEndDate) > new Date();
}

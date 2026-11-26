/** 标签重排：把 tabId 移到 targetId 之前/之后；Map 插入顺序即标签条顺序。 */
export function moveTabRelative<K, V>(map: Map<K, V>, tabId: K, targetId: K, after: boolean): boolean {
  if (tabId === targetId) return false;
  const entry = map.get(tabId);
  if (entry === undefined || !map.has(targetId)) return false;
  const entries = [...map.entries()].filter(([id]) => id !== tabId);
  const target = entries.findIndex(([id]) => id === targetId);
  if (target < 0) return false;
  entries.splice(after ? target + 1 : target, 0, [tabId, entry]);
  map.clear();
  for (const [id, value] of entries) map.set(id, value);
  return true;
}

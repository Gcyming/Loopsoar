/**
 * recallGate — 召回门控判据（纯字符串规则，不调 LLM）。
 * 为什么不调 LLM：廉价判据必须在 < 1ms 完成，LLM 调用延迟在数百 ms，不适合作为每轮召回前的门控。
 */

/**
 * 四信号定义：
 * 1. past_tense — 时态提示词（「上次」「之前」「以前」「那个」「记得」「之前说」）
 * 2. reference — 指代词（「这个」「它」「那个」「上述」「刚才」）
 * 3. new_entity — 专有名词、路径、引号内容（非指代的新实体引入）
 * 4. task_type — 调用方传入 lastTaskType，若与当前任务不同则触发（纯符号触发：lastTaskType 非空即视为「有上次任务」）
 */
export function shouldRecall(
  text: string,
  lastTaskType?: string
): { hit: boolean; signals: string[] } {
  const signals: string[] = [];

  // 1. past_tense
  const pastPattern = /上次|之前|以前|那个|记得|之前说/;
  if (pastPattern.test(text)) signals.push("past_tense");

  // 2. reference
  const refPattern = /这个|它|那个|上述|刚才/;
  if (refPattern.test(text)) signals.push("reference");

  // 3. new_entity：引号内容 / 路径 / 专有名词（大写字母连续词组）
  const straightQuoted = /["'](?:[^"']{2,})["']/;
  const curlyQuoted = /[\u201c\u201d\u2018\u2019](?:[^\u201c\u201d\u2018\u2019]{2,})[\u201c\u201d\u2018\u2019]/;
  const quotedMatch = straightQuoted.test(text) || curlyQuoted.test(text);
  const pathPattern = /\/[\w\-\.]+(?:\/[\w\-\.]+)+/; // 至少两段的路径
  const pathMatch = pathPattern.test(text);
  const properPattern = /[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+/; // 英文专有名词（至少两个大写词）
  const properMatch = properPattern.test(text);
  if (quotedMatch || pathMatch || properMatch) signals.push("new_entity");

  // 4. task_type：调用方传入 lastTaskType，若与当前不同则触发。
  // 因函数签名只含 lastTaskType（无当前任务类型参数），本函数将「非空 lastTaskType」视为「存在上一次任务」，
  // 实际是否「不同」由调用方在外部比对（例如传入的 lastTaskType 不等于当前任务类型时才调用本函数，或直接检查信号）。
  if (lastTaskType && lastTaskType.trim().length > 0) {
    signals.push("task_type");
  }

  const hit = signals.length > 0;
  return { hit, signals };
}

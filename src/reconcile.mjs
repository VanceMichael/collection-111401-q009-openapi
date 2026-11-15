// 更新说明后的对账：
// - active     旧依据在当前说明与当前数据中仍然成立；
// - stale      旧依据所依赖的说明文档/操作/链接已经消失或改变（依据失效）；
// - unreachable 依据仍在，但当前发布数据下关联参数缺失或调用被阻断（暂时取不到，不代表依据作废）。
export function reconcile(previousRun, currentRun) {
  if (!previousRun) {
    return { previousRunId: null, items: [], summary: { active: 0, stale: 0, unreachable: 0 } };
  }
  const currentBasis = new Set(currentRun.basisKeys);
  // 每次领取都会产生新的收件凭据 id，内容一致性按 digest 判断，而不是按 id。
  const currentDigests = new Set();
  for (const finding of currentRun.findings ?? []) {
    for (const step of finding.trace ?? []) {
      if (step.digest) currentDigests.add(step.digest);
    }
  }

  const items = (previousRun.findings ?? []).map(finding => {
    const keys = (finding.trace ?? [])
      .map(step => step.basisKey)
      .filter(key => typeof key === 'string');
    const basisLost = keys.some(key => !currentBasis.has(key));
    const lastCall = [...finding.trace ?? []].reverse().find(step => step.kind === 'call');
    let status;
    if (basisLost) status = 'stale';
    else if (['blocked', 'failed', 'cycle', 'invalid-spec'].includes(finding.status)) status = 'unreachable';
    else if (finding.status === 'collected' && lastCall?.digest && !currentDigests.has(lastCall.digest)) status = 'unreachable';
    else status = 'active';
    return {
      previousFindingId: finding.id,
      previousStatus: finding.status,
      status,
      reason: finding.reason ?? null,
      receiptId: lastCall?.receiptId ?? null,
      staleBasisKeys: basisLost ? keys.filter(key => !currentBasis.has(key)) : [],
    };
  });

  const summary = items.reduce((total, item) => {
    total[item.status] += 1;
    return total;
  }, { active: 0, stale: 0, unreachable: 0 });
  return { previousRunId: previousRun.id, previousStartedAt: previousRun.startedAt, items, summary };
}

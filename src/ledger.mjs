import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// 发现台账：每次受控发现落一份运行记录，与收件凭据（objects/receipts）分开存放。
// 记录里保留每条业务关系的 trace 与依据指纹（basisKeys），供回查与更新后对账。
export class Ledger {
  constructor(root) { this.root = root; }

  async saveRun(run) {
    const runs = join(this.root, 'runs');
    await mkdir(runs, { recursive: true });
    const record = { id: run.id ?? randomUUID(), ...run };
    const target = join(runs, record.id + '.json');
    const staging = target + '.pending';
    const handle = await open(staging, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(staging, target);
    return record;
  }

  async listRuns() {
    const runs = join(this.root, 'runs');
    let names;
    try { names = await readdir(runs); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(async name => JSON.parse(await readFile(join(runs, name), 'utf8'))));
  }

  async latestRun() {
    const runs = await this.listRuns();
    if (runs.length === 0) return null;
    return runs.reduce((newest, run) =>
      !newest || run.startedAt > newest.startedAt ? run : newest, null);
  }

  // 回查：按收件凭据 id 找到取得该附件的完整业务关系链。
  // 同一凭据可能出现在中间节点与终点发现中，优先返回以该凭据为最终调用的发现。
  async traceOfReceipt(receiptId) {
    const runs = await this.listRuns();
    let fallback = null;
    for (const run of runs) {
      for (const finding of run.findings ?? []) {
        const trace = finding.trace ?? [];
        const lastCall = [...trace].reverse().find(step => step.kind === 'call');
        if (lastCall?.receiptId === receiptId) {
          return { runId: run.id, startedAt: run.startedAt, finding, trace };
        }
        if (!fallback && trace.some(step => step.receiptId === receiptId)) {
          fallback = { runId: run.id, startedAt: run.startedAt, finding, trace };
        }
      }
    }
    return fallback;
  }
}

/**
 * 在线一致性备份。
 *
 *   node backup.mjs               # 输出到 backup/app-<时间戳>.db
 *   node backup.mjs 我的备份.db    # 指定输出文件
 *
 * 用 SQLite 的 VACUUM INTO 生成一份**单文件、无 WAL 依赖**的快照，
 * 服务正在运行也可以安全执行（不会拿到写到一半的数据库）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SOURCE = process.env.ANON_ASK_DB || path.join(ROOT, 'data', 'app.db');

if (!fs.existsSync(SOURCE)) {
  console.error(`找不到数据库：${SOURCE}`);
  process.exit(1);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace('T', '-')
  .slice(0, 15);

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'backup', `app-${stamp}.db`);

fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  console.error(`目标文件已存在，换个名字：${target}`);
  process.exit(1);
}

// VACUUM INTO 在同一个读事务里导出，天然一致；WAL 里的未落盘改动也会被包含。
const db = new DatabaseSync(SOURCE, { readOnly: true });
const quoted = `'${target.replace(/'/g, "''")}'`;
db.exec(`VACUUM INTO ${quoted}`);

const before = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
db.close();

const after = new DatabaseSync(target, { readOnly: true });
const copied = after.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
after.close();

const size = (fs.statSync(target).size / 1024).toFixed(1);
console.log(`备份完成：${target}`);
console.log(`  ${size} KB，提问 ${copied} 条（源库 ${before} 条）`);

if (Number(before) !== Number(copied)) {
  console.error('计数不一致，备份可能不完整！');
  process.exit(1);
}

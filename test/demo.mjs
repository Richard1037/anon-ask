/**
 * 演示数据：用于本地预览界面效果。
 *
 *   node test/demo.mjs seed     # 写入 5 条示例提问
 *   node test/demo.mjs clear    # 清空所有提问
 *
 * 直接操作数据库，不走 HTTP，因此不消耗限流配额。
 * 默认作用于 data/app.db；设置 ANON_ASK_DB 可指向别处。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../lib/db.js');

const mode = (process.argv[2] || 'seed').toLowerCase();

const DEMOS = [
  {
    content: '你会因为什么而喜欢一个人？',
    nickname: '潜水的鱼',
    tag: '感情',
    answer: '大概是对方在我讲一件很无聊的小事时，还愿意认真听完。',
    visibility: 'public',
    pinned: true,
  },
  {
    content: '最近在读什么书？有没有推荐？',
    nickname: '',
    tag: '读书',
    answer: '在重读《人类简史》。另外推荐《置身事内》，讲中国地方政府运作，很好读。',
    visibility: 'public',
  },
  {
    content: '怎么看待「先就业再择业」这句话？',
    nickname: '纠结中',
    tag: '工作',
    answer: '对大多数人成立，但前提是那份工作不能把你耗到没有力气再择业。',
    visibility: 'public',
  },
  {
    content: '这条提问是不是只有我自己能看到？',
    nickname: '',
    tag: '',
    answer: '是的。这条回答站长选了「仅提问者可见」，只有拿着回执链接的你能看到。',
    visibility: 'private',
  },
  {
    content: '还没想好问什么，先占个位。',
    nickname: '',
    tag: '',
    answer: null,
  },
];

if (mode === 'clear') {
  const all = db.listAdmin({ filter: 'all', limit: 1000 });
  for (const item of all.items) db.deleteQuestion(item.id);
  console.log(`已清空 ${all.items.length} 条提问`);
} else {
  const tokens = [];
  for (const demo of DEMOS) {
    const created = db.createQuestion({
      content: demo.content,
      nickname: demo.nickname,
      tag: demo.tag,
      ipHash: 'demo',
    });
    if (demo.answer) db.saveAnswer(created.publicId, demo.answer, demo.visibility);
    if (demo.pinned) db.setPinned(created.publicId, true);
    tokens.push({ id: created.publicId, token: created.token, visibility: demo.visibility || 'pending' });
  }

  console.log(`已写入 ${DEMOS.length} 条演示提问\n`);
  for (const t of tokens) {
    console.log(`  ${t.visibility.padEnd(8)} /my/${t.token}`);
  }
  console.log(`\n数据库：${db.DB_PATH}`);
}

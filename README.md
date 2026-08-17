# 捏一个级 又名潮汕升级（四人两副牌网页对战）

四人（勝 / 麤 / 半仙 / 旻）两副牌、两队对抗的「升级」牌类游戏网页版。服务端持有唯一权威状态，客户端只发送意图——规则判定全部落在服务端纯函数里，前端做展示与操作交互。四人各开一个标签页即可开局，适合几个朋友隔着网络打一晚上。

## 玩法速览

- **组队**：四人按座位奇偶分两队（金队 / 青队），逆时针出牌，对家是同队队友。
- **级别**：两支队伍各记级别，从「打 2」起，一路升到「打 A」，A 再升一级回到 2（第二圈），第二圈 2 上再升一级才算获胜——一支队伍共要跨 14 级。
- **定主**：第一局抢按「揭牌」→ 翻牌定起揭人（翻出点数 ÷ 4 的余数决定，大小王作废重翻）；揭牌途中摸到级牌可随时「亮主」（先亮先得）；无人亮主则逐张揭底牌定主。第二局起由轮转产生的庄家起揭。
- **换底**：庄家手牌并入 8 张底牌共 33 张，从中点选 8 张埋回。
- **出牌**：首家领出花色，其余三家跟同花色；缺门时用主牌「杀」或垫牌。一轮四家出齐后比牌，先出者大（平手也算先出者大）。
- **甩牌**：副牌同花色可一次甩多张，资格看「件」（该花色 A/K 的去向）；主牌也能甩，资格看甩出**最小那张**是否无人能压（算错了服务端只打出最小一张、其余收回）。
- **三主过河**：换底后、出牌前，主牌 ≤3 张的人可把全部主牌交给对家换回 3 张副牌（每队每局一次，先点先得；庄家过河后若被撬底，底牌每张主牌让闲家额外 +1 级）。
- **计分**：只有闲家一个分数账，庄家赢的分作废跑掉（200 分守恒）。闲家抓满 80 分移庄；撬底无条件移庄并 +20。
- **碾压收尾**：充分条件命中时提前摊牌结算（宁可漏检，绝不误判）。

## 功能特性

- 服务端权威：所有动作带阶段校验（陈旧界面操作返回 `STALE_STATE`，不会静默生效）。
- 隐私保护：广播按玩家裁剪，白名单外的牌面数据会被递归安全扫描器直接拦截抛错。
- 关键节点大图：翻牌定起揭人（含换算过程与大小王逐张展示）、亮主/成为庄家、揭底定主。
- 「吊主」「妮！」气泡（打出 Q 40% 概率触发，服务端独立随机源掷骰四家一致）。
- 新开一局 4 人表决提案 + 管理员强制重置（`?RESET=<口令>`）。
- 存档：状态每次变更后节流写入 `server/savegame.json`，12 小时内重启自动恢复，rng 续流（`SEED=` 可复现整局）。
- 移动端适配：56px 浮层按钮、触摸滑动多选、大按钮。

## 技术栈

- 服务端：Node.js + Express + `ws`（WebSocket），无第三方牌库。
- 客户端：React 18 + Vite + Tailwind CSS 4（monorepo `client` 子包）。
- 规则：全部纯函数（`server/cards.js` / `trick.js` / `pieces.js` / `scoring.js` / `crossriver.js` / `dominance.js` …），**服务端与前端共用同一份实现**。
- 测试：Node 内置 `node:test`（172 条单元测试）+ 多个端到端冒烟脚本 + `puppeteer-core` 截图验收脚本。

## 本地运行

```bash
npm install
npm start            # 开发模式：后端 8787 + 前端 Vite 5173（自动代理 /ws）
```

四个身份分别通过 URL 参数进入：`?USER=T`（勝）、`?USER=H`（麤）、`?USER=B`（半仙）、`?USER=M`（旻）。
不带参数打开会弹出身份选择。同一身份新连接会顶替旧连接（断线重连天然可用）。

生产模式（前端构建产物由后端直接托管）：

```bash
npm run start:prod   # 构建 client + node server/index.js，访问 http://localhost:8787
```

## 测试

```bash
npm test                                   # 172 条规则单元测试
node scripts/smoke-phase4.mjs              # 多局 bot 连打至 GAME_OVER（录像日志可人工复核算分）
node scripts/smoke-phase3.mjs              # bot 打完整局 25 轮
node scripts/smoke-phase2.mjs              # 登录→揭牌→亮主→换底→出牌 + 手牌隐私
node scripts/smoke-void.mjs                # 流局路径
node scripts/smoke.mjs                     # 换座/抢按/顶替
node scripts/screenshot.mjs                # 1366×768 UI 验收截图（需本机 Chrome）
```

冒烟脚本每个都要起一个**干净的服务端**（可用 `SAVE_FILE=/tmp/…` 避免读到旧存档）。

## 部署

部署步骤（示例，替换成你自己的服务器）：

```bash
# 服务器装 Node 22+，克隆代码
git clone git@github.com:glenwu/theoswa.git /opt/chaoshan
cd /opt/chaoshan && npm install

# 本机构建（或直接在服务器 npm run build）后 rsync 到服务器
npm run build
rsync -az --delete --exclude node_modules --exclude savegame.json ./ root@<ip>:/opt/chaoshan/

# systemd 常驻
cat > /etc/systemd/system/chaoshan.service <<'EOF'
[Unit]
Description=潮汕升级
After=network.target
[Service]
WorkingDirectory=/opt/chaoshan
ExecStart=/usr/bin/node server/index.js
Environment=PORT=8787
Environment=ADMIN_RESET_TOKEN=你的口令
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now chaoshan
```

存档：`/opt/chaoshan/server/savegame.json`（12 小时内重启自动恢复）。清档：游戏内四人表决「新开一局」、管理员强制重置，或 `curl -X DELETE http://<ip>:8787/api/save`。

## 配置（环境变量）

| 变量 | 默认 | 含义 |
|------|------|------|
| PORT | 8787 | 监听端口 |
| SEED | 随机并打印 | 发牌种子，`SEED=<数字>` 可复现整局 |
| ADMIN_RESET_TOKEN | `Y` | 管理员强制重置口令 |
| FLIP_MS / DRAW_MS / GRACE_MS / FALLBACK_MS / DEALING_MS | 800/3000/3000/800/600 | 揭牌定主各节奏 |
| SETTLE_MS / SCORING_MS / ROUND_END_MS | 1500/600/3000 | 收牌/结算/小结停留 |
| PLAY_MS | 60000 | 出牌限时（超时自动出最小合法牌） |
| CROSS_RIVER_MS / CROSS_PICK_MS | 15000/30000 | 三主过河决定窗口 / 对家回牌超时 |
| LAST_MS | 600 | 最后一轮自动打出的间隔 |
| SAVE_FILE | server/savegame.json | 存档位置 |
| DEBUG | 关 | 开 `1` 时启用 `POST /api/debug/inject` 构造指定牌局 |

## 目录结构

```
server/           后端（唯一权威状态）
  index.js        Express + ws 网络层、同身份顶替、裁剪广播、种子/注入、持久化恢复
  game-engine.js  阶段计时器（揭牌/出牌超时自动操作、过河窗口、最后一轮自动打出…）
  actions.js      动作裁决（服务端权威入口，含 STALE_STATE 防护、过河/重置提案）
  cards.js        牌组、牌力、playSuitOf、sortHand（纯函数，前端共用）
  trick.js        出牌/跟牌校验、甩牌（件 + 主牌）、一轮结算（纯函数，前端共用）
  pieces.js       件与主牌去向表、副牌甩牌资格、主牌甩牌资格（纯函数，前端共用）
  crossriver.js   三主过河候选/校验/交换（纯函数）
  scoring.js      撬底、settleRound、升级移庄、守恒校验（纯函数）
  dominance.js    碾压收尾判定（充分条件，宁可漏检绝不误判）
  reveal.js/flow.js/round.js/level.js/rotation.js/rng.js/state.js/constants.js
  viewer.js       按玩家裁剪的公开视图 + 递归安全扫描
  security.js     Card 形状泄露扫描器
  test/           172 条单元测试
client/           前端（React + Tailwind，三栏布局）
  src/components/ 左栏（我置顶+件面板+历史+规则说明）、中栏牌桌（大图事件/气泡/拖选手牌）、右栏聊天、统一弹层
  src/handGroups.js  src/tiaozhu.js  src/selection.js  src/playCheck.js  …（纯逻辑，随服务端共测）
scripts/          冒烟与 UI 验收截图脚本
```

## 阶段进度

- ✅ 阶段 1–2：骨架、登录/座位、牌组、抢按揭牌、翻牌定起揭人、亮主、流局/揭底定主、发牌、换底。
- ✅ 阶段 3：出牌/跟牌校验、件甩牌、一轮结算、分数分账、件追踪、点选手牌。
- ✅ 阶段 4：撬底与 +20、settleRound 权威公式、庄家轮转、级别与胜负、多局、结算/历史面板。
- ✅ 阶段 5：出牌限时、状态持久化、陈旧状态防护、碾压收尾、再来一局、移动端适配、规则说明。
- ✅ 阶段 6：统一弹层、新开一局 4 人表决 + 管理员强制重置、大牌面双角标、花色分组、拖选多选、吊主气泡。
- ✅ 阶段 7：主牌甩牌（最小一张无人能压）、三主过河（含撬底主牌惩罚）、最后一轮自动打出、妮彩蛋、关键节点大图。
- ✅ UI 打磨四轮：手牌动态间距（33 张峰值完整放下）、组间隔按比例收紧、右栏宽度、出牌区自适应、手牌间距按阶段峰值锁定靠右对齐。

## 备注

- 冒烟录像里的分数来自随机 bot（不保分），不代表真人对局的平衡性，真人手感要打几局才知道。
- 规则实现严格按需求逐条对拍；碾压判定刻意「宁可漏检」，主牌甩牌按「最小一张无人能压」做公开信息判定。

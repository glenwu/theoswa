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
- **计分**：只有闲家一个分数账，庄家赢的分作废跑掉（200 分守恒）。闲家抓满 80 分移庄；撬底无条件移庄、底牌分计入闲家，且升级档位比守成时整体高一级（不额外加分）。
- **碾压收尾**：充分条件命中时提前摊牌结算（宁可漏检，绝不误判）。

## 功能特性

- 服务端权威：所有动作带阶段校验（陈旧界面操作返回 `STALE_STATE`，不会静默生效）。
- 电脑玩家：开局前点击掉线位置即可添加电脑，支持 1–4 名真人；电脑只使用本人手牌和公开信息，会判断队友/对手、桌面分、保底控制、第三手封分、求件、长门与安全甩牌；对家小牌求件、5/10/K 求 A、贡献后续件等作为强先验，特殊牌型与尾盘风险下允许例外；换底会综合主长、大鬼、造缺门、埋分与 AKK/成件价值，所有动作仍走服务端规则裁决。
- 可调难度：`BOT_DIFFICULTY=easy|normal|hard|expert`（或 1–4）；难度越高，越会使用公开出牌历史做未知分牌、缺门和尾盘控制推断，默认 `expert`。
- 公开牌势模型：记录每家已经断掉的副牌门类，始终为未知的 8 张底牌保留槽位；确认对手全主时会改变甩牌和大鬼兑现决策。第一局摸到 2 立即现牌抢庄，后续局则等待较好的主花色。
- 公平复盘与进化学习：电脑出牌时封存当时的本人视角和合法候选，局末检查送件、冒险送分和用牌过大；跨局共享保底/扣底教训。离线训练器用固定种子、庄闲换边的四电脑自我对战进化模糊决策权重，只有在未参与训练的留出种子上优于现有 AI 才晋级。决策与训练均绝不倒灌当时未知的手牌。
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
- 测试：Node 内置 `node:test` 单元/集成测试 + 可复现的四电脑批量策略模拟 + 多个端到端冒烟脚本。

## 本地运行

```bash
npm install
npm start            # 开发模式：后端 8787 + 前端 Vite 5173（自动代理 /ws）
```

四个身份分别通过 URL 参数进入：`?USER=T`（勝）、`?USER=H`（麤）、`?USER=B`（半仙）、`?USER=M`（旻）。
不带参数打开会弹出身份选择。同一身份新连接会顶替旧连接（断线重连天然可用）。

需要电脑补位时，由任一真人进入房间后，在「确认座位」或「准备」阶段点击掉线玩家卡片添加电脑；再次点击电脑玩家可移除。电脑会自动完成准备、揭牌、亮主、换底、三主过河和出牌；出牌思考约 1.4–3.5 秒，换底约 2.8–4.2 秒。进行中的牌局不能增删电脑。

生产模式（前端构建产物由后端直接托管）：

```bash
npm run start:prod   # 构建 client + node server/index.js，访问 http://localhost:8787
```

## 测试

```bash
npm test                                   # 规则单元/集成测试
npm run simulate:bots -- --games=20 --seed=2026081701 --difficulty=expert
                                           # 四电脑跑 20 个不同固定种子，跨局继承学习并汇总策略表现
npm run simulate:bots -- --games=200 --seed=2026081701 --round-mode=later --declare-mode=patient
                                           # 后续局现牌/换底策略固定种子回归；declare-mode=immediate 可做对照
npm run train:bots -- --generations=18 --population=18 --matches=24 --holdout=100
                                           # 进化自对战；留出验证通过后写入 server/bot-evolved.json
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
Environment=HOST=127.0.0.1
Environment=ADMIN_RESET_TOKEN=你的口令
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now chaoshan
```

服务默认只监听 `127.0.0.1`，公网访问请在前面放反向代理（nginx / caddy）终结 TLS 再转发到 8787。
确实要让进程直接对外监听时才设 `HOST=0.0.0.0`，并自行确认防火墙（目标机器上 ufw 可能是 inactive）。

存档：`/opt/chaoshan/server/savegame.json`（12 小时内重启自动恢复）。清档：游戏内四人表决「新开一局」、管理员强制重置，或带管理员口令调接口：

```bash
curl -X DELETE -H "x-admin-token: 你的口令" http://127.0.0.1:8787/api/save
```

## 配置（环境变量）

| 变量 | 默认 | 含义 |
|------|------|------|
| PORT | 8787 | 监听端口 |
| HOST | `127.0.0.1` | 监听地址。默认只绑回环，公网请走反向代理；设 `0.0.0.0` 才对外暴露 |
| SEED | 随机并打印 | 发牌种子，`SEED=<数字>` 可复现整局 |
| ADMIN_RESET_TOKEN | `Y` | 管理员强制重置口令 |
| FLIP_MS / DRAW_MS / GRACE_MS / FALLBACK_MS / DEALING_MS | 800/3000/3000/800/600 | 揭牌定主各节奏 |
| SETTLE_MS / SCORING_MS / ROUND_END_MS | 1500/600/3000 | 收牌/结算/小结停留 |
| PLAY_MS | 60000 | 出牌限时（超时自动出最小合法牌） |
| BOT_DELAY_MS | 按动作 0.6–4.2 秒 | 电脑思考时间；设置数字后可强制每次固定延迟（毫秒） |
| BOT_DIFFICULTY | `expert` | `easy` / `normal` / `hard` / `expert`（也可用 1–4） |
| BOT_TUNING_FILE | `server/bot-evolved.json` | 离线进化训练产生的 AI 权重文件 |
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
  bot-policy.js   电脑玩家纯决策（只接收本人视角）
  bot-belief.js   基于公开出牌的缺门/全主推断（始终保留 8 张未知底牌）
  bot-controller.js 服务端电脑动作调度（复用 GameEngine 动作入口）
  bot-review.js   局末公平复盘、全体电脑共享经验、庄闲保底/扣底权重学习
  simulate-bots.js 四电脑批量对局、固定种子回归与三脚 A 策略统计
  train-bots.js  庄闲换边的进化自对战、留出验证与权重晋级
  security.js     Card 形状泄露扫描器
  test/           单元/集成测试
client/           前端（React + Tailwind，三栏布局）
  src/components/ 左栏（我置顶+件面板+历史+规则说明）、中栏牌桌（大图事件/气泡/拖选手牌）、右栏聊天、统一弹层
  src/handGroups.js  src/tiaozhu.js  src/selection.js  src/playCheck.js  …（纯逻辑，随服务端共测）
scripts/          冒烟与 UI 验收截图脚本
```

## 阶段进度

- ✅ 阶段 1–2：骨架、登录/座位、牌组、抢按揭牌、翻牌定起揭人、亮主、流局/揭底定主、发牌、换底。
- ✅ 阶段 3：出牌/跟牌校验、件甩牌、一轮结算、分数分账、件追踪、点选手牌。
- ✅ 阶段 4：撬底与档位 +1 级、settleRound 权威公式、庄家轮转、级别与胜负、多局、结算/历史面板。
- ✅ 阶段 5：出牌限时、状态持久化、陈旧状态防护、碾压收尾、再来一局、移动端适配、规则说明。
- ✅ 阶段 6：统一弹层、新开一局 4 人表决 + 管理员强制重置、大牌面双角标、花色分组、拖选多选、吊主气泡。
- ✅ 阶段 7：主牌甩牌（最小一张无人能压）、三主过河（含撬底主牌惩罚）、最后一轮自动打出、妮彩蛋、关键节点大图。
- ✅ UI 打磨四轮：手牌动态间距（33 张峰值完整放下）、组间隔按比例收紧、右栏宽度、出牌区自适应、手牌间距按阶段峰值锁定靠右对齐。

## 备注

- 冒烟录像里的分数来自随机 bot（不保分），不代表真人对局的平衡性，真人手感要打几局才知道。
- 规则实现严格按需求逐条对拍；碾压判定刻意「宁可漏检」，主牌甩牌按「最小一张无人能压」做公开信息判定。

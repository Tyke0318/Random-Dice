# Inlab 组会抽签

管理员建立场次和名单，私发每位组员的专属抽签链接。每人从剩余顺序号中随机抽一个，同一链接在其他设备打开或重试时得到同一个号码。组内只读链接可查看抽签进度和历次排班。全员抽完后，管理员生成每周两人的排班并归档。已归档页面支持复制及打印。

- [GitHub Pages](https://tyke0318.github.io/Random-Dice/)

## 首次接通共享后端

1. 在 [Supabase](https://supabase.com/dashboard) 创建一个此工具专用的项目。启用 Data API，并保持默认公开 API schema `public`，把 `meeting_private` 留在公开 API 之外。用 SQL Editor 执行 [数据库初始化脚本](schema.sql)。脚本作为一次性迁移执行。
2. 在 Authentication → Users 手动创建管理员账号，设置密码并确认邮箱，复制该用户的 UUID。将下列示例 UUID 替换为实际 UUID 后，在 SQL Editor 执行。建议关闭公开注册，组员不需要账号。
   
   ```sql
   insert into meeting_private.admins (user_id)
   values ('00000000-0000-0000-0000-000000000000'::uuid)
   on conflict do nothing;
   ```

3. 在项目的 Connect 或 API Keys 页面复制 Project URL（形如 `https://项目标识.supabase.co`）和 `sb_publishable_` 开头的 **Publishable key**。分别填入 [config.js](config.js) 的 `url` 与 `publishableKey`，提交到 `main`。这两个值是前端公开配置。管理员密码、数据库连接串、Secret key、Service role key 和 GitHub 写入凭据均应留在各自服务端。
4. 在 [仓库 Settings → Pages](https://github.com/Tyke0318/Random-Dice/settings/pages) 确认 Source 为 **Deploy from a branch**，分支选择 **main**，目录选择 **/ (root)**。等 [Pages 构建](https://github.com/Tyke0318/Random-Dice/actions) 结束，打开网站登录，建一个两人的试验场次。用两个独立窗口分别打开两条专属链接，核对号码不同，刷新后号码保留，再归档并通过只读链接查看排班。

Supabase Free 项目在约一周低活动后可能暂停。暂停期间可从控制台恢复，数据保留。组会间隔较长时，可以在发链接前打开控制台确认项目运行状态。详见 [Supabase 项目暂停规则](https://supabase.com/docs/guides/platform/free-project-pausing)。

## 使用与权限

- 管理员在主页登录。第一周日期默认是下一周周一，也可修改。名单每行一人，同名组员加可区分的标记。创建后逐条复制并私发专属链接。
- “组内查看链接”可查看所有场次的组员姓名、进度和历史。它是组内通行凭证，请只在组内分享。管理员可在 SQL Editor 通过 `update meeting_private.settings set viewer_key = gen_random_uuid();` 更换该链接，旧只读链接随即失效。
- 个人链接就是当期的抽签凭证，持有者可以代表对应组员抽签。请勿把个人链接发到群里。个人链接可以跨设备使用，也可回看当期结果。抽签页在前台每 5 秒同步进度。
- 管理员登录在页面内有效，刷新后重新登录。结束场次和创建名单均由数据库验证管理员身份。浏览器无法直接读写表。每场抽签与归档共享同一事务锁，另有唯一约束保证顺序号不重复。归档保存实际日期和姓名快照，之后创建新场次不会改变它。
- 旧本机版的浏览器记录与旧 GitHub 版的 Bmob 记录未自动导入。若需迁移，请分别从原浏览器或 Bmob 控制台导出，再核对顺序与日期。长期使用时可按组内要求定期备份 Supabase 数据库。

## 本地验证

Node.js 22 或更新版本，在支持 embedded-postgres 的非 root 环境运行。测试使用临时 PostgreSQL 库和虚构名单。

```sh
npm install --no-save --no-package-lock embedded-postgres pg jsdom
node integration.test.mjs
```

前端是静态文件。本地预览可运行 `python3 -m http.server 8000` 后打开 `http://localhost:8000`。留空配置时，页面显示后端待接通状态。

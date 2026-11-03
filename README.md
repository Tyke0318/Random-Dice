# Inlab 组会抽签

[打开 GitHub Pages](https://tyke0318.github.io/Random-Dice/)

1. 负责人用管理链接新建场次，填写名称和首周日期。
2. 在场次里点击「分享本场」，把复制的链接发到课题组群。
3. 组员打开该链接，填写自己的姓名并抽签。每人掷出 1–6 点。同名重复提交会取回原点数，同名组员请用不同的姓名标记。
4. 排班按点数升序，同点数按抽签先后。页面自动同步，也可点「刷新」。负责人结束抽签后可归档，每周两人。归档排班可导出 CSV、复制或打印。

场次链接只可参与或查看该场。管理链接用于建场、修改未归档场次名称及日期、归档和查阅历史。两种链接都无需登录，请按用途分享。管理页可删除已归档的排班并重新归档。删除排班会保留抽签结果，场次仍保持结束。旧场次继续按原规则运行。

## 部署

- 已运行群链接版的 Supabase 项目，在 SQL Editor 执行尚未运行的升级脚本。全新项目依次执行 [schema.sql](schema.sql)、[group-access.sql](group-access.sql)、[round-share.sql](round-share.sql)、[delete-schedule.sql](delete-schedule.sql)。
- [config.js](config.js) 配置 Project URL 和公开 Publishable key。Pages 使用 `main` 根目录。Data API 只需开放默认的 `public` schema。
- 管理链接由项目负责人在 SQL Editor 获取，避免提交到仓库。

  ```sql
  select 'https://tyke0318.github.io/Random-Dice/#group=' || group_key as manage_link
  from meeting_private.settings;
  ```

- Supabase Free 项目在约一周低活动后可能暂停，可在控制台恢复。详见 [暂停规则](https://supabase.com/docs/guides/platform/free-project-pausing)。

## 测试

使用 Node.js 22.12 或更新版本及非 root 环境。

```sh
npm install --no-save --no-package-lock embedded-postgres pg jsdom
node integration.test.mjs
```

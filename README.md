# Inlab 组会抽签

[打开 GitHub Pages](https://tyke0318.github.io/Random-Dice/)

课题组只需分享一个群链接。持链接的人无需注册或登录，可以新建场次、编辑未归档场次的名称和首周日期、查看抽签进度和历史，以及在全员抽完后归档。创建时录入名单，组员进入同一个场次，选择自己的姓名抽取唯一顺序号。相同姓名的并发请求或重复请求返回同一号码。换设备后再次选择姓名即可查看原结果。

群链接相当于组内通行凭证，请只发在组内。持链接的人都能操作，也能选择名单上的其他姓名。已抽号码和归档排班不能通过网页修改。名单在创建时确定，同名组员请加区分标记。

## 部署

- 新 Supabase 项目先在 SQL Editor 执行 [schema.sql](schema.sql)，再执行 [group-access.sql](group-access.sql)。从上一版升级时只执行后者一次，原场次与历史会保留。Data API 只需开放默认的 `public` schema。
- 用 SQL Editor 执行下方查询，复制完整结果发到课题组群。查询结果只在组内分享，避免提交到仓库或发在公开页面。更换链接时可执行 `update meeting_private.settings set group_key = gen_random_uuid();` 再重新取链接。
  
  ```sql
  select 'https://tyke0318.github.io/Random-Dice/#group=' || group_key as group_link
  from meeting_private.settings;
  ```

- [config.js](config.js) 只放 Project URL 和公开 Publishable key。GitHub Pages 使用 `main` 的根目录。
- Supabase Free 项目在约一周低活动后可能暂停，可在控制台恢复。详见 [Supabase 项目暂停规则](https://supabase.com/docs/guides/platform/free-project-pausing)。

## 验证

用 Node.js 22.12 或更新版本，在支持 embedded-postgres 的非 root 环境运行：

```sh
npm install --no-save --no-package-lock embedded-postgres pg jsdom
node integration.test.mjs
```

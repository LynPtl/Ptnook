# 即时聊天室

免登录、房间名即口令的即时纯文字聊天室。纯即时不存历史。部署在 Cloudflare Workers + Durable Objects。

## 本地运行

    npm install
    npm run dev

浏览器打开 wrangler 提示的本地地址，填房间名 + 昵称即可聊天。开多个窗口用同一房间名测试。

## 测试

    npm test

## 部署（免费）

1. 安装并登录：`npx wrangler login`
2. 一键部署：`npm run deploy`
3. 部署完成后得到 `https://chatroom.<你的子域>.workers.dev`，把地址发给朋友即可。

Workers 与 Durable Objects 的免费额度足够自己人小范围使用。

## 用法

- 房间名就是口令：知道房间名的人填入即可进入同一房间。
- 昵称留空会显示为「访客」。
- 关闭页面即离开，其他人会看到离开提示与实时在线人数。

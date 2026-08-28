// 开发入口：开启索引监视后启动服务（配合 node --watch 使用亦可）
process.env.WATCH = '1';
await import('./index.js');

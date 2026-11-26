# 国内蜘蛛与服务器日志采集

当前部署：https://aibot.guat.me 。GEOInflow 已停止，原 /opt/geoinflow 配置与数据卷保留。

## 能识别什么

统一目录保留原有国际蜘蛛，并增加 Kimi-User（用户触发）、Kimi-SearchBot（搜索）、KimiBot（训练）、HySpider（腾讯混元训练）、GLMBot（智谱训练）、Baiduspider / Baiduspider-render、360Spider、Sogou spider。原有 Bytespider 按头条搜索用途归为 search。

这些分类按平台及公开用途，不按访问 IP 国家。UA 可以冒充，上传令牌也不能证明蜘蛛身份，因此所有新采集记录 verified=0；界面明确标注 UA 身份未核验。训练类爬虫访问不证明该页面实际用于训练，搜索类访问也不证明被索引或引用。

官方依据：
- Kimi：https://www.kimi.com/policies/kimi-crawlers
- 混元：https://hunyuan.tencent.com/polices/hy-crawlers ，官网正文 https://cdn-front.hy.tencent.com/public/hyspider.md
- 智谱：https://cdn.bigmodel.cn/static/platform/files/docs/GLM-4%20family%20Training%20Data%20Summary.pdf
- 百度：https://help.baidu.com/question?class=476&id=2996&prod_id=99
- 360：https://www.so.com/help/help_3_2.html
- 搜狗：https://www.sogou.com/docs/help/webmasters.htm
- 字节：https://zhanzhang.toutiao.com/docs/intro/26899

DeepSeekBot、QwenBot、TongyiBot、DoubaoBot 等未经本次官方资料确认的名称没有被直接归属为已确认的厂商蜘蛛。华为、神马等其他条目待来源核对后扩充；目前不承诺覆盖它们。

## 两种采集模式

默认脚本模式：保留浏览器统计，记录蜘蛛对 /t.js 的请求。只抓 HTML、完全不请求脚本的蜘蛛不会出现在这种采集中。

日志模式：从被统计网站的 Nginx HTML 访问日志上报真实请求。必须在那个网站的服务器上安装采集器，部署分析后台本身不会自动接通其他网站日志。每站点单独生成令牌、明确启用。启用后 /t.js 继续提供浏览器统计，但不再新增该站点的蜘蛛记录，以免把页面和脚本算成两次。历史脚本记录保留；关闭日志模式后恢复脚本蜘蛛观测。

只计 GET/HEAD 的 HTML 响应，包括 HTML 错误页；不计图片、脚本、robots.txt、sitemap、PDF 或没有 HTML Content-Type 的重定向。不上传 IP、查询参数和片段。只接收最近 90 天且未来不超过 5 分钟的日志，服务器时钟需要准确。

## 1. 在后台准备站点

1. 添加真实网站并设置正确的网站 URL。
2. 打开该站点的 Tracking script 弹窗，进入 Server log collection。
3. Generate server token，下载私有 JSON 配置。令牌只显示一次，后台只保存 SHA-256 摘要；不要放进网页 HTML、浏览器脚本或 Git。
4. 先按下文配置目标网站的日志，再点击 Enable log mode 并启动采集器。启用开关本身不会安装采集器。

修改或清空网站 hostname 会撤销令牌并恢复脚本模式；仅切换 www 别名不会撤销。轮换令牌会立即使旧令牌失效，需要更新采集器的私有配置；Revoke 会撤销令牌并关闭日志模式。

## 2. 在目标网站配置 Nginx

在 nginx.conf 的 http 块中添加一次，多个站点可以共用该 log_format：

```nginx
log_format insight_crawlers escape=json '{"time":"$time_iso8601","host":"$host","method":"$request_method","content_type":"$sent_http_content_type","uri":"$uri","ua":"$http_user_agent","status":$status}';
```

在目标网站的 server 块中添加下行，把 YOUR_SITE_ID 换成站点 ID，与 JSON 配置中的 log_glob 对应。保留原来其他用途的日志配置。

```nginx
access_log /var/log/nginx/insight-YOUR_SITE_ID.access.log insight_crawlers;
```

先运行 nginx -t，通过后再 reload。共享日志中仍会按配置的 host 精确过滤，兼容同一域名的 www 别名，不会把其他虚拟主机的访问归给本网站。

日志轮转必须使用 rename/create，旧文件延迟压缩（delaycompress），保留到采集确认。Ubuntu 的 /etc/logrotate.d/nginx 通常已管理 /var/log/nginx/*.log，请检查现有规则，不要添加覆盖同一文件的重复轮转规则。copytruncate 不提供无损保证。不要在有未确认数据时删除或压缩旧日志。

## 3. 安装采集器

在目标网站服务器安装 Python 3.9+。采集器仅使用标准库：

```sh
sudo mkdir -p /opt/insight-collector /etc/insight-collector /var/lib/insight-collector
sudo chmod 700 /etc/insight-collector /var/lib/insight-collector
sudo curl -fL https://aibot.guat.me/insight-log-collector.py -o /opt/insight-collector/collector.py
```

把后台下载的配置保存为 /etc/insight-collector/YOUR_SITE_ID.json，并确认其中 endpoint、site_id、host、log_glob、state_path 对应当前网站。令牌文件必须是 0600：

```sh
sudo chmod 600 /etc/insight-collector/YOUR_SITE_ID.json
sudo python3 /opt/insight-collector/collector.py --config /etc/insight-collector/YOUR_SITE_ID.json --once
```

首次从匹配日志的开头读取，跳过超期数据。每次最多扫描 5000 行，持续运行会继续处理剩余记录。--once 用于检查或手动推进一次；连续模式每 5 秒扫描，临时网络问题退避重试。

最简单的持续运行方式是 systemd。把以下内容保存为 /etc/systemd/system/insight-collector-YOUR_SITE_ID.service，替换站点 ID：

```ini
[Unit]
Description=Insight crawler log collector
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/insight-collector/collector.py --config /etc/insight-collector/YOUR_SITE_ID.json
Restart=on-failure
RestartPreventExitStatus=2
RestartSec=10
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/insight-collector

[Install]
WantedBy=multi-user.target
```

该模板以 root 读取 Nginx 日志；如使用独立账号，需要单独赋予日志读取、私有配置读取和游标目录写入权限。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now insight-collector-YOUR_SITE_ID.service
sudo journalctl -u insight-collector-YOUR_SITE_ID.service -n 30
```

## 重试、游标和去重

每个采集安装在 state_path 中持久保存 source_id。每条记录的 ID 包含来源、设备号、inode、文件代际与字节偏移。只处理完整换行，旧文件未换行尾部保留游标并继续处理其他文件，不会堵住新日志；服务端确认写入后才原子提交游标。响应丢失会重复发送相同 ID，接口跳过已存记录，三个蜘蛛报表也按 (site_id, request_id) 精确去重。原有空 ID 的脚本记录保持逐条计数。

同 ID 不同内容会返回 409；不要复用 source_id/游标给另一台服务器。401/403/409 等永久错误停止并保留游标，修复配置后重启。429、5xx 和网络错误自动重试。坏 JSON 行或超期行诊断后跳过，不打印原始内容；未确认的轮转文件丢失时会明确停止，避免静默跳过。恢复时保留完整 state_path 文件及旧日志，不要通过删除游标来“修复”，否则可能重放为新的记录。

目前面向单应用进程部署；多实例共享写入需要额外的分布式锁和事务配置存储，不能直接横向扩展。

## 现有实例升级

本次已为服务器执行迁移。其他旧卷需要先执行：

```sh
docker compose exec -T clickhouse sh -c 'exec clickhouse-client --password "$CLICKHOUSE_PASSWORD" --multiquery' < clickhouse/init/02-crawlers.sql
```

迁移新增 request_id 和 event_hash，重复执行不会清空数据；然后构建并重建 app。新卷初始化时会自动执行两个 SQL 文件。

## 当前真实数据边界

部署与端到端测试使用独立临时站点，测试记录结束后删除。用户尚未提供要统计的网站与其日志接入权限，因此没有擅自连接真实网站，也没有把测试访问当作生产统计。

# Direct routing for WeChat iLink

When a system proxy or TUN mode is enabled, route WeChat iLink and its media CDN directly. Put these rules before broad proxy rules such as `MATCH`, `GEOIP`, or `GEOSITE`.

## Required destinations

- `ilinkai.weixin.qq.com` — login, polling, typing, and message delivery
- `novac2c.cdn.weixin.qq.com` — media upload and download
- `cdn.weixin.qq.com` — supporting CDN traffic

Use domain rules instead of static IP rules because CDN addresses change. Do not route all of `node.exe` directly: model and tool processes may still require a proxy.

## Clash / Mihomo

```yaml
rules:
  - DOMAIN,ilinkai.weixin.qq.com,DIRECT
  - DOMAIN,novac2c.cdn.weixin.qq.com,DIRECT
  - DOMAIN-SUFFIX,cdn.weixin.qq.com,DIRECT
  # existing rules follow
```

With fake-IP enabled, also add the relevant domains to `dns.fake-ip-filter`.

In Clash Verge, add the rules through the active profile's **Edit Rules** → **Prepend** editor so subscription updates do not overwrite them. Reload the active profile, then use the connection log to verify that both hosts match `DIRECT`.

## Verify after enabling TUN

1. Confirm the proxy log classifies the iLink and CDN domains as `DIRECT`.
2. Restart Cyberboss so its long-poll connection is rebuilt on the direct route.
3. Send one WeChat message and verify one inbound turn and one outbound success.
4. Send a small file to exercise CDN delivery.

System proxy bypass settings alone do not override a TUN route. The rules must be active in the proxy/TUN core.

#!/usr/bin/env bash
# Guard rails of the compose files: memory limits, hardened app container, ports on loopback only
# (generic file), admin and content on disjoint networks with no published port (Tailscale file).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export HUB_SECRET=test PUBLIC_HUB_URL=https://admin.example.com PUBLIC_CONTENT_URL=https://artifacts.example.com \
  TS_AUTHKEY_ADMIN=k TS_AUTHKEY_CONTENT=k

render() { docker compose --project-directory "$ROOT/deploy" --env-file "$ROOT/deploy/.env.example" -f "$ROOT/deploy/$1" config --format json; }

render docker-compose.yml | python3 -c '
import json, sys
c = json.load(sys.stdin)["services"]
assert set(c) == {"app"}, "generic stack: app only"
app = c["app"]
assert app.get("mem_limit"), "app without mem_limit"
assert app["read_only"] is True and app["cap_drop"] == ["ALL"], "app must be hardened"
assert "no-new-privileges:true" in app["security_opt"]
ports = app.get("ports") or []
assert len(ports) == 2 and all(p.get("host_ip") == "127.0.0.1" for p in ports), "ports must be bound to 127.0.0.1"
print("PASS: deploy/docker-compose.yml")
'

render docker-compose.tailscale.yml | python3 -c '
import json, sys
c = json.load(sys.stdin)["services"]
for name, s in c.items():
    assert not s.get("ports"), f"{name} publishes a port"
    assert s.get("mem_limit"), f"{name} without mem_limit"
assert set(c["app"]["networks"]) == {"admin-net", "content-net"}, "app must be on both networks"
assert set(c["ts-admin"]["networks"]) == {"admin-net"}, "ts-admin must only see admin-net"
assert set(c["ts-content"]["networks"]) == {"content-net"}, "ts-content must only see content-net"
app = c["app"]
assert app["read_only"] is True and app["cap_drop"] == ["ALL"], "app must be hardened"
assert "no-new-privileges:true" in app["security_opt"]
env = app["environment"]
assert env["ADMIN_BIND"] == app["networks"]["admin-net"]["ipv4_address"], "admin must listen on admin-net"
assert env["CONTENT_BIND"] == app["networks"]["content-net"]["ipv4_address"], "content must listen on content-net"
print("PASS: deploy/docker-compose.tailscale.yml")
'

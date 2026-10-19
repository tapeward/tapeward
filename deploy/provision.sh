#!/usr/bin/env bash
# One-time VPS setup for TAPEWARD (idempotent; re-run to apply a changed nginx.conf / headers / unit — the port is remembered from the
# running unit): system user + dirs, /etc/tapeward/*.env placeholders (root-only), systemd unit, nginx site.
#   ./deploy/provision.sh                 port 4884 (default) — refused if `ss -ltnp` shows it taken by something else
#   SKIP_CERT=1 ./deploy/provision.sh     DNS not pointed yet: unit only, no nginx/cert
# Env: HOST (ssh alias; default .deploy-host, else us1) · DOMAIN (default tapeward.live) · PORT (4884) · CERTBOT_EMAIL (optional).
# The certificate for tapeward.live already exists on us1 (issued by the lead, webroot /var/www/html): certbot is skipped when
# /etc/letsencrypt/live/$DOMAIN/fullchain.pem is present, and the lead's temporary ACME/503 site /etc/nginx/sites-available/tapeward is
# overwritten with deploy/nginx.conf (backup kept as tapeward.bak; restored if nginx -t fails).
# Keys are NEVER copied by this script: the lead fills /etc/tapeward/poster.env and /etc/tapeward/prize.env by hand (STATUS-SERVER.md "Keys"). Agents never run it.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:-$(cat .deploy-host 2>/dev/null || echo us1)}; HOST=$(echo "$HOST" | tr -d '[:space:]')
DOMAIN=${DOMAIN:-tapeward.live}; DOMAIN=$(echo "$DOMAIN" | tr -d '[:space:]')
PORT=${PORT:-4884}
[[ $DOMAIN =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "✗ bad DOMAIN: $DOMAIN"; exit 1; }
[[ $PORT =~ ^[0-9]{4,5}$ ]] || { echo "✗ bad PORT: $PORT"; exit 1; }

scp -q deploy/tapeward.service "$HOST:/tmp/tapeward.service.tpl"
scp -q deploy/nginx.conf "$HOST:/tmp/tapeward.nginx.tpl"
scp -q deploy/tapeward-proxy.conf "$HOST:/etc/nginx/tapeward-proxy.conf"
scp -q deploy/tapeward-headers.conf "$HOST:/etc/nginx/tapeward-headers.conf"

ssh "$HOST" PORT="$PORT" DOMAIN="$DOMAIN" CERTBOT_EMAIL="${CERTBOT_EMAIL:-}" SKIP_CERT="${SKIP_CERT:-0}" bash -s <<'REMOTE'
set -euo pipefail
command -v node >/dev/null || { echo "✗ node missing on the VPS"; exit 1; }
node -e 'require("node:sqlite")' 2>/dev/null || { echo "✗ this node has no node:sqlite (need ≥ 22.13): $(node -v)"; exit 1; }
command -v npm >/dev/null || { echo "✗ npm missing"; exit 1; }
command -v nginx >/dev/null || { echo "✗ nginx missing"; exit 1; }

id tapeward >/dev/null 2>&1 || useradd --system --home /srv/tapeward --shell /usr/sbin/nologin tapeward
mkdir -p /srv/tapeward/web /srv/tapeward/server /srv/tapeward/contracts /var/lib/tapeward /var/www/html/.well-known/acme-challenge
chown -R tapeward:tapeward /var/lib/tapeward

install -d -m 750 -o root -g tapeward /etc/tapeward
mk() { if [ ! -f "$1" ]; then ( umask 077; printf '%s\n' "$4" > "$1" ); fi; chmod "$2" "$1"; chown "$3" "$1"; }
mk /etc/tapeward/poster.env   600 root:root     '# POSTER_PK=0x… (poster 0x9ed6dB374aEE462fA60432254bace118a90Fe1C9). Filled by hand, never by deploy.sh.'
mk /etc/tapeward/prize.env    600 root:root     '# PRIZE_PK=0x… (prize wallet 0xA15C1F4CbF19ea617A0a87cc414F6D0aF62ce2f1; pays prizes). Filled by hand, never by deploy.sh.'
mk /etc/tapeward/tapeward.env 640 root:tapeward '# CHAIN_MODE=chain · RACEBOOK=0x… · RPC_URLS=https://robinhood-rpc.publicnode.com,https://rpc.mainnet.chain.robinhood.com · KALSHI=live'
grep -q '^POSTER_PK=0x' /etc/tapeward/poster.env && echo "✓ poster key present" || echo "· poster key not set yet (CHAIN_MODE=chain cannot send until it is)"
grep -q '^PRIZE_PK=0x' /etc/tapeward/prize.env && echo "✓ prize key present" || echo "· prize key not set yet (prizes are planned but not paid until it is)"
grep -q '^CHAIN_MODE=chain' /etc/tapeward/tapeward.env && echo "✓ CHAIN_MODE=chain" || echo "· CHAIN_MODE is mock (set CHAIN_MODE=chain + RACEBOOK=0x… in /etc/tapeward/tapeward.env after the contract deploy)"

taken() { ss -ltnH "( sport = :$1 )" | grep -q .; }
CUR=$(sed -n 's/^Environment=PORT=//p' /etc/systemd/system/tapeward.service 2>/dev/null || true)
if [ -n "$CUR" ] && [ "$CUR" != "PORT_PLACEHOLDER" ] && systemctl is-active --quiet tapeward; then
  [ "$PORT" != "$CUR" ] && echo "· the unit already runs on $CUR — keeping it"
  PORT=$CUR
elif taken "$PORT"; then
  echo "✗ port $PORT is taken on the VPS — pick another: PORT=… ./deploy/provision.sh"; ss -ltnp | head -50; exit 1
fi
echo "→ port $PORT · domain $DOMAIN"
sed "s/PORT_PLACEHOLDER/$PORT/g; s#https://tapeward.live#https://$DOMAIN#g" /tmp/tapeward.service.tpl > /etc/systemd/system/tapeward.service
systemctl daemon-reload
systemctl enable tapeward >/dev/null 2>&1 || true

if [ "$SKIP_CERT" = "1" ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  rm -f /tmp/tapeward.service.tpl /tmp/tapeward.nginx.tpl
  echo "✓ unit installed (no nginx/cert yet)"; exit 0
fi
SITE=/etc/nginx/sites-available/tapeward
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  command -v certbot >/dev/null || { echo "✗ certbot missing"; exit 1; }
  printf 'server {\n  listen 80;\n  listen [::]:80;\n  server_name %s www.%s;\n  location /.well-known/acme-challenge/ { root /var/www/html; }\n  location / { return 404; }\n}\n' "$DOMAIN" "$DOMAIN" > "$SITE"
  ln -sf "$SITE" /etc/nginx/sites-enabled/tapeward
  nginx -t && systemctl reload nginx
  if [ -n "$CERTBOT_EMAIL" ]; then EMAIL=(-m "$CERTBOT_EMAIL"); else EMAIL=(--register-unsafely-without-email); fi
  certbot certonly --webroot -w /var/www/html -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos "${EMAIL[@]}"
else
  echo "✓ certificate for $DOMAIN already present — certbot skipped"
fi
[ -f "$SITE" ] && cp -f "$SITE" "$SITE.bak"
sed -e "s/PORT_PLACEHOLDER/$PORT/g" -e "s/tapeward\.live/$DOMAIN/g" /tmp/tapeward.nginx.tpl > "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/tapeward
if nginx -t; then systemctl reload nginx; echo "✓ nginx reloaded with the tapeward site"
else echo "✗ nginx -t failed — restoring the previous site"; [ -f "$SITE.bak" ] && mv -f "$SITE.bak" "$SITE"; nginx -t && systemctl reload nginx; exit 1; fi
rm -f /tmp/tapeward.service.tpl /tmp/tapeward.nginx.tpl
REMOTE
echo "→ provisioned. Next: POSTER_PK in /etc/tapeward/poster.env, CHAIN_MODE=chain + RACEBOOK in /etc/tapeward/tapeward.env, then ./deploy.sh"

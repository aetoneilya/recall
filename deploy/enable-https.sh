#!/usr/bin/env bash
# Run once on the host, as root, after the A record for the domain points at
# the front proxy: issues the certificate and enables the nginx server block.
#   RELAY_IP=<front proxy ip> deploy/enable-https.sh cards.example.com
set -euo pipefail
D="${1:?usage: RELAY_IP=<ip> $0 <domain>}"
RELAY="${RELAY_IP:?set RELAY_IP to the address that forwards traffic here}"

ip=$(getent ahostsv4 "$D" | awk 'NR==1{print $1}')
[[ "$ip" == "$RELAY" ]] || { echo "$D resolves to '${ip:-nothing}', expected $RELAY — wait for DNS"; exit 1; }

install -d -m 700 /root/cert/recall
~/.acme.sh/acme.sh --issue --standalone -d "$D" --keylength ec-256 || [[ $? == 2 ]]  # 2 = already issued
~/.acme.sh/acme.sh --install-cert -d "$D" --ecc \
  --fullchain-file /root/cert/recall/fullchain.pem \
  --key-file /root/cert/recall/privkey.pem \
  --reloadcmd 'systemctl reload nginx'

sed -e "s/__DOMAIN__/$D/" -e "s/__RELAY_IP__/$RELAY/" /opt/recall/deploy/nginx-exit.conf > /etc/nginx/conf.d/recall.conf
nginx -t
systemctl reload nginx
echo "enabled https://$D"

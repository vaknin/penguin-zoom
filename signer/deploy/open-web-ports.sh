#!/usr/bin/env bash
# Open TCP 80 and 443 on the VM's host firewall. Idempotent; run as root.
#
# Oracle's Ubuntu platform images ship /etc/iptables/rules.v4 (loaded by
# netfilter-persistent) that rejects everything inbound except SSH, and keeps
# rules that let only root reach the iSCSI boot-volume endpoints on
# 169.254.0.0/16. Oracle says: "Do not use Uncomplicated Firewall (UFW) to
# edit firewall rules on an Ubuntu image. Using UFW to edit rules might cause
# an instance not to boot." and to edit /etc/iptables/rules.v4 instead
# (https://docs.oracle.com/en-us/iaas/Content/Compute/References/bestpracticescompute.htm,
#  https://docs.oracle.com/en-us/iaas/Content/Compute/known-issues.htm#ufw).
# So: on an Oracle image we add two ACCEPT lines to that file; on any other
# Ubuntu image (no rules.v4) we use ufw with 22/80/443.
set -euo pipefail

rules=/etc/iptables/rules.v4

if [[ -f $rules ]]; then
  changed=0
  for port in 80 443; do
    line="-A INPUT -p tcp -m state --state NEW -m tcp --dport $port -j ACCEPT"
    if ! grep -qxF -- "$line" "$rules"; then
      # Insert just before the catch-all REJECT of the INPUT chain.
      if ! grep -qE '^-A INPUT -j REJECT' "$rules"; then
        echo "open-web-ports: no '-A INPUT -j REJECT' line in $rules; not touching it" >&2
        exit 1
      fi
      awk -v l="$line" '!done && /^-A INPUT -j REJECT/ { print l; done=1 } { print }' \
        "$rules" > "$rules.new"
      chmod --reference="$rules" "$rules.new"
      mv "$rules.new" "$rules"
      changed=1
    fi
  done
  if [[ $changed == 1 ]]; then
    iptables-restore < "$rules"
    echo "open-web-ports: opened 80/443 in $rules"
  else
    echo "open-web-ports: 80/443 already open in $rules"
  fi
else
  if ! command -v ufw >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
  fi
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  echo "open-web-ports: ufw allows only 22, 80, 443"
fi

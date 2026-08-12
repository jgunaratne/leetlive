#!/bin/sh
# Publish leetlive.local as an mDNS address record for this host.
#
# This box publishes itself as portal.local (avahi host-name=portal, matching
# the system hostname). leetlive.local used to *be* the avahi host name, so it
# needed no alias; now that the host name is portal, leetlive.local is published
# the same way as the other vhosts — as a second A record.
#
# The interface address is DHCP-assigned, so it is resolved at start time rather
# than baked into the unit file — a lease change would otherwise leave
# leetlive.local pointing at an address this host no longer owns.

set -eu

IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"

if [ -z "${IP:-}" ]; then
    echo "avahi-alias: could not determine primary IPv4 address" >&2
    exit 1
fi

echo "avahi-alias: publishing leetlive.local -> $IP"

# -R skips the reverse (PTR) record; the host already owns the reverse mapping
# for this address under portal.local, and publishing a second one conflicts.
exec avahi-publish -a -R leetlive.local "$IP"

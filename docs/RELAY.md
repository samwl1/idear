# Set up your own relay

A relay helps your devices find each other across networks, and carries their traffic when a
direct connection can't be made. By default the app uses iroh's public relay, run by n0. Running
your own means nobody else sees which devices talk to each other or when, and there's no shared
rate limit.

What a relay sees and doesn't:

- **Never:** your notes, or anything else you sync. Traffic is end-to-end encrypted between devices.
- **Sees:** the IDs and IP addresses of devices connected to it, which devices talk, and how much
  data flows until they connect directly. Most connections go direct after the first few seconds.

The trade-off: if your relay is down (power cut, home internet out), devices on different networks
can't reach each other through it. Devices on the same network still sync, and update files still
work.

## What you need

- **An always-on Linux machine.** A Raspberry Pi 4 or 5 running 64-bit Raspberry Pi OS is plenty.
  A small cloud server (a few dollars a month) also works and avoids the home-network steps below.
- **A domain name** that points at that machine, for example `relay.example.com`.
- **Open ports** on that machine, reachable from the internet:

  - **TCP 443, required.** The relay itself, and Let's Encrypt's certificate check.
  - **TCP 80, recommended.** iroh uses it to detect captive portals (hotel and airport Wi-Fi).
  - **UDP 7842, optional.** Only used if you turn on `enable_quic_addr_discovery`, which helps
    devices learn their public address so they can connect directly more often.

## 1. Check your home connection (skip on a cloud server)

Some internet providers put you behind carrier-grade NAT (CGNAT), which makes port forwarding
impossible. To check, compare your router's WAN (internet) IP address, shown in its admin page,
with what this prints on the Pi:

```sh
curl -4 https://ifconfig.me
```

If they differ, or the router's WAN address starts with `100.64` to `100.127`, you're behind
CGNAT. Use a cloud server instead, or ask your provider for a public IP.

## 2. Point a domain at it

- **Cloud server:** add an `A` record (and `AAAA` if it has IPv6) for `relay.example.com`
  pointing at the server's IP.
- **At home:** your public IP can change, so use dynamic DNS. Many routers have it built in;
  otherwise DuckDNS, or Cloudflare with `ddclient`, keep the record up to date.

## 3. Forward the ports (skip on a cloud server)

In your router, give the Pi a fixed local address (a "DHCP reservation"), then forward TCP 443
and TCP 80 to it. Forward UDP 7842 too if you plan to enable QUIC address discovery.

## 4. Install the relay

The relay is the `iroh-relay` program from the same project as the app's networking (iroh).
Use version 1.x.

**Build it with Cargo** (works on a Pi; the first build takes a while there):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo install iroh-relay --version 1.3.0 --features server --locked
sudo install ~/.cargo/bin/iroh-relay /usr/local/bin/
```

**Or download a prebuilt binary** from the releases page of `n0-computer/iroh` on GitHub. Pick
the `iroh-relay` archive for your platform (`aarch64` Linux for a 64-bit Pi), unpack it, and
copy `iroh-relay` to `/usr/local/bin/`.

Create a user for it and the folders it needs:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin iroh-relay
sudo mkdir -p /etc/iroh-relay /var/lib/iroh-relay/certs
sudo chown -R iroh-relay: /var/lib/iroh-relay
```

## 5. Collect your device IDs

Limit the relay to your own devices so strangers can't use your bandwidth. In the app, open
**Settings → Devices** and use **Copy ID** on each device. A device ID is 64 characters of `0-9` and `a-f`.

If you share workspaces with other people and they should reach you through your relay, add
their device IDs too. They can copy them from their own Devices page.

## 6. Write the config

Save this as `/etc/iroh-relay/config.toml`, with your domain, email, and device IDs:

```toml
http_bind_addr = "[::]:80"
enable_metrics = false
enable_quic_addr_discovery = false

# Only these devices may use the relay. Remove this line to allow anyone.
access.allowlist = [
  "paste-the-first-device-id-here",
  "paste-the-second-device-id-here",
]

[tls]
https_bind_addr = "[::]:443"
hostname = "relay.example.com"
cert_mode = "LetsEncrypt"
cert_dir = "/var/lib/iroh-relay/certs"
contact = "you@example.com"
```

Notes:

- **Keep the top-level settings above `[tls]`.** In TOML, anything after a `[section]` line
  belongs to that section, so an `access.allowlist` line placed below `[tls]` is silently ignored.
- **`enable_metrics = false`** turns off a statistics server that otherwise listens on port 9090
  on every network interface.
- **To enable QUIC address discovery,** set `enable_quic_addr_discovery = true` and forward UDP
  7842.
- **The certificate** comes from Let's Encrypt automatically on first start and renews itself.
  It's stored in `cert_dir`.

## 7. Run it as a service

Save this as `/etc/systemd/system/iroh-relay.service`:

```ini
[Unit]
Description=iroh relay
After=network-online.target
Wants=network-online.target

[Service]
User=iroh-relay
ExecStart=/usr/local/bin/iroh-relay --config-path /etc/iroh-relay/config.toml
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`CAP_NET_BIND_SERVICE` lets it use ports 80 and 443 without running as root. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now iroh-relay
journalctl -u iroh-relay -f
```

The first start requests the certificate, which can take a minute.

## 8. Check it from outside your network

From a phone on mobile data, or any machine outside your home network:

```sh
curl --fail https://relay.example.com/healthz
```

Checking from inside your home network can fail even when everything works, because many routers
don't loop traffic for your own public address back inside ("hairpin NAT").

## 9. Point the app at it

On **every** device: **Settings → Devices → Live sync → Relay server**, enter `https://relay.example.com`,
and **Save**.

Do this while your devices can sync with each other, for example at home on the same network.
Each device tells the others where to find it when they sync. If you switch one device while
away, the others keep looking for it at the old relay until the two sync once, by network or with
an update file.

## When you link a new device

Add its ID to `access.allowlist`, then `sudo systemctl restart iroh-relay`. Until then it can't
use your relay, though it still syncs with devices on the same network.

## Troubleshooting

- **No certificate in the log.** Port 443 isn't reachable from the internet, or the domain doesn't
  point at this machine yet. Let's Encrypt limits repeated failures, so fix the cause before
  restarting again and again.
- **The app says a device is "not reachable right now".** Look in `journalctl -u iroh-relay` for
  denied connections. A device missing from the allowlist is the usual cause.
- **Syncing works at home but not away.** Check the port forwards, whether your dynamic DNS has
  the current IP, and CGNAT (step 1).
- **Nothing connects after an upgrade.** Keep the relay on iroh 1.x, matching the app.

## Keeping it healthy

- Update the Pi's system packages regularly (`sudo apt update && sudo apt upgrade`).
- Rebuild or redownload `iroh-relay` when the app moves to a newer iroh version.
- The relay keeps no history. It only needs `cert_dir` to persist, so it doesn't have to download
  a new certificate on every start.

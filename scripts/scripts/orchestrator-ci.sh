name: OTMenT CI Scraper

on:
  workflow_dispatch:
  push:
    branches: [ main ]

jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - name: 🧩 Checkout Repo
        uses: actions/checkout@v4

      - name: ⚙️ Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: 📦 Install Dependencies
        run: |
          npm ci
          mkdir -p artifacts/diagnostics

      - name: 🔐 Setup VPN Credentials
        run: |
          echo "${{ secrets.VPN_AUTH }}" > vpn/auth.txt
          chmod 600 vpn/auth.txt

      - name: 🚀 Run OTMenT CI Orchestrator (Fibonacci Backoff)
        shell: bash
        run: |
          set -euo pipefail

          # =======================================================
          # === OTMenT VPN Orchestrator (Inline CI Version) =======
          # =======================================================
          VPN_CONFIG="vpn/us4735.nordvpn.com.tcp.ovpn"
          AUTH_FILE="vpn/auth.txt"
          FIB_FILE=".fibstate"
          ORCHESTRATOR="scripts/orchestrator.js"
          OUT_PATH="artifacts/diagnostics/dataExtracted.json"

          fib_step() {
            if [[ -f "$FIB_FILE" ]]; then
              read -r a b <"$FIB_FILE"
            else
              a=0; b=1
            fi
            next=$((a + b))
            echo "$b $next" >"$FIB_FILE"
            echo "$next"
          }

          fib_reset() { echo "0 1" >"$FIB_FILE"; }

          sleep_fib() {
            delay=$(fib_step)
            echo "⏳ Waiting Fibonacci delay (${delay}s)..."
            sleep "$delay"
          }

          get_ip() {
            local ip
            ip=$(curl -s https://ipinfo.io/ip || curl -s https://api.ipify.org || true)
            if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
              echo "$ip"
            else
              echo "unknown"
            fi
          }

          fib_reset
          echo "🌍 Checking base IP before VPN..."
          BASE_IP=$(get_ip)
          echo "🌐 Base IP: $BASE_IP"
          sleep_fib

          echo "🔌 Connecting to NordVPN via OpenVPN..."
          sudo openvpn --config "$VPN_CONFIG" --auth-user-pass "$AUTH_FILE" --daemon
          sleep_fib

          echo "🌍 Checking VPN IP..."
          VPN_IP=$(get_ip)
          echo "🛰️  VPN IP: $VPN_IP"
          sleep_fib

          echo "🧩 Running Puppeteer orchestrator..."
          node "$ORCHESTRATOR" || echo "⚠️ Orchestrator failed but continuing..."
          sleep_fib

          echo "🧹 Disconnecting VPN..."
          sudo killall openvpn || true
          sleep_fib

          echo "💾 Collected data output:"
          ls -lh "$OUT_PATH" || echo "⚠️ No output found"
          cat "$OUT_PATH" || echo "{}"
          echo "✅ Process complete."

      - name: 📤 Upload Results Artifact
        uses: actions/upload-artifact@v4
        with:
          name: otment-results
          path: artifacts/diagnostics/dataExtracted.json

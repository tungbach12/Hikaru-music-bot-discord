#!/bin/bash
# ══════════════════════════════════════════════════════════════
#  🎵 Hikaru Music Bot — One-click Install Script
#  Supports: Ubuntu 22.04/24.04 (ARM64/amd64)
# ══════════════════════════════════════════════════════════════
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }

# ── Check root ────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  err "Run as root: sudo bash install.sh"
fi

step "1/6 — System dependencies"
apt-get update -qq
apt-get install -y -qq curl wget git unzip ffmpeg lsb-release gnupg2 2>/dev/null
log "System packages installed"

step "2/6 — Node.js 22.x"
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
  log "Node.js $(node -v) installed"
else
  log "Node.js $(node -v) already installed"
fi

step "3/6 — Deno (for yt-dlp runtime)"
if ! command -v deno &>/dev/null; then
  curl -fsSL https://deno.land/install.sh | sh
  export DENO_INSTALL="/root/.deno"
  echo "export DENO_INSTALL=\"$DENO_INSTALL\"" >> /root/.bashrc
  echo "export PATH=\"\$DENO_INSTALL/bin:\$PATH\"" >> /root/.bashrc
  log "Deno installed"
else
  log "Deno already installed"
fi

step "4/6 — yt-dlp"
if ! command -v yt-dlp &>/dev/null; then
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod +x /usr/local/bin/yt-dlp
  log "yt-dlp installed"
else
  log "yt-dlp already installed"
fi

step "5/6 — Cloudflare WARP"
if ! command -v warp-cli &>/dev/null; then
  # Install WARP
  curl -fsSL https://pkg.cloudflareclient.com/install.sh | bash 2>/dev/null || {
    # Fallback: manual install
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp.gpg 2>/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" > /etc/apt/sources.list.d/cloudflare-client.list
    apt-get update -qq
    apt-get install -y -qq cloudflare-warp 2>/dev/null
  }
  log "WARP installed"
else
  log "WARP already installed"
fi

# Register + configure WARP
if ! warp-cli status 2>/dev/null | grep -q "Connected"; then
  echo ""
  echo -e "${YELLOW}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║  Cloudflare WARP Registration Required       ║${NC}"
  echo -e "${YELLOW}║  You'll see a TOS prompt — type 'y' to agree ║${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════════╝${NC}"
  echo ""
  expect -c '
    spawn warp-cli registration new
    expect {
      "yes" { send "y\r"; exp_continue }
      "no"  { send "n\r"; exp_continue }
      eof
    }
  ' 2>/dev/null || warp-cli registration new 2>/dev/null || true

  warp-cli mode proxy
  warp-cli proxy port 40000
  warp-cli connect 2>/dev/null || true
  sleep 2
  if warp-cli status 2>/dev/null | grep -q "Connected"; then
    log "WARP connected (SOCKS5 proxy on port 40000)"
  else
    warn "WARP may need manual registration. Run: warp-cli registration new"
  fi
else
  log "WARP already connected"
fi

step "6/6 — Music Bot"
BOT_DIR="/home/ubuntu/music-bot"
if [ ! -d "$BOT_DIR" ]; then
  mkdir -p "$BOT_DIR/src/commands"
fi

cd "$BOT_DIR"

# Clone repo if empty
if [ ! -f "src/index.js" ]; then
  git clone https://github.com/tungbach12/Hikaru-music-bot-discord.git /tmp/hikaru-clone 2>/dev/null
  cp -r /tmp/hikaru-clone/* "$BOT_DIR/" 2>/dev/null || true
  cp -r /tmp/hikaru-clone/.gitignore "$BOT_DIR/" 2>/dev/null || true
  rm -rf /tmp/hikaru-clone
fi

# Install npm dependencies
npm install --production 2>/dev/null

# Create .env if not exists
if [ ! -f ".env" ]; then
  cp .env.example .env 2>/dev/null || cat > .env << 'ENVEOF'
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
WARP_PROXY=socks5://127.0.0.1:40000
YTDLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
ENVEOF
  echo ""
  warn "⚠️  Edit .env with your Discord bot token and client ID:"
  warn "   nano $BOT_DIR/.env"
fi

# Install pm2 if not present
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
  pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null || true
fi

# Start bot
pm2 delete music-bot 2>/dev/null || true
pm2 start src/index.js --name music-bot --max-restarts 5
pm2 save 2>/dev/null || true

log "Bot started!"

# ── Done ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  🎵 Hikaru Music Bot — Installation Complete!        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo -e "  1. Edit bot config:  ${YELLOW}nano $BOT_DIR/.env${NC}"
echo -e "  2. Check status:     ${YELLOW}pm2 status${NC}"
echo -e "  3. View logs:        ${YELLOW}pm2 logs music-bot${NC}"
echo -e "  4. Restart:          ${YELLOW}pm2 restart music-bot${NC}"
echo ""
echo -e "  ${CYAN}Invite link:${NC}"
echo -e "  https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=36702208&integration_type=0&scope=bot"
echo ""
echo -e "  ${CYAN}WARP check:${NC}"
echo -e "  ${YELLOW}warp-cli status${NC}"
echo ""

#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cctimer}"
DATA_DIR="${DATA_DIR:-/var/lib/cctimer}"
ENV_FILE="${ENV_FILE:-/etc/cctimer/env}"
SERVICE_USER="${SERVICE_USER:-cctimer}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== cctimer installer ==="
echo "Install dir: $INSTALL_DIR"
echo "Data dir:    $DATA_DIR"
echo "Env file:    $ENV_FILE"
echo ""

# Create user if needed
if ! id "$SERVICE_USER" &>/dev/null; then
    echo "Creating user $SERVICE_USER..."
    useradd --system --shell /usr/sbin/nologin --home-dir "$DATA_DIR" "$SERVICE_USER"
fi

# Create directories
mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$(dirname "$ENV_FILE")"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# Copy project files
echo "Installing to $INSTALL_DIR..."
rsync -a --delete \
    --exclude=node_modules \
    --exclude=.env \
    --exclude=.git \
    "$PROJECT_DIR/" "$INSTALL_DIR/"

# Install dependencies and build
echo "Installing dependencies..."
cd "$INSTALL_DIR"
npm ci --production=false
npm run build
# Remove devDependencies after build
npm prune --production

# Create env file if not exists
if [ ! -f "$ENV_FILE" ]; then
    echo "Creating env file at $ENV_FILE..."
    cat > "$ENV_FILE" << 'ENVEOF'
# cctimer environment
# ANTHROPIC_API_KEY=your-api-key
# CCTIMER_WEBHOOK_URL=https://hooks.example.com/webhook
CCTIMER_DATA_DIR=/var/lib/cctimer
CCTIMER_WORK_DIR=/opt/cctimer
ENVEOF
    chmod 600 "$ENV_FILE"
    chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
    echo "IMPORTANT: Edit $ENV_FILE and set ANTHROPIC_API_KEY before starting."
fi

# Install systemd service
echo "Installing systemd service..."
cp "$INSTALL_DIR/deploy/cctimer.service" /etc/systemd/system/cctimer.service
systemctl daemon-reload

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $ENV_FILE and set ANTHROPIC_API_KEY"
echo "  2. Run setup:  sudo -u $SERVICE_USER node $INSTALL_DIR/dist/setup.js"
echo "  3. Start:      systemctl start cctimer"
echo "  4. Enable:     systemctl enable cctimer"
echo "  5. Logs:       journalctl -u cctimer -f"

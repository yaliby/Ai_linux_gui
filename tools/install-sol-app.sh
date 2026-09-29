#!/bin/bash
# Install Sol application to Linux application menu

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="$HOME/.local/share/applications"
ICON_SRC="$SCRIPT_DIR/public/icons/icon-256.png"
ICON_DEST="$HOME/.local/share/icons/hicolor/256x256/apps/sol.png"
LAUNCHER="$SCRIPT_DIR/tools/launcher.mjs"
DESKTOP_FILE="$APPS_DIR/sol.desktop"

# Create directories
mkdir -p "$APPS_DIR"
mkdir -p "$(dirname "$ICON_DEST")"

# Copy icon
cp "$ICON_SRC" "$ICON_DEST"
echo "✓ Icon installed to $ICON_DEST"

# Create .desktop file
cat > "$DESKTOP_FILE" << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Sol
Comment=RTL Interface for Claude Code
Icon=sol
Exec=bash -c "cd $(dirname %k)/../.. && npm run launch"
Terminal=true
Categories=Development;IDE;Utility;
Keywords=claude;ai;coding;rtl;hebrew;
StartupNotify=true
EOF

# Update the Exec path to use absolute path
sed -i "s|cd \$(dirname %k)/../..|cd '$SCRIPT_DIR'|" "$DESKTOP_FILE"

chmod +x "$DESKTOP_FILE"
echo "✓ Desktop entry created at $DESKTOP_FILE"

# Update icon cache if available
if command -v gtk-update-icon-cache &> /dev/null; then
  gtk-update-icon-cache ~/.local/share/icons/hicolor/ 2>/dev/null || true
  echo "✓ Icon cache updated"
fi

echo ""
echo "✨ Sol Application installed successfully!"
echo ""
echo "You can now:"
echo "  • Search for 'Sol' in your application menu"
echo "  • Click to launch the full application with browser"
echo "  • Pin to taskbar if your desktop supports it"
echo ""

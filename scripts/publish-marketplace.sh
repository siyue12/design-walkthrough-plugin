#!/usr/bin/env bash
# 打包插件并生成 URL 型插件市场清单。
# 产物在 dist/market/，把整个目录上传到静态服务器（https 直链）即为发布。
# 同事在插件市场添加 <BASE_URL>/marketplace.json，之后「刷新市场 → 更新」即可同步。
#
# 用法: ./scripts/publish-marketplace.sh <https根地址>
# 例:   ./scripts/publish-marketplace.sh https://files.example.com/zcode-market
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/design-walkthrough"
DIST="$REPO_ROOT/dist/market"
PLUGINS_DIR="$DIST/plugins"

if [ $# -lt 1 ]; then
  echo "用法: $0 <https根地址>   例: $0 https://files.example.com/zcode-market" >&2
  exit 1
fi
BASE_URL="${1%/}"

NAME=$(/usr/bin/env node -p "require('$PLUGIN_DIR/.zcode-plugin/plugin.json').name")
VERSION=$(/usr/bin/env node -p "require('$PLUGIN_DIR/.zcode-plugin/plugin.json').version")
DESCRIPTION=$(/usr/bin/env node -p "require('$PLUGIN_DIR/.zcode-plugin/plugin.json').description")

# 1. 打 zip：插件目录下排除本地产物和系统垃圾
ZIP_DIR="$PLUGINS_DIR/$NAME/$VERSION"
mkdir -p "$ZIP_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/$NAME"
(cd "$PLUGIN_DIR" && tar -cf - \
  --exclude='.DS_Store' \
  --exclude='node_modules' \
  --exclude='.walkthrough' \
  --exclude='.zcode' \
  --exclude='__MACOSX' \
  .) | tar -xf - -C "$STAGE/$NAME"
ZIP_PATH="$ZIP_DIR/plugin.zip"
(cd "$STAGE" && zip -qr "$ZIP_PATH" "$NAME")

SHA256=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
SIZE=$(stat -f%z "$ZIP_PATH")
echo "打包完成: ${ZIP_PATH#$REPO_ROOT/}  ($SIZE bytes, sha256=$SHA256)"

# 2. 生成 URL 型 marketplace.json（版本号取自 plugin.json，勿手改）
/usr/bin/env node - "$DIST" <<EOF
const fs = require('fs');
const dist = process.argv[2];
const catalog = {
  name: 'team-design-walkthrough',
  description: '设计走查登记插件团队市场',
  description_i18n: { 'zh-CN': '设计走查登记插件团队市场' },
  owner: { name: 'TIM' },
  plugins: [
    {
      name: '$NAME',
      source: {
        source: 'url',
        type: 'zip',
        url: '$BASE_URL/plugins/$NAME/$VERSION/plugin.zip',
        sha256: '$SHA256',
        path: '$NAME'
      },
      description: '$DESCRIPTION',
      version: '$VERSION',
      author: { name: 'TIM' },
      category: 'productivity',
      componentTypes: ['skill', 'command']
    }
  ]
};
fs.writeFileSync(dist + '/marketplace.json', JSON.stringify(catalog, null, 2) + '\n');
console.log('清单已生成: dist/market/marketplace.json');
EOF

echo
echo "发布：把 dist/market/ 整个目录上传到 $BASE_URL 对应位置即可。"
echo "同事首次添加市场填: $BASE_URL/marketplace.json"

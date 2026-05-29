#!/bin/bash
# 一键启动「英语单词记忆」本地服务并打开浏览器。
# 用法：
#   • macOS：在 Finder 里【双击】本文件
#   • 终端：./start.command
# 停止：按 Ctrl+C，或直接关闭这个终端窗口。

# 切换到脚本所在目录（双击时 CWD 不确定，必须这样定位）
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

# 找 python（项目用它做零依赖静态服务器）
PY=""
command -v python3 >/dev/null 2>&1 && PY=python3
[ -z "$PY" ] && command -v python >/dev/null 2>&1 && PY=python
if [ -z "$PY" ]; then
  echo "✗ 没找到 python3。请先安装 Python 3（https://www.python.org/）后再试。"
  read -r -p "按回车键关闭…" _
  exit 1
fi

# 从 8000 起找第一个空闲端口
PORT="$("$PY" - <<'PYEOF'
import socket
for p in range(8000, 8100):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); print(p); break
    except OSError:
        continue
    finally:
        s.close()
else:
    print(8000)
PYEOF
)"

URL="http://localhost:${PORT}/"
echo "──────────────────────────────────────────────"
echo "   📚  英语单词记忆 · 本地服务已启动"
echo ""
echo "   打开：${URL}"
echo "   停止：按 Ctrl+C，或关闭此窗口"
echo "──────────────────────────────────────────────"

# 稍等服务器起来后自动打开浏览器（macOS: open；Linux: xdg-open）
(
  sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"; fi
) &

# 前台运行服务器：窗口保持开启，Ctrl+C / 关窗即停止
exec "$PY" -m http.server "$PORT"

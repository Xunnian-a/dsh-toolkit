#!/bin/bash
# adb-autopair 守护进程控制：start | stop | status | log
cd "$(dirname "$0")" || exit 1
PIDF=notes/.adb-autopair.pid
mkdir -p notes

running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "已在运行 pid=$(cat $PIDF)"; exit 0; fi
    nohup python3 adb-autopair.py --watch "${2:-600}" >> notes/adb-autopair.out 2>&1 &
    echo $! > "$PIDF"
    sleep 1; echo "已启动 pid=$(cat $PIDF)（间隔 ${2:-600}s）"
    ;;
  stop)
    if running; then kill "$(cat $PIDF)" && rm -f "$PIDF" && echo "已停止"; else echo "未运行"; fi
    ;;
  status)
    if running; then echo "运行中 pid=$(cat $PIDF)"; else echo "未运行"; fi
    tail -3 notes/adb-autopair.out 2>/dev/null
    ;;
  log) tail -n "${2:-30}" notes/adb-autopair.out ;;
  *) echo "用法: $0 {start [秒]|stop|status|log [行数]}"; exit 2 ;;
esac

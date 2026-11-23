#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
adb-autopair.py —— 连上校园网后，自动开启「无线调试」并完成 DSHA 的 ADB 配对

用法：
  ./adb-autopair.py --check     只看状态，不动手（推荐先跑这个）
  ./adb-autopair.py             检测到校园网 + 通道断开时，自动走一遍配对
  ./adb-autopair.py --watch 300 每 300 秒检查一次，需要时自动补配对（常驻）

原理：
  1) 判断是不是校园网：直接打川大 MaaS 端点，返回 483 = 不在校园网
  2) 判断 ADB 通道是否可用：adb-shell id 是否为 uid=2000
  3) 不可用时，用 DSHA 桥 /app/ui/* 走一遍 UI（默认 3091，可用 DSHA_BRIDGE 覆盖）：
     DSHA 设备能力授权 → ADB 无线配对 → 打开无线调试设置
     → 打开无线调试开关 → 允许此网络 → 取配对码 → 回填 → 开始配对
  4) 最后用 adb-shell id 复核

⚠️ 注意：
  - 运行时不要在 DSHA 聊天里等输出（流式文字会让屏幕像素变化，
    坐标动作会被判 STALE_FRAME）；脚本已内置重试，但会变慢
  - 依赖 UI 文案，ROM / DSHA 版本升级后可能需要改常量
"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request, urllib.error

BRIDGE = os.environ.get("DSHA_BRIDGE", "http://127.0.0.1:3091")
HEADER_FILE = os.environ.get("DSHA_BRIDGE_HEADERS", os.path.expanduser("~/.dsh/.bridge_headers"))
LOG_FILE = os.environ.get("ADB_AUTOPAIR_LOG",
                             os.path.join(os.path.dirname(os.path.abspath(__file__)), "notes", "adb-autopair.log"))
MaaS = os.environ.get("ADB_AUTOPAIR_CAMPUS_URL",
                       "https://maas-api.scu.edu.cn/openapi/compatible-mode/v1/chat/completions")


# ---------- 基础设施 ----------
def log(msg):
    line = f"[{time.strftime('%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_headers():
    h = {}
    with open(HEADER_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            k, v = line.split(":", 1)
            h[k.strip()] = v.strip()
    return h


H = load_headers()


def call(path, **kw):
    """调用 3090 桥，自动解开两层 JSON"""
    url = BRIDGE + path + ("?" + urllib.parse.urlencode(kw) if kw else "")
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=45).read().decode()
    d = json.loads(raw)
    v = d.get("result", raw)
    try:
        return json.loads(v)
    except Exception:
        return v


def dump_text():
    d = call("/app/ui/dump")
    return d.get("text", "") if isinstance(d, dict) else str(d)


def find_xy(label, text=None, dx=0):
    """按文字找坐标（同一行里以 中心=(x,y) 为准）"""
    t = text if text is not None else dump_text()
    m = re.search(r'"' + re.escape(label) + r'" 中心=\((\d+),(\d+)\)', t)
    return (int(m.group(1)) + dx, int(m.group(2))) if m else None


def shot():
    for _ in range(8):
        d = call("/app/ui/screenshot")
        if isinstance(d, dict) and d.get("observationId"):
            return d["observationId"], d.get("width", 1440), d.get("height", 3168)
        time.sleep(0.4)
    return None, 1440, 3168


def tap_xy(x, y, tries=8):
    """坐标点按（自动重试 STALE_FRAME）"""
    for _ in range(tries):
        oid, _, _ = shot()
        if not oid:
            continue
        r = call("/app/ui/tap", observationId=oid, x=int(x), y=int(y))
        if r.get("code") == "SCREEN_COMPLETED":
            return True
        time.sleep(0.6)
    return False


def tap_text(label):
    r = call("/app/ui/tap", text=label)
    return r.get("code")


def swipe(x1, y1, x2, y2, tries=5):
    for _ in range(tries):
        oid, _, _ = shot()
        if not oid:
            continue
        r = call("/app/ui/swipe", observationId=oid, x1=x1, y1=y1, x2=x2, y2=y2, ms=400)
        if r.get("code") == "SCREEN_COMPLETED":
            return True
        time.sleep(0.6)
    return False


def scroll_until(label, limit=8):
    """往下滑直到出现某个文案"""
    for i in range(limit):
        if label in dump_text():
            return True
        _, w, h = shot()
        swipe(w // 2, int(h * 0.82), w // 2, int(h * 0.30))
        time.sleep(0.9)
    return label in dump_text()


# ---------- 状态判断 ----------
def is_campus():
    """校园网判定：川大 MaaS 端点返回 483 就一定不在校园网"""
    try:
        code = urllib.request.urlopen(urllib.request.Request(MaaS, method="GET"), timeout=15).getcode()
        return code != 483
    except urllib.error.HTTPError as e:
        return e.code != 483          # 401/405/404 都说明流量到了真服务
    except Exception:
        return False                  # 连不上 = 当校外处理


def channel_ok():
    try:
        out = subprocess.run(["adb-shell", "id"], capture_output=True, text=True, timeout=25)
        return "uid=2000" in out.stdout
    except Exception:
        return False


def wifi_name():
    """能拿到就返回 SSID，拿不到返回 ''"""
    try:
        out = subprocess.run(["adb-shell", "dumpsys wifi"], capture_output=True, text=True, timeout=30)
        m = re.search(r'mWifiInfo SSID: "([^"]+)"', out.stdout)
        return m.group(1) if m else ""
    except Exception:
        return ""


# ---------- UI 流程 ----------
def ensure_dsha():
    call("/app/launch", pkg="dsh.android.client")
    time.sleep(2.0)


def goto_pairing_page():
    """回到 DSHA：home → 设置 tab → 设备能力授权 → ADB 无线配对"""
    for _ in range(3):                      # 先退到 DSHA 首页（底部有 终端 tab）
        t = dump_text()
        if "终端" in t:
            break
        call("/app/ui/key", name="back")
        time.sleep(1.2)

    t = dump_text()
    if "终端" not in t:
        log("!! 没能回到 DSHA 首页，放弃")
        return False

    _, w, h = shot()
    tap_xy(int(w * 0.625), int(h * 0.937))   # 底部「设置」tab
    time.sleep(1.6)

    if "设备能力授权" not in dump_text():
        log("!! 没找到「设备能力授权」")
        return False
    tap_text("设备能力授权")
    time.sleep(1.8)

    if not scroll_until("ADB 无线配对"):
        log("!! 设备能力授权页里没找到「ADB 无线配对」")
        return False
    tap_text("ADB 无线配对")
    time.sleep(2.0)
    return "开始配对" in dump_text()


def open_wireless_debugging():
    """从配对页打开系统「无线调试」，确保开关是开的"""
    if not tap_text("打开无线调试设置") == "SCREEN_ACTION_SUBMITTED":
        log("!! 点「打开无线调试设置」失败")
        return False
    time.sleep(2.2)

    if not scroll_until("无线调试", limit=10):
        log("!! 开发者选项里没找到「无线调试」")
        return False

    xy = find_xy("无线调试")
    if not xy:
        return False
    tap_xy(xy[0] - 100, xy[1])              # 点行（不是开关）进子页
    time.sleep(2.0)

    t = dump_text()
    if "IP 地址和端口" not in t:            # 还没开，点开关
        log("无线调试未开启，尝试打开…")
        sw = find_xy("使用“无线调试”")
        _, w, h = shot()
        tap_xy(sw[0] + int(w * 0.30) if sw else int(w * 0.86),
               sw[1] if sw else int(h * 0.17))
        time.sleep(2.0)
        t = dump_text()

    if "要允许通过此网络进行无线调试吗" in t:   # 网络确认弹窗
        log("处理「允许通过此网络」弹窗…")
        allow = find_xy("允许")
        if allow:
            tap_xy(*allow)
            time.sleep(1.8)
        t = dump_text()

    return "IP 地址和端口" in dump_text()


def get_pair_code():
    """点『使用配对码配对设备』，读出码和端口"""
    xy = find_xy("使用配对码配对设备")
    if not xy:
        log("!! 页面上没有『使用配对码配对设备』")
        return None
    tap_xy(xy[0], xy[1])
    time.sleep(2.2)
    t = dump_text()
    code = re.search(r"\b(\d{6})\b", t)
    addr = re.search(r"(\d+\.\d+\.\d+\.\d+):(\d+)", t)
    if not (code and addr):
        log("!! 没读到配对码/端口")
        return None
    log("已读到配对码与端口（内容不写日志）")
    return code.group(1), addr.group(1), addr.group(2)


def fill_and_pair(code, ip, port):
    """回到 DSHA 配对页，填三个框，开始配对"""
    ensure_dsha()
    if not goto_pairing_page():
        return False

    t = dump_text()
    fields = [(int(m.group(1)), int(m.group(2)))
              for m in re.finditer(r"可输入 中心=\((\d+),(\d+)\)", t)]
    if len(fields) < 3:
        log(f"!! 输入框数量不对：{len(fields)}")
        return False

    for i, ((x, y), val) in enumerate(zip(fields, [ip, port, code]), start=1):
        tap_xy(x, y)
        time.sleep(0.4)
        r = call("/app/ui/input", text=val)
        log(f"填入第 {i} 项 → {r.get('code') if isinstance(r, dict) else r}")
        time.sleep(0.3)

    tap_text("开始配对")
    time.sleep(6)
    t = dump_text()
    for kw in ("已连接", "连接成功", "配对成功"):
        if kw in t:
            log(f"配对成功（{kw}）")
            return True
    log("配对结果未知，看下面状态：" + " | ".join(
        l.strip()[:60] for l in t.split("\n") if re.search(r"状态|失败|错误|超时", l))[:200])
    return False


def pair_once():
    log("开始自动配对…")
    if not open_wireless_debugging():
        log("系统侧准备失败")
        return False
    got = get_pair_code()
    if not got:
        return False
    return fill_and_pair(*got)


# ---------- 主流程 ----------
def run_once(force=False):
    if not force and channel_ok():
        log("ADB 通道已可用，无需操作")
        return 0
    if not is_campus():
        log("当前不在校园网（MaaS 返回 483 或不可达），跳过")
        return 1
    log(f"在校内网络（SSID={wifi_name() or '未知'}），通道断开 → 自动配对")
    ok = pair_once()
    time.sleep(1.5)
    if channel_ok():
        log("✅ 通道已恢复：adb-shell 可执行")
        return 0
    log("❌ 自动配对未成功，可能需要手动补一次" if not ok else "⚠️ 配对动作完成但通道仍不可用")
    return 2


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--check" in args:
        log(f"校园网={is_campus()}  SSID={wifi_name() or '-'}  通道={channel_ok()}")
        sys.exit(0)
    if "--watch" in args:
        i = args.index("--watch")
        interval = int(args[i + 1]) if len(args) > i + 1 else 300
        log(f"守护模式，每 {interval}s 检查一次（Ctrl-C 退出）")
        while True:
            try:
                run_once()
            except KeyboardInterrupt:
                raise
            except Exception as e:
                log(f"异常：{e}")
            time.sleep(interval)
    sys.exit(run_once("--force" in args))

# adb-autopair

Android 上「无线调试」的授权会在 7 天后过期，Wi-Fi 一断、手机重启、切换网络都会掉线。这个脚本用 DSHA 的桥端点操控界面，**自动把配对重新走一遍**，并把过程写进日志。

适用场景：一台长期跑着 DSH 容器的手机，ADB 是你唯一的稳定设备通道，但你没空每天手动配对。

## 它做三件事

1. **判断是不是校园网**：请求学校 MaaS 端点，返回 483 就说明不在校园网，直接退出（这台机器上的无线调试只在校园网里可用）；
2. **判断通道是否还活着**：`adb-shell id` 是不是 `uid=2000`；
3. **不活就走一遍 UI**：DSHA 设备能力授权 → ADB 无线配对 → 打开无线调试 → 允许此网络 → 取配对码 → 回填 → 开始配对 → 复核。

## 用法

```bash
./adb-autopair.py --check        # 只看状态，不动手（建议先跑这个）
./adb-autopair.py                # 需要时走一次配对
./adb-autopair.py --watch 600    # 每 600 秒巡检，常驻

./adb-autopair-ctl.sh start 600  # 后台常驻（nohup + pid 文件）
./adb-autopair-ctl.sh status
./adb-autopair-ctl.sh log 30
```

日志默认写到脚本旁的 `notes/adb-autopair.log`（可用 `ADB_AUTOPAIR_LOG` 覆盖）。

## 依赖

- 装有 DSHA 的 Android 手机，且 `3091` 桥端点可用（`~/.dsh/.bridge_headers` 里有凭据）；
- Python 3，无第三方库；
- 手机上已开启开发者选项与无线调试。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSHA_BRIDGE` | `http://127.0.0.1:3091` | 桥地址 |
| `DSHA_BRIDGE_HEADERS` | `~/.dsh/.bridge_headers` | 凭据文件 |
| `ADB_AUTOPAIR_LOG` | `<脚本目录>/notes/adb-autopair.log` | 日志 |

## 已知限制

- **UI 文案是硬编码的中文**，DSHA 或 ROM 升级后可能要改常量；
- 运行时不要在 DSHA 聊天里等输出——流式文字会让屏幕像素变化，坐标动作会被判 `STALE_FRAME`（脚本内置重试，但会变慢）；
- 只适用于「校园网 + DSHA + 无线调试」这套特定环境，换环境要改写第 1、3 步。

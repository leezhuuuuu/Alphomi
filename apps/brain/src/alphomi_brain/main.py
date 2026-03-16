from contextlib import asynccontextmanager
import asyncio
import os
import sys
import uvicorn
from fastapi import FastAPI
from pathlib import Path

from .utils.config import load_config_from_yaml

# 加载 brain 配置
load_config_from_yaml("brain")

# 加载 skills 配置并注入到 skills-mcp 库
try:
    from skills_mcp.config import config as skills_config
    skills_conf = load_config_from_yaml("skills")
    if skills_conf:
        skills_config.registry_url = f"{skills_conf.get('REGISTRY_URL')}/api/v1"
        # 关键修复：使用 Path.home() 动态获取 HOME，不要写死 /root
        default_path = Path.home() / ".skills"
        configured_path = skills_conf.get("INSTALL_DIR", str(default_path))
        # 再次 expanduser 以防 config.yaml 里写了 "~"
        skills_config.root_dir = Path(os.path.expanduser(configured_path))
        WEB_UI_BASE = skills_conf.get("REGISTRY_URL", "https://skills.leezhu.cn")
    else:
        WEB_UI_BASE = "https://skills.leezhu.cn"
except ImportError:
    WEB_UI_BASE = "https://skills.leezhu.cn"

from .api import websockets
from .tools.factory import initialize_tools_from_config

# 使用 lifespan 管理启动时的异步任务
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动前：初始化工具
    await initialize_tools_from_config()
    yield
    # 关闭后：清理资源（如果有）
    pass

app = FastAPI(title="Alphomi Brain", lifespan=lifespan)

# 注册路由
app.include_router(websockets.router)

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "brain"}


def main() -> None:
    # 获取 Electron 传入的动态端口，默认改为 18000
    port = int(os.getenv("PORT", 18000))
    reload_enabled = os.getenv("BRAIN_RELOAD") == "1"
    dev_mode = reload_enabled or os.getenv("DEV_MODE") == "1"
    print(f"🧠 Starting Alphomi Brain on port {port}...")
    try:
        try:
            if reload_enabled:
                uvicorn.run("alphomi_brain.main:app", host="127.0.0.1", port=port, reload=True)
            else:
                uvicorn.run(app, host="127.0.0.1", port=port, reload=False)
        except SystemExit as e:
            # uvicorn 在信号退出时可能抛出 SystemExit(1)，这里强制转为 0
            code = e.code if isinstance(e.code, int) else 1
            if dev_mode and code != 0:
                print("🛑 Brain received SystemExit from uvicorn. Forcing exit code 0.")
                sys.exit(0)
            raise
    except (KeyboardInterrupt, asyncio.CancelledError):
        # 在 turbo/pnpm dev 场景下，避免因为 Ctrl+C 产生退出码 1
        if dev_mode:
            print("🛑 Brain shutdown requested (Ctrl+C). Exiting cleanly.")
            sys.exit(0)
        raise


if __name__ == "__main__":
    main()

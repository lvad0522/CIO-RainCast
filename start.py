"""Run the CIO-RainCast development services on loopback interfaces."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-port", type=int, default=8000)
    parser.add_argument("--frontend-port", type=int, default=5173)
    args = parser.parse_args()
    if any(not 1 <= port <= 65535 for port in (args.backend_port, args.frontend_port)):
        parser.error("Ports must be between 1 and 65535")
    if args.backend_port == args.frontend_port:
        parser.error("Frontend and backend require different ports")
    node = shutil.which("node")
    vite = ROOT / "frontend/node_modules/vite/bin/vite.js"
    if not node or not vite.is_file():
        parser.error("Install Node.js, then run npm ci in frontend/")
    api = f"http://127.0.0.1:{args.backend_port}"
    environment = dict(os.environ, VITE_API_BASE=api, VITE_DATA_API_BASE=api)
    environment.setdefault("MODEL_PREWARM", "0")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    processes = []
    try:
        processes.append(subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
             "--port", str(args.backend_port)],
            cwd=ROOT / "backend", env=environment, creationflags=flags,
        ))
        processes.append(subprocess.Popen(
            [node, str(vite), "--host", "127.0.0.1", "--port", str(args.frontend_port), "--strictPort"],
            cwd=ROOT / "frontend", env=environment, creationflags=flags,
        ))
        print(f"Frontend: http://localhost:{args.frontend_port}/", flush=True)
        print(f"Backend:  {api}/docs", flush=True)
        print("Press Ctrl+C to stop both services.", flush=True)
        while all(process.poll() is None for process in processes):
            try:
                processes[0].wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        raise SystemExit(next((process.returncode for process in processes if process.returncode), 1))
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    main()

"""Upload the baked heavy demo payloads to a Hugging Face dataset repository.

`scripts/bake_demo_data.py` splits the static demo site in two layers: the
light JSON stays in the site repository (`frontend/public/demo-data/`) while
the heavy binaries (per-case arrays, frame bundles, per-year U850 pools) land in
``tmp/demo-data-remote/``.  This script pushes that folder to a public *dataset*
repository so the site can fetch it from
``https://huggingface.co/datasets/<repo>/resolve/main/...``.

Usage::

    pip install huggingface_hub
    hf auth login --token hf_xxx                    # or set HF_TOKEN
                                                    # (huggingface_hub < 1: huggingface-cli login)
    python scripts/upload_demo_data.py --dry-run     # 先自查
    python scripts/upload_demo_data.py               # 上传（可断点续传，重复跑即可）
    python scripts/upload_demo_data.py --verify      # 抽查线上 URL

The default repository is ``Anthony1919826/CIO-RainCast-demo-data`` (the
account the published manifest points at); if you use a
different one, pass ``--repo`` (and ``--write-manifest`` so the site's
``manifest.json`` points at it).  ``--proxy http://127.0.0.1:10808`` is honoured
for users who need a local proxy to reach huggingface.co; such runs also
disable hf-xet, because the xet transfer path was observed to stall behind a
local proxy while the classic requests-based path kept uploading.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
# The research checkout names the frontend directory 网站前端框架/, this
# repository frontend/ — accept either, as scripts/bake_demo_data.py does.
FRONTEND = next(
    (path for path in (ROOT / "frontend", ROOT / "网站前端框架") if path.is_dir()),
    ROOT / "frontend",
)
DEFAULT_REMOTE_OUT = ROOT / "tmp" / "demo-data-remote"
DEFAULT_MANIFEST = FRONTEND / "public" / "demo-data" / "manifest.json"
DEFAULT_REPO = "Anthony1919826/CIO-RainCast-demo-data"
REMOTE_PREFIX = "remote:"


def resolve(path: Path) -> Path:
    return path if path.is_absolute() else (Path.cwd() / path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--remote-out", type=Path, default=DEFAULT_REMOTE_OUT,
                        help="烘焙脚本的 --remote-out 目录（默认 tmp/demo-data-remote）")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST,
                        help="仓库层 manifest.json（用于核对每个外置路径都有对应文件）")
    parser.add_argument("--repo", default=DEFAULT_REPO,
                        help=f"Hugging Face dataset 仓库 id（默认 {DEFAULT_REPO}）")
    parser.add_argument("--token", default=os.environ.get("HF_TOKEN"),
                        help="HF 写权限 token（默认读 HF_TOKEN，或已登录的 hf auth login 凭据）")
    parser.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY") or os.environ.get("HF_PROXY"),
                        help="访问 huggingface.co 的代理，如 http://127.0.0.1:10808")
    parser.add_argument("--dry-run", action="store_true", help="只做清单核对与体积统计，不联网上传")
    parser.add_argument("--verify", action="store_true", help="上传后抽查线上 URL 是否可下载")
    parser.add_argument("--write-manifest", action="store_true",
                        help="把 manifest.json 的 remoteBase 改成 --repo 对应的地址")
    return parser.parse_args()


def remote_base(repo: str) -> str:
    return f"https://huggingface.co/datasets/{repo}/resolve/main/"


def manifest_remote_paths(manifest_path: Path) -> list[str]:
    """Every `remote:` path the manifest points at, de-prefixed."""
    document = json.loads(manifest_path.read_text(encoding="utf-8"))
    paths: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, str):
            if node.startswith(REMOTE_PREFIX):
                paths.append(node[len(REMOTE_PREFIX):])
        elif isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(document)
    return paths


def inventory(folder: Path) -> tuple[int, int]:
    files = [path for path in folder.rglob("*") if path.is_file()]
    return len(files), sum(path.stat().st_size for path in files)


def preflight(folder: Path, manifest_path: Path, repo: str) -> list[str]:
    """Check the folder against the manifest; returns the remote paths."""
    if not folder.is_dir():
        raise SystemExit(f"[preflight] 外置层目录不存在：{folder}（先运行 scripts/bake_demo_data.py）")
    for required in ("cases", "input", "shared", "years"):
        if not (folder / required).is_dir():
            raise SystemExit(f"[preflight] {folder} 缺少 {required}/ 子目录，外置层不完整")
    paths = manifest_remote_paths(manifest_path)
    if not paths:
        raise SystemExit(f"[preflight] {manifest_path} 没有任何 remote: 路径，manifest 与烘焙结果不匹配")
    absent = [path for path in paths if not (folder / path).is_file()]
    if absent:
        raise SystemExit(
            f"[preflight] manifest 指向 {len(absent)} 个外置文件但目录里没有，例如：\n  "
            + "\n  ".join(absent[:5])
        )
    count, total = inventory(folder)
    print(f"[preflight] {folder}")
    print(f"[preflight] 文件 {count} 个 / {total / 1e9:.2f} GB，manifest 的 {len(paths)} 条外置路径全部存在")
    print(f"[preflight] 目标仓库 {repo} → {remote_base(repo)}")
    return paths


def upload(folder: Path, repo: str, token: str | None) -> None:
    try:
        from huggingface_hub import HfApi, create_repo
    except ImportError:
        raise SystemExit(
            "[upload] 缺少 huggingface_hub：pip install huggingface_hub\n"
            "        （或用命令行等价替代：hf upload "
            f"{repo} \"{folder}\" . --type dataset）"
        )
    api = HfApi(token=token)
    create_repo(repo, repo_type="dataset", exist_ok=True, token=token)
    print(f"[upload] 开始上传到 {repo}（可重复执行，已传的分片会自动跳过）…", flush=True)
    # huggingface_hub 2.x merged the batched, resumable upload pipeline into
    # `upload_folder` (via hf_xet) and dropped `upload_large_folder`; older
    # releases only have the latter.  Use whichever this install provides.
    upload_large = getattr(api, "upload_large_folder", None)
    if callable(upload_large):
        upload_large(repo_id=repo, folder_path=str(folder), repo_type="dataset")
    else:
        api.upload_folder(repo_id=repo, folder_path=str(folder), repo_type="dataset")
    print("[upload] 完成")


def verify(repo: str, paths: list[str], folder: Path) -> None:
    """Fetch a few uploaded files over plain HTTP like the site will."""
    import requests

    base = remote_base(repo)
    # One small file (read fully), then one large file from each family.
    samples = [path for path in paths if path.endswith("frame-index.json.gz")][:1]
    for pattern in ("cases/", "input/", "years/", "shared/"):
        hit = next((path for path in sorted(paths) if path.startswith(pattern) and path.endswith(".gz")), None)
        if hit and hit not in samples:
            samples.append(hit)
    if not samples:
        raise SystemExit("[verify] manifest 里没有可抽查的外置文件")
    failures: list[str] = []
    for path in samples:
        url = f"{base}{path}"
        try:
            response = requests.get(url, timeout=60, stream=True)
            length = 0
            for chunk in response.iter_content(1 << 20):
                length += len(chunk)
            ok = response.status_code == 200 and length > 0
            print(f"[verify] {'OK ' if ok else 'FAIL'} {response.status_code} {length/1e6:8.3f} MB  {path}")
            if ok:
                expected = (folder / path).stat().st_size
                if length != expected:
                    failures.append(f"{path}: 线上 {length} 字节 ≠ 本地 {expected} 字节")
            else:
                failures.append(f"{path}: HTTP {response.status_code}")
        except Exception as exc:  # noqa: BLE001 - 网络异常直接报告给用户
            print(f"[verify] FAIL {path}: {exc}")
            failures.append(f"{path}: {exc}")
    if failures:
        raise SystemExit("[verify] 抽查失败：\n  " + "\n  ".join(failures))
    print(f"[verify] {len(samples)} 个抽样可下载，且与本地字节数一致")


def write_manifest(manifest_path: Path, repo: str) -> None:
    document = json.loads(manifest_path.read_text(encoding="utf-8"))
    wanted = remote_base(repo)
    current = document.get("remoteBase")
    if current == wanted:
        print(f"[manifest] remoteBase 已是 {wanted}")
        return
    document["remoteBase"] = wanted
    manifest_path.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"[manifest] remoteBase 更新：{current} → {wanted}")


def main() -> int:
    args = parse_args()
    if args.proxy:
        # huggingface_hub / requests pick these up at request time.
        os.environ.setdefault("HTTPS_PROXY", args.proxy)
        os.environ.setdefault("HTTP_PROXY", args.proxy)
        # Measured through a local proxy: the hf-xet transfer path stalled
        # (a 2 GB layer moved 2.5 KB in ~55 min) while the classic
        # requests-based path sustained megabytes per second, so route
        # --proxy runs through the latter.  An explicit HF_HUB_DISABLE_XET=0
        # still wins (setdefault only fills in an unset variable).
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
        print(f"[env] 使用代理 {args.proxy}（hf-xet 关闭，走经典 requests 上传路径）")

    folder = resolve(args.remote_out)
    manifest_path = resolve(args.manifest)
    paths = preflight(folder, manifest_path, args.repo)

    if args.write_manifest:
        write_manifest(manifest_path, args.repo)
    if args.dry_run:
        print("[dry-run] 未上传、未联网。去掉 --dry-run 即开始上传。")
        return 0

    upload(folder, args.repo, args.token)
    if args.verify:
        verify(args.repo, paths, folder)
    else:
        print("[next] 抽查线上可下载性：加 --verify 重跑本脚本，或直接在浏览器打开 "
              f"{remote_base(args.repo)}shared/weights.f64.gz")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

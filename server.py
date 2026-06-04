"""
3D Tiles 로컬 HTTP 서버

환경변수:
  TILES_DIR   서빙할 3D Tiles 루트 디렉터리 (기본: ./output/3dtiles)
  TILES_PATH  URL 마운트 경로               (기본: /tiles)
  HOST        바인딩 호스트                 (기본: 0.0.0.0)
  PORT        포트 번호                     (기본: 8080)

실행:
  python server.py
  PORT=9000 python server.py
  TILES_DIR=/data/3dtiles python server.py
"""

import os
import sys
import json
import signal
import logging
import mimetypes
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, unquote

# ── 설정 (환경변수 우선, 없으면 기본값) ─────────────────────────
BASE_DIR   = Path(__file__).parent
TILES_DIR  = Path(os.environ.get("TILES_DIR",  BASE_DIR / "output" / "3dtiles"))
TILES_PATH = os.environ.get("TILES_PATH", "/tiles").rstrip("/")
HOST       = os.environ.get("HOST", "0.0.0.0")
PORT       = int(os.environ.get("PORT", 8080))

# ── 추가 MIME 타입 등록 ──────────────────────────────────────────
EXTRA_MIME = {
    ".b3dm": "application/octet-stream",
    ".i3dm": "application/octet-stream",
    ".pnts": "application/octet-stream",
    ".cmpt": "application/octet-stream",
    ".glb":  "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".json": "application/json",
}
for ext, mt in EXTRA_MIME.items():
    mimetypes.add_type(mt, ext)

# ── CORS 허용 오리진 ─────────────────────────────────────────────
CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS",
    "http://localhost:8080,http://localhost:3000,http://localhost:5173,null"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("3dtiles-server")


# ────────────────────────────────────────────────────────────────
class TilesHandler(BaseHTTPRequestHandler):
    """
    URL 라우팅:
      GET /           → 서버 상태 JSON
      GET /health     → 헬스체크 JSON
      GET /tiles/**   → TILES_DIR 정적 파일
      OPTIONS *       → CORS preflight
    """

    # BaseHTTPRequestHandler 의 기본 로그를 억제하고 커스텀 로그 사용
    def log_message(self, fmt, *args):
        pass

    # ── CORS 헤더 ────────────────────────────────────────────────
    def _cors_headers(self):
        origin = self.headers.get("Origin", "")
        allowed = CORS_ORIGINS.split(",")
        if origin in allowed or "*" in allowed:
            self.send_header("Access-Control-Allow-Origin", origin or "*")
        else:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Range, Accept-Encoding"
        )
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range")
        self.send_header("Access-Control-Max-Age", "86400")

    # ── OPTIONS (preflight) ──────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    # ── HEAD (CesiumJS 가 파일 존재 확인에 사용) ─────────────────
    def do_HEAD(self):
        self._handle_get(head_only=True)

    # ── GET ──────────────────────────────────────────────────────
    def do_GET(self):
        self._handle_get(head_only=False)

    def _handle_get(self, head_only: bool):
        parsed   = urlparse(self.path)
        url_path = unquote(parsed.path)

        # ── 라우팅 ───────────────────────────────────────────────
        if url_path in ("/", ""):
            self._send_json(self._status_payload(), head_only)

        elif url_path == "/health":
            self._send_json({"status": "ok"}, head_only)

        elif url_path.startswith(TILES_PATH + "/") or url_path == TILES_PATH:
            rel = url_path[len(TILES_PATH):].lstrip("/")
            self._serve_file(Path(TILES_DIR) / rel, head_only)

        else:
            self._send_error(404, f"경로를 찾을 수 없음: {url_path}")

    # ── 정적 파일 서빙 ───────────────────────────────────────────
    def _serve_file(self, file_path: Path, head_only: bool):
        # 디렉터리 인덱스 (tileset.json 우선)
        if file_path.is_dir():
            for candidate in ("tileset.json", "index.json"):
                idx = file_path / candidate
                if idx.exists():
                    file_path = idx
                    break
            else:
                self._send_json(self._dir_listing(file_path), head_only)
                return

        if not file_path.exists():
            self._send_error(404, f"파일 없음: {file_path.name}")
            return

        # Path traversal 방어
        try:
            file_path.resolve().relative_to(TILES_DIR.resolve())
        except ValueError:
            self._send_error(403, "접근 거부")
            return

        mime = (
            mimetypes.guess_type(str(file_path))[0]
            or EXTRA_MIME.get(file_path.suffix, "application/octet-stream")
        )
        size = file_path.stat().st_size

        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        if not head_only:
            with open(file_path, "rb") as f:
                while chunk := f.read(65536):
                    self.wfile.write(chunk)

        log.info("200  %s  [%s  %d B]", self.path, mime, size)

    # ── JSON 응답 ────────────────────────────────────────────────
    def _send_json(self, payload: dict, head_only: bool):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode()
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    # ── 에러 응답 ────────────────────────────────────────────────
    def _send_error(self, code: int, message: str):
        body = json.dumps({"error": message}).encode()
        self.send_response(code)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        log.warning("%d  %s  (%s)", code, self.path, message)

    # ── 상태 페이로드 ────────────────────────────────────────────
    def _status_payload(self) -> dict:
        try:
            ts_path = TILES_DIR / "tileset.json"
            ts      = json.loads(ts_path.read_text(encoding="utf-8")) if ts_path.exists() else None
            tiles   = list((TILES_DIR / "tiles").glob("*.b3dm")) if (TILES_DIR / "tiles").exists() else []
            tile_count = len(tiles)
        except Exception:
            ts, tile_count = None, 0

        return {
            "server":    "3D Tiles Server",
            "version":   "1.0.0",
            "tiles_url": f"http://{HOST}:{PORT}{TILES_PATH}/tileset.json",
            "tiles_dir": str(TILES_DIR),
            "tile_count": tile_count,
            "tileset": {
                "asset":         ts.get("asset") if ts else None,
                "geometricError": ts.get("geometricError") if ts else None,
                "children":      len(ts["root"]["children"]) if ts and "root" in ts else 0,
            } if ts else None,
        }

    # ── 디렉터리 목록 ────────────────────────────────────────────
    def _dir_listing(self, dir_path: Path) -> dict:
        try:
            items = [
                {"name": p.name, "size": p.stat().st_size, "type": "file" if p.is_file() else "dir"}
                for p in sorted(dir_path.iterdir())
            ]
        except PermissionError:
            items = []
        return {"path": str(dir_path.relative_to(TILES_DIR)), "items": items}


# ────────────────────────────────────────────────────────────────
def validate_config():
    """시작 전 설정 유효성 검사"""
    issues = []

    if not TILES_DIR.exists():
        issues.append(f"TILES_DIR 없음: {TILES_DIR}")
    elif not (TILES_DIR / "tileset.json").exists():
        issues.append(f"tileset.json 없음 (convert 를 먼저 실행하세요): {TILES_DIR}")

    if PORT < 1 or PORT > 65535:
        issues.append(f"PORT 범위 오류: {PORT}")

    return issues


def run():
    issues = validate_config()
    if issues:
        for msg in issues:
            log.warning("⚠  %s", msg)

    server = HTTPServer((HOST, PORT), TilesHandler)

    # Ctrl+C 우아하게 종료
    def shutdown(sig, frame):
        log.info("서버 종료 중...")
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    log.info("=" * 52)
    log.info("  3D Tiles Server  started")
    log.info("  URL   : http://localhost:%d", PORT)
    log.info("  Tiles : http://localhost:%d%s/tileset.json", PORT, TILES_PATH)
    log.info("  Dir   : %s", TILES_DIR)
    log.info("=" * 52)

    server.serve_forever()


if __name__ == "__main__":
    run()

"""
OSGB → 내장 JPEG 텍스처 추출기

OSGB 바이너리에서 JPEG 시그니처(FF D8 FF)를 스캔해
MTL 파일이 참조하는 이름(<basename>_0.jpg, _1.jpg ...)으로 저장합니다.

사용법:
  python extract_textures.py              # 전체 Tile_* 처리
  python extract_textures.py --check      # 통계만 출력 (파일 저장 안 함)
  python extract_textures.py --sample 5  # 샘플 5개만 테스트
"""

import os
import sys
import struct
from pathlib import Path

BASE_DIR  = Path(__file__).resolve().parent
OBJ_DIR   = BASE_DIR / "output" / "obj"
OSGB_DIRS = [
    BASE_DIR,                      # Parking_main.osgb
    BASE_DIR / "Tile_+001_+001",
    BASE_DIR / "Tile_+002_+001",
    BASE_DIR / "Tile_+002_+002",
]

JPEG_SOI = b'\xff\xd8\xff'   # JPEG Start Of Image
JPEG_EOI = b'\xff\xd9'       # JPEG End Of Image

CHECK_ONLY = '--check' in sys.argv
SAMPLE     = int(sys.argv[sys.argv.index('--sample') + 1]) if '--sample' in sys.argv else None


def find_jpegs(data: bytes) -> list[tuple[int, int]]:
    """JPEG SOI ~ EOI 범위를 모두 반환"""
    spans = []
    pos   = 0
    while True:
        start = data.find(JPEG_SOI, pos)
        if start == -1:
            break
        end = data.find(JPEG_EOI, start + 3)
        if end == -1:
            pos = start + 1
            continue
        end += 2  # EOI 2 bytes 포함
        spans.append((start, end))
        pos = end
    return spans


def extract_from_osgb(osgb_path: Path, obj_dir: Path, dry_run: bool = False) -> dict:
    """
    단일 OSGB 파일에서 텍스처를 추출해 obj_dir 에 저장.
    MTL 참조명: <basename>_0.jpg, _1.jpg ...
    """
    data   = osgb_path.read_bytes()
    spans  = find_jpegs(data)
    result = {"osgb": osgb_path.name, "found": len(spans), "saved": 0, "skipped": 0}

    for i, (start, end) in enumerate(spans):
        jpg_name  = f"{osgb_path.stem}_{i}.jpg"
        out_path  = obj_dir / jpg_name
        jpg_bytes = data[start:end]

        if out_path.exists() and out_path.stat().st_size == len(jpg_bytes):
            result["skipped"] += 1
            continue

        if not dry_run:
            out_path.write_bytes(jpg_bytes)
        result["saved"] += 1

    return result


def main():
    total_found = 0
    total_saved = 0
    total_skipped = 0
    no_texture  = []
    processed   = 0

    for osgb_root in OSGB_DIRS:
        if not osgb_root.exists():
            continue

        osgb_files = sorted(osgb_root.glob("*.osgb"))
        if SAMPLE:
            # 리프 레벨 타일 위주로 샘플링
            leaf = [f for f in osgb_files if '_L2' in f.name]
            osgb_files = (leaf or osgb_files)[:SAMPLE]

        for osgb_path in osgb_files:
            # 대응하는 OBJ 폴더 찾기
            if osgb_path.parent == BASE_DIR:
                obj_dir = OBJ_DIR
            else:
                obj_dir = OBJ_DIR / osgb_path.parent.name

            if not obj_dir.exists():
                continue  # OBJ 변환이 안 된 폴더는 건너뜀

            res = extract_from_osgb(osgb_path, obj_dir, dry_run=CHECK_ONLY)
            total_found   += res["found"]
            total_saved   += res["saved"]
            total_skipped += res["skipped"]
            processed     += 1

            if res["found"] == 0:
                no_texture.append(osgb_path.name)
            else:
                status = "DRY" if CHECK_ONLY else f"saved={res['saved']} skip={res['skipped']}"
                print(f"  {osgb_path.name}: {res['found']} 텍스처  [{status}]")

    print()
    print("=" * 54)
    print(f"  처리 OSGB : {processed} 개")
    print(f"  텍스처 발견: {total_found} 개")
    if not CHECK_ONLY:
        print(f"  저장       : {total_saved} 개")
        print(f"  스킵(기존) : {total_skipped} 개")
    print(f"  텍스처 없음: {len(no_texture)} 개")
    if no_texture:
        for n in no_texture[:10]:
            print(f"    - {n}")
        if len(no_texture) > 10:
            print(f"    ... 외 {len(no_texture)-10}개")
    print("=" * 54)


if __name__ == "__main__":
    print()
    print("=" * 54)
    mode = "확인만 (--check)" if CHECK_ONLY else "추출 + 저장"
    print(f"  OSGB 텍스처 추출기  [{mode}]")
    print("=" * 54)
    print()
    main()

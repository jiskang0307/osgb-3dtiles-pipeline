#!/usr/bin/env node
/**
 * tileset.json 구조 검증기
 *
 * 사용법:
 *   node validate_tileset.js [tileset경로]
 *
 * 기본 경로: ./output/3dtiles/tileset.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// require() 로 호출될 때 argv[2] 가 다른 값일 수 있으므로 .json 여부로 판별
const _arg = process.argv[2];
const TILESET_PATH = (_arg && _arg.endsWith('.json') && fs.existsSync(_arg))
    ? _arg
    : path.join(__dirname, 'output', '3dtiles', 'tileset.json');

const TILES_DIR = path.dirname(TILESET_PATH);

// ── 검증 규칙 목록 ────────────────────────────────────────────────
const CHECKS = [
    {
        name: 'tileset.json 파일 존재',
        fn(ts, _raw, filePath) {
            if (!fs.existsSync(filePath)) throw new Error('파일 없음: ' + filePath);
        }
    },
    {
        name: 'asset.version 필드',
        fn(ts) {
            if (!ts.asset || !ts.asset.version) throw new Error('asset.version 누락');
            if (ts.asset.version !== '1.0') throw new Error(`예상값 "1.0", 실제값 "${ts.asset.version}"`);
        }
    },
    {
        name: 'geometricError (루트)',
        fn(ts) {
            if (typeof ts.geometricError !== 'number' || ts.geometricError < 0)
                throw new Error('geometricError 가 없거나 음수');
        }
    },
    {
        name: 'root 노드 존재',
        fn(ts) {
            if (!ts.root) throw new Error('root 필드 누락');
        }
    },
    {
        name: 'root.boundingVolume (region 또는 box)',
        fn(ts) {
            const bv = ts.root.boundingVolume;
            if (!bv) throw new Error('root.boundingVolume 누락');
            if (!bv.region && !bv.box && !bv.sphere)
                throw new Error('region / box / sphere 중 하나 필요');

            if (bv.region) {
                if (!Array.isArray(bv.region) || bv.region.length !== 6)
                    throw new Error('region 은 길이 6 배열이어야 함');
                const [w, s, e, n, minH, maxH] = bv.region;
                if (w >= e) throw new Error(`west(${w.toFixed(4)}) >= east(${e.toFixed(4)})`);
                if (s >= n) throw new Error(`south(${s.toFixed(4)}) >= north(${n.toFixed(4)})`);
                if (minH > maxH) throw new Error(`minHeight(${minH}) > maxHeight(${maxH})`);
            }
            if (bv.box) {
                if (!Array.isArray(bv.box) || bv.box.length !== 12)
                    throw new Error('box 는 길이 12 배열이어야 함');
            }
        }
    },
    {
        name: 'root.refine 값',
        fn(ts) {
            const r = ts.root.refine;
            if (!['ADD', 'REPLACE'].includes(r))
                throw new Error(`refine 값 "${r}" — ADD 또는 REPLACE 필요`);
        }
    },
    {
        name: 'children 배열',
        fn(ts) {
            const c = ts.root.children;
            if (!Array.isArray(c) || c.length === 0)
                throw new Error('children 가 없거나 빈 배열');
        }
    },
    {
        name: 'children 각 타일 content.uri',
        fn(ts) {
            const bad = [];
            for (const child of ts.root.children) {
                if (!child.content || !child.content.uri)
                    bad.push('content.uri 누락');
            }
            if (bad.length) throw new Error(bad.join(', '));
        }
    },
    {
        name: 'children geometricError 단조 감소',
        fn(ts) {
            const rootErr = ts.root.geometricError;
            const violations = ts.root.children.filter(
                c => typeof c.geometricError === 'number' && c.geometricError > rootErr
            );
            if (violations.length)
                throw new Error(`${violations.length}개 자식 타일 geometricError > root (${rootErr})`);
        }
    },
    {
        name: 'b3dm 파일 실제 존재 여부',
        fn(ts) {
            const missing = [];
            for (const child of ts.root.children) {
                const uri     = child.content.uri;
                const fullPath = path.join(TILES_DIR, uri);
                if (!fs.existsSync(fullPath)) missing.push(uri);
            }
            if (missing.length)
                throw new Error(`누락된 b3dm ${missing.length}개:\n   ` + missing.slice(0, 5).join('\n   ')
                    + (missing.length > 5 ? `\n   ... 외 ${missing.length - 5}개` : ''));
        }
    },
    {
        name: 'b3dm 헤더 magic 바이트 ("b3dm")',
        fn(ts) {
            const bad = [];
            for (const child of ts.root.children) {
                const uri      = child.content.uri;
                const fullPath = path.join(TILES_DIR, uri);
                if (!fs.existsSync(fullPath)) continue;

                const buf = Buffer.alloc(4);
                const fd  = fs.openSync(fullPath, 'r');
                fs.readSync(fd, buf, 0, 4, 0);
                fs.closeSync(fd);

                if (buf.toString('ascii') !== 'b3dm') bad.push(uri);
            }
            if (bad.length)
                throw new Error(`magic 바이트 오류 ${bad.length}개: ` + bad.slice(0, 3).join(', '));
        }
    }
];

// ── 검증 실행 ─────────────────────────────────────────────────────
function runValidation(tilesetPath) {
    let raw, ts;
    const results = [];
    let passCount = 0, failCount = 0;

    try {
        raw = fs.readFileSync(tilesetPath, 'utf8');
        ts  = JSON.parse(raw);
    } catch (e) {
        console.error(`[ERROR] tileset.json 파싱 실패: ${e.message}`);
        process.exit(1);
    }

    for (const check of CHECKS) {
        try {
            check.fn(ts, raw, tilesetPath);
            results.push({ name: check.name, pass: true });
            passCount++;
        } catch (e) {
            results.push({ name: check.name, pass: false, msg: e.message });
            failCount++;
        }
    }

    // ── 결과 출력 ─────────────────────────────────────────────────
    const pad = 45;
    console.log(`  파일: ${tilesetPath}\n`);
    for (const r of results) {
        const label = r.name.padEnd(pad, '.');
        if (r.pass) {
            console.log(`  ✅ ${label} PASS`);
        } else {
            console.log(`  ❌ ${label} FAIL`);
            console.log(`      └─ ${r.msg}`);
        }
    }

    console.log(`\n  결과: ${passCount} 통과 / ${failCount} 실패`);
    console.log(`  타일 수: ${ts.root?.children?.length ?? 0}개`);

    // ── 타일 통계 ─────────────────────────────────────────────────
    if (ts.root?.children?.length > 0) {
        const sizes = ts.root.children.map(c => {
            try {
                const fp = path.join(TILES_DIR, c.content.uri);
                return fs.statSync(fp).size;
            } catch { return 0; }
        }).filter(Boolean);

        if (sizes.length) {
            const total = sizes.reduce((a, b) => a + b, 0);
            const avg   = total / sizes.length;
            console.log(`\n  b3dm 파일 통계:`);
            console.log(`    전체 크기: ${(total / 1024).toFixed(1)} KB`);
            console.log(`    평균 크기: ${(avg  / 1024).toFixed(1)} KB`);
            console.log(`    최대 크기: ${(Math.max(...sizes) / 1024).toFixed(1)} KB`);
        }
    }

    console.log('');
    return failCount === 0;
}

const ok = runValidation(TILESET_PATH);
if (!ok) process.exitCode = 1;

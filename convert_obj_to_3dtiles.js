#!/usr/bin/env node
/**
 * OBJ → 3D Tiles 변환 파이프라인
 *
 * 도구 체인:
 *   OBJ  ──obj2gltf──▶  GLB  ──glbToB3dm()──▶  B3DM
 *                                              ──▶  tileset.json
 *
 * 사용법:
 *   node convert_obj_to_3dtiles.js [--mode local|geo] [--lod-only]
 *
 *   --mode local   로컬 좌표계 box 바운딩 볼륨 (기본값)
 *   --mode geo     tileset_options.json geographic 원점 기준 EPSG:4326 region
 *   --lod-only     각 Tile 폴더에서 최고 해상도 LOD 파일 하나만 변환
 */

'use strict';

const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

// ── 경로 ──────────────────────────────────────────────────────────
const BASE_DIR     = __dirname;
const OBJ_DIR      = path.join(BASE_DIR, 'output', 'obj');
const OUT_DIR      = path.join(BASE_DIR, 'output', '3dtiles');
const TILES_DIR    = path.join(OUT_DIR,  'tiles');
const TILESET_OUT  = path.join(OUT_DIR,  'tileset.json');
const ERROR_LOG    = path.join(BASE_DIR, 'error.log');
const OPTIONS_FILE = path.join(BASE_DIR, 'tileset_options.json');

// ── CLI 인수 ──────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const MODE     = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'local';
const LOD_ONLY = args.includes('--lod-only');

// ── 설정 로드 ─────────────────────────────────────────────────────
const options   = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
const GEO       = options.geographic;           // { longitude, latitude, height }
const TILE_SIZE = options.local.tileSize;
const DEG2RAD   = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────
// GLB → B3DM 래퍼 (3D Tiles 1.0 spec)
//
// 헤더 레이아웃 (28 bytes):
//   magic[4]  version[4]  byteLength[4]
//   ftJSONLen[4]  ftBinLen[4]  btJSONLen[4]  btBinLen[4]
// ─────────────────────────────────────────────────────────────────
function glbToB3dm(glbBuffer) {
    const ftJSON    = Buffer.from('{"BATCH_LENGTH":0}', 'utf8');
    // 8바이트 정렬: 공백(0x20)으로 패딩
    const aligned   = Math.ceil(ftJSON.length / 8) * 8;
    const ftPadded  = Buffer.alloc(aligned, 0x20);
    ftJSON.copy(ftPadded);

    const headerLen = 28;
    const totalLen  = headerLen + ftPadded.length + glbBuffer.length;

    const header = Buffer.alloc(headerLen);
    header.write('b3dm', 0, 'ascii');
    header.writeUInt32LE(1,              4);   // version
    header.writeUInt32LE(totalLen,       8);   // byteLength
    header.writeUInt32LE(ftPadded.length, 12); // featureTableJSONByteLength
    header.writeUInt32LE(0,             16);   // featureTableBinaryByteLength
    header.writeUInt32LE(0,             20);   // batchTableJSONByteLength
    header.writeUInt32LE(0,             24);   // batchTableBinaryByteLength

    return Buffer.concat([header, ftPadded, glbBuffer]);
}

// ─────────────────────────────────────────────────────────────────
// OBJ 파싱: Axis-Aligned Bounding Box
// ─────────────────────────────────────────────────────────────────
function parseObjBBox(objPath) {
    const lines = fs.readFileSync(objPath, 'utf8').split('\n');
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let vCount = 0;

    for (const line of lines) {
        if (!line.startsWith('v ')) continue;
        const parts = line.trim().split(/\s+/);
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        const z = parseFloat(parts[3]);
        if (isNaN(x) || isNaN(y) || isNaN(z)) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        vCount++;
    }
    return vCount === 0
        ? null
        : { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], vCount };
}

// ─────────────────────────────────────────────────────────────────
// 바운딩 볼륨 생성
// ─────────────────────────────────────────────────────────────────
function bboxToBox(bbox) {
    const cx = (bbox.min[0] + bbox.max[0]) / 2;
    const cy = (bbox.min[1] + bbox.max[1]) / 2;
    const cz = (bbox.min[2] + bbox.max[2]) / 2;
    const hx = (bbox.max[0] - bbox.min[0]) / 2;
    const hy = (bbox.max[1] - bbox.min[1]) / 2;
    const hz = (bbox.max[2] - bbox.min[2]) / 2;
    return [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz];
}

function bboxToRegion(bbox, origin) {
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(origin.latitude * DEG2RAD);
    return [
        (origin.longitude + bbox.min[0] / mPerDegLon) * DEG2RAD,
        (origin.latitude  + bbox.min[1] / mPerDegLat) * DEG2RAD,
        (origin.longitude + bbox.max[0] / mPerDegLon) * DEG2RAD,
        (origin.latitude  + bbox.max[1] / mPerDegLat) * DEG2RAD,
        origin.height + bbox.min[2],
        origin.height + bbox.max[2]
    ];
}

function makeBV(bbox) {
    return MODE === 'geo'
        ? { region: bboxToRegion(bbox, GEO).map(v => parseFloat(v.toFixed(8))) }
        : { box:    bboxToBox(bbox).map(v => parseFloat(v.toFixed(4))) };
}

// ─────────────────────────────────────────────────────────────────
// LOD 레벨 숫자 추출 (_L21_ → 21)
// ─────────────────────────────────────────────────────────────────
function lodLevel(filename) {
    const m = filename.match(/_L(\d+)_?/);
    return m ? parseInt(m[1]) : -1;
}

// ─────────────────────────────────────────────────────────────────
// OBJ 파일 목록 수집
// ─────────────────────────────────────────────────────────────────
function collectJobs() {
    const jobs = [];

    // 루트 레벨 OBJ (Parking_main.obj 등)
    for (const f of fs.readdirSync(OBJ_DIR)) {
        if (!f.endsWith('.obj')) continue;
        jobs.push({
            objPath:  path.join(OBJ_DIR, f),
            b3dmName: f.replace('.obj', '.b3dm'),
            label:    f.replace('.obj', '')
        });
    }

    // Tile_* 서브폴더
    for (const dir of fs.readdirSync(OBJ_DIR)) {
        const tileDir = path.join(OBJ_DIR, dir);
        if (!fs.statSync(tileDir).isDirectory() || !dir.startsWith('Tile_')) continue;

        let objFiles = fs.readdirSync(tileDir).filter(f => f.endsWith('.obj'));
        if (objFiles.length === 0) continue;

        if (LOD_ONLY) {
            // 각 Tile에서 최고 LOD 1개만
            objFiles.sort((a, b) => lodLevel(b) - lodLevel(a));
            objFiles = [objFiles[0]];
        }

        for (const f of objFiles) {
            jobs.push({
                objPath:  path.join(tileDir, f),
                b3dmName: `${dir}__${f.replace('.obj', '.b3dm')}`,
                label:    `${dir}/${f.replace('.obj', '')}`
            });
        }
    }

    return jobs;
}

// ─────────────────────────────────────────────────────────────────
// 단일 OBJ → B3DM 변환
// ─────────────────────────────────────────────────────────────────
function convertOne(objPath, b3dmPath) {
    // 임시 GLB 경로
    const glbPath = b3dmPath.replace('.b3dm', '.glb');

    // 1) OBJ → GLB
    const r = spawnSync('obj2gltf', ['-i', objPath, '-o', glbPath], {
        encoding: 'utf8', shell: true
    });
    if (r.status !== 0) {
        return { ok: false, error: (r.stderr || r.stdout || '').slice(0, 200) };
    }
    if (!fs.existsSync(glbPath)) {
        return { ok: false, error: 'GLB 파일 생성 안됨' };
    }

    // 2) GLB → B3DM
    const glbBuf  = fs.readFileSync(glbPath);
    const b3dmBuf = glbToB3dm(glbBuf);
    fs.writeFileSync(b3dmPath, b3dmBuf);

    // 임시 GLB 삭제
    fs.unlinkSync(glbPath);

    return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────
function main() {
    console.log('\n================================================');
    console.log(' OBJ → 3D Tiles 변환 파이프라인');
    console.log(` 좌표 모드: ${MODE.toUpperCase()}  LOD-only: ${LOD_ONLY}`);
    console.log('================================================\n');

    if (!fs.existsSync(OBJ_DIR)) {
        console.error('[ERROR] OBJ 폴더 없음:', OBJ_DIR);
        process.exit(1);
    }

    fs.mkdirSync(TILES_DIR, { recursive: true });

    const jobs = collectJobs();
    console.log(`[INFO] 변환 대상: ${jobs.length}개 OBJ\n`);

    const tileEntries = [];
    let ok = 0, fail = 0;
    const errors = [];

    for (const job of jobs) {
        const b3dmPath = path.join(TILES_DIR, job.b3dmName);
        process.stdout.write(`  ${job.label} ... `);

        const bbox = parseObjBBox(job.objPath);
        if (!bbox) {
            console.log('SKIP (빈 파일)');
            continue;
        }

        const result = convertOne(job.objPath, b3dmPath);
        if (result.ok) {
            console.log(`OK  (${bbox.vCount} verts)`);
            ok++;
            tileEntries.push({ job, bbox, b3dmPath });
        } else {
            console.log('FAIL');
            fail++;
            errors.push(`[FAIL] ${job.objPath}\n  → ${result.error}`);
        }
    }

    if (errors.length > 0) {
        fs.appendFileSync(ERROR_LOG,
            '\n=== obj→3dtiles errors ===\n' + errors.join('\n') + '\n');
    }

    // ── 전체 AABB ──────────────────────────────────────────────
    const globalBbox = {
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity]
    };
    for (const { bbox } of tileEntries) {
        for (let i = 0; i < 3; i++) {
            if (bbox.min[i] < globalBbox.min[i]) globalBbox.min[i] = bbox.min[i];
            if (bbox.max[i] > globalBbox.max[i]) globalBbox.max[i] = bbox.max[i];
        }
    }

    // ── tileset.json 생성 ─────────────────────────────────────
    const globalDiag = Math.hypot(
        globalBbox.max[0] - globalBbox.min[0],
        globalBbox.max[1] - globalBbox.min[1]
    );

    const children = tileEntries.map(({ job, bbox, b3dmPath }) => {
        const diagXY = Math.hypot(
            bbox.max[0] - bbox.min[0],
            bbox.max[1] - bbox.min[1]
        );
        return {
            boundingVolume: makeBV(bbox),
            geometricError: parseFloat(Math.max(diagXY * 0.05, 0.5).toFixed(2)),
            content: { uri: 'tiles/' + path.basename(b3dmPath) }
        };
    });

    const tileset = {
        asset: {
            version:        '1.0',
            tilesetVersion: '1.0.0',
            generator:      'osgb-3dtiles-pipeline/obj2gltf'
        },
        geometricError: parseFloat((globalDiag * 0.5).toFixed(2)),
        root: {
            boundingVolume: makeBV(globalBbox),
            geometricError: parseFloat((globalDiag * 0.1).toFixed(2)),
            refine:         'ADD',
            children
        }
    };

    fs.writeFileSync(TILESET_OUT, JSON.stringify(tileset, null, 2));

    console.log('\n================================================');
    console.log(` 완료  성공: ${ok}  실패: ${fail}`);
    console.log(` tileset.json → ${TILESET_OUT}`);
    console.log('================================================\n');

    return tileset;
}

// ─────────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────────
const tileset = main();

// tileset.json 구조 미리보기
console.log('📋 tileset.json 구조 미리보기:\n');
const preview = {
    asset:        tileset.asset,
    geometricError: tileset.geometricError,
    root: {
        boundingVolume: tileset.root.boundingVolume,
        geometricError: tileset.root.geometricError,
        refine:         tileset.root.refine,
        children:       `[${tileset.root.children.length}개 타일]`
    }
};
console.log(JSON.stringify(preview, null, 2));

// 검증 실행
console.log('\n🔍 tileset.json 검증:\n');
require('./validate_tileset.js');

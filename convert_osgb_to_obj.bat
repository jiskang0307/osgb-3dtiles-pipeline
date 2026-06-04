@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: ============================================================
::  OSGB → OBJ Batch Converter  v1.1
::
::  구조 예시:
::    .\Parking_main.osgb
::    .\Tile_+001_+001\Tile_+001_+001_L22_00000.osgb  ...
::    .\Tile_+002_+001\...
::  출력:
::    .\output\obj\Tile_+001_+001\Tile_+001_+001_L22_00000.obj
::    .\output\obj\Tile_+001_+001\Tile_+001_+001_L22_00000.mtl
::    .\output\obj\Tile_+001_+001\Tile_+001_+001_L22_00000_0.jpg  (텍스처)
:: ============================================================

:: === [설정] 여기만 수정하세요 ===
set "OSGCONV=C:\Program Files\CHCNAV\CoPre2\Release\SDK_BIN\G3D_BIN\osgconv.exe"
set "BASE_DIR=%~dp0"
set "OUTPUT_DIR=%BASE_DIR%output\obj"
set "ERROR_LOG=%BASE_DIR%error.log"

:: 텍스처 임베디드 추출을 위한 OSG 환경변수
set "OSG_WRITE_OUT_DEFAULT_VALUES=ON"

:: === 카운터 초기화 ===
set "SUCCESS_COUNT=0"
set "FAIL_COUNT=0"
set "TOTAL_COUNT=0"

:: ============================================================
:: osgconv 존재 확인
:: ============================================================
if not exist "%OSGCONV%" (
    echo.
    echo  [ERROR] osgconv.exe 를 찾을 수 없습니다:
    echo          %OSGCONV%
    echo.
    goto :ALT_METHODS
)

:: ============================================================
:: 초기화
:: ============================================================
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

(
    echo OSGB to OBJ Conversion Error Log
    echo ================================================
    echo  Started : %date% %time%
    echo  Base Dir: %BASE_DIR%
    echo  Output  : %OUTPUT_DIR%
    echo ================================================
) > "%ERROR_LOG%"

echo.
echo  ================================================
echo   OSGB ^> OBJ 변환 시작
echo   입력: %BASE_DIR%
echo   출력: %OUTPUT_DIR%
echo  ================================================

:: ============================================================
:: 함수: 단일 파일 변환
::   %1 = 입력 osgb 경로 (전체)
::   %2 = 출력 obj 경로 (전체)
::   %3 = 표시용 레이블
:: ============================================================

:: (배치에서 서브루틴으로 대신 처리)

:: ============================================================
:: 1) 루트 레벨 .osgb (Parking_main.osgb 등)
:: ============================================================
echo.
echo [루트 파일]
for %%F in ("%BASE_DIR%*.osgb") do (
    set /a TOTAL_COUNT+=1
    set "OUT_OBJ=%OUTPUT_DIR%\%%~nF.obj"
    set "LABEL=%%~nxF"
    call :CONVERT "%%F" "!OUT_OBJ!" "!LABEL!"
)

:: ============================================================
:: 2) Tile_* 폴더 순회 (1단계 깊이)
:: ============================================================
for /d %%D in ("%BASE_DIR%Tile_*") do (
    set "TILE_NAME=%%~nxD"
    set "TILE_OUT=%OUTPUT_DIR%\!TILE_NAME!"
    if not exist "!TILE_OUT!" mkdir "!TILE_OUT!"

    echo.
    echo [폴더] !TILE_NAME!

    :: 폴더 내 직접 .osgb 파일
    for %%F in ("%%D\*.osgb") do (
        set /a TOTAL_COUNT+=1
        set "OUT_OBJ=!TILE_OUT!\%%~nF.obj"
        set "LABEL=  %%~nxF"
        call :CONVERT "%%F" "!OUT_OBJ!" "!LABEL!"
    )

    :: 1단계 서브폴더
    for /d %%S in ("%%D\*") do (
        set "SUB_OUT=!TILE_OUT!\%%~nxS"
        if not exist "!SUB_OUT!" mkdir "!SUB_OUT!"
        for %%G in ("%%S\*.osgb") do (
            set /a TOTAL_COUNT+=1
            set "OUT_OBJ=!SUB_OUT!\%%~nG.obj"
            set "LABEL=    %%~nxG"
            call :CONVERT "%%G" "!OUT_OBJ!" "!LABEL!"
        )
    )
)

:: ============================================================
:: 결과 요약
:: ============================================================
echo.
echo  ================================================
echo   완료: %date% %time%
echo   전체: !TOTAL_COUNT! 파일
echo   성공: !SUCCESS_COUNT!
echo   실패: !FAIL_COUNT!
if !FAIL_COUNT! gtr 0 (
    echo   [!] 실패 목록 -^> %ERROR_LOG%
)
echo  ================================================
echo.

(
    echo.
    echo ================================================
    echo  완료: %date% %time%
    echo  전체: !TOTAL_COUNT!  성공: !SUCCESS_COUNT!  실패: !FAIL_COUNT!
    echo ================================================
) >> "%ERROR_LOG%"

pause
goto :EOF

:: ============================================================
:: 서브루틴: CONVERT
:: ============================================================
:CONVERT
    set "IN_FILE=%~1"
    set "OUT_FILE=%~2"
    set "DISP=%~3"

    :: 출력 폴더 보장
    set "OUT_FOLDER=%~dp2"
    if not exist "!OUT_FOLDER!" mkdir "!OUT_FOLDER!"

    echo %DISP%
    "%OSGCONV%" "%~1" "%~2" >nul 2>&1

    if !errorlevel! equ 0 (
        set /a SUCCESS_COUNT+=1
        echo   -> OK
    ) else (
        set /a FAIL_COUNT+=1
        echo   -> FAIL
        echo [FAIL] %~1 >> "%ERROR_LOG%"
    )
goto :EOF

:: ============================================================
:: 대안 방법 안내 (osgconv 없을 때)
:: ============================================================
:ALT_METHODS
echo  ================================================
echo   대안 방법 (osgconv 없을 때)
echo  ================================================
echo.
echo  [방법 1] CHCNAV osgconv PATH 등록
echo    PowerShell (관리자):
echo    $osg = "C:\Program Files\CHCNAV\CoPre2\Release\SDK_BIN\G3D_BIN"
echo    [Environment]::SetEnvironmentVariable("PATH",$env:PATH+";$osg","Machine")
echo.
echo  [방법 2] py3dtiles (Python, OSGB → 3D Tiles 직접 변환)
echo    pip install py3dtiles
echo    py3dtiles convert .\Parking_main.osgb --out .\output\3dtiles
echo.
echo  [방법 3] Cesium ion (클라우드, OSGB 직접 지원)
echo    https://ion.cesium.com ^> Upload ^> 3D Capture
echo.
echo  [방법 4] OSG 공식 바이너리 설치
echo    winget install openscenegraph
echo    또는 https://objexx.com/OpenSceneGraph.html 에서 Win64 빌드 다운로드
echo.
pause
exit /b 1

#!/usr/bin/env bash
# テスト用の素材を ffmpeg で fixtures/generated/ に作る（設計書 13.1）。素材はリポジトリに含めない。
#   npm run fixtures
# ffmpeg のパスは環境変数 FFMPEG で変えられる。
set -euo pipefail
FF="${FFMPEG:-ffmpeg}"
OUT="$(dirname "$0")/../fixtures/generated"
mkdir -p "$OUT"
q() { "$FF" -hide_banner -loglevel error -y "$@"; }

# 1. トーク用：440Hz のサイン波と無音を交互に並べた音声（音 2秒 / 無音 1.5秒 / 音 2秒 / 無音 0.4秒 / 音 2秒 / 無音 3秒 / 音 2秒）
TALK_AUDIO="aevalsrc=exprs='if(lt(t,2)+between(t,3.5,5.5)+between(t,5.9,7.9)+between(t,10.9,12.9),0.3*sin(2*PI*440*t),0)':s=48000:d=13"
q -f lavfi -i "testsrc2=s=1280x720:r=30:d=13" -f lavfi -i "$TALK_AUDIO" \
  -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac -b:a 128k -shortest "$OUT/talk.mp4"
q -f lavfi -i "testsrc2=s=640x360:r=30:d=13" -f lavfi -i "$TALK_AUDIO" \
  -c:v libvpx-vp9 -b:v 500k -deadline realtime -cpu-used 8 -g 30 -c:a libopus -b:a 96k -shortest "$OUT/talk.webm"

# 2. ゲーム用：小さなノイズが続く中に、40秒地点で 1.5 秒の大きな音（60 秒）
GAME_AUDIO="aevalsrc=exprs='0.03*(random(0)*2-1)+if(between(t,40,41.5),0.6*sin(2*PI*660*t),0)':s=48000:d=60"
q -f lavfi -i "testsrc2=s=640x360:r=30:d=60" -f lavfi -i "$GAME_AUDIO" \
  -c:v libvpx-vp9 -b:v 300k -deadline realtime -cpu-used 8 -g 60 -c:a libopus -b:a 96k -shortest "$OUT/game.webm"
q -f lavfi -i "testsrc2=s=1280x720:r=60:d=60" -f lavfi -i "$GAME_AUDIO" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 60 -c:a aac -b:a 128k -shortest "$OUT/game.mp4"

# 3. 音声2トラックの MP4（OBS のマイク別録りを想定：1本目=ゲーム音、2本目=マイク）
q -f lavfi -i "testsrc2=s=1280x720:r=30:d=13" -f lavfi -i "$GAME_AUDIO" -f lavfi -i "$TALK_AUDIO" \
  -map 0:v -map 1:a -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k \
  -metadata:s:a:0 title=ゲーム音 -metadata:s:a:1 title=マイク -t 13 "$OUT/twotrack.mp4"

# 4. BGM（8秒のフレーズ。短いのでループする）
BGM="aevalsrc=exprs='0.2*sin(2*PI*(220+110*floor(mod(t,2)))*t)|0.2*sin(2*PI*(330+110*floor(mod(t,2)))*t)':s=44100:d=8"
q -f lavfi -i "$BGM" -c:a aac -b:a 160k "$OUT/bgm.m4a"
q -f lavfi -i "$BGM" -c:a libopus -b:a 128k "$OUT/bgm.ogg"

echo "fixtures/generated に作りました:"
ls -1 "$OUT"

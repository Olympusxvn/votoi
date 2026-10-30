#!/usr/bin/env bash
# VOTOI demo video edit — ready-to-run, tested 2026-10-24 with ffmpeg 8.1.2.
# v2: audio is trimmed to each clip's own duration (the first version used
# apad, which pads indefinitely and inflated audio timestamps); final video
# is forced to yuv420p; title uses a plain hyphen to avoid encoding risk.
# Usage:
#   edit-demo-video.sh -o OUTPUT.mp4 INPUT1 [INPUT2 ...]
#   edit-demo-video.sh -o OUTPUT.mp4 --title "Custom title" --sub "Custom sub" INPUT1 [INPUT2 ...]
# Behaviour:
#   - Prepends a 3s intro card (black, violet bar, title + subtitle, silent).
#   - Joins multiple clips with 0.5s crossfade video + audio crossfade.
#   - Single take: pass the one file; beat splits (if wanted) still need
#     timestamps from the user, so this script does NOT guess cut points.
#   - Original audio is preserved (no new voiceover); 0.5s audio fade
#     in at the start and fade out at the end.
#   - All segments normalised to 1920x1080, 30fps, yuv420p, AAC audio.
# Defaults match the intro wording proposed to the user on 2026-10-24
# (15:50 ICT); change with --title/--sub if the user picks other wording.
set -euo pipefail

TITLE="VOTOI - Expense Watchdog Agent"
SUB="Long-term memory on Walrus, payments on Sui"
OUT=""
INPUTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --sub) SUB="$2"; shift 2 ;;
    --) shift; INPUTS+=("$@"); break ;;
    *) INPUTS+=("$1"); shift ;;
  esac
done

[ -n "$OUT" ] || { echo "usage: $0 -o OUTPUT.mp4 INPUT [INPUT...]" >&2; exit 2; }
[ ${#INPUTS[@]} -ge 1 ] || { echo "need at least one input file" >&2; exit 2; }
for f in "${INPUTS[@]}"; do [ -f "$f" ] || { echo "not found: $f" >&2; exit 2; }; done

FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FADE=0.5
INTRO_DUR=3

# Escape text for drawtext.
esc() { printf '%s' "$1" | sed "s/:/\\\\:/g; s/'/\\\\'/g"; }

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }

# Build normalised segments: segment 0 = intro card, then one per input.
# We build the filter graph in two passes: first normalise every input to
# a common size/fps with an audio track, then xfade them in sequence.
SEG_COUNT=$(( ${#INPUTS[@]} + 1 ))
FILTER=""
INPUT_ARGS=()
# Intro: colour source + silent audio, 3s.
INPUT_ARGS+=(-f lavfi -i "color=c=black:s=1920x1080:r=30:d=${INTRO_DUR}")
INPUT_ARGS+=(-f lavfi -i "anullsrc=r=48000:cl=stereo:d=${INTRO_DUR}")
FILTER+=" [0:v]drawtext=fontfile=${FONT}:text='$(esc "$TITLE")':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-40,"
FILTER+="drawtext=fontfile=${FONT}:text='$(esc "$SUB")':fontsize=32:fontcolor=0xA78BFA:x=(w-text_w)/2:y=(h-text_h)/2+50,"
FILTER+="drawtext=fontfile=${FONT}:text='':fontsize=1:x=0:y=0[v0];"
FILTER+="[1:a]anull[a0];"

idx=2
for i in "${!INPUTS[@]}"; do
  INPUT_ARGS+=(-i "${INPUTS[$i]}")
  d="$(dur "${INPUTS[$i]}")"
  FILTER+="[$idx:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v$((i+1))];"
  FILTER+="[$idx:a]aresample=48000,atrim=0:$d,asetpts=PTS-STARTPTS[a$((i+1))];"
  idx=$((idx+1))
done

# Chain xfades. Track running total duration; each xfade shortens it by FADE.
prev_v="v0"; prev_a="a0"
total="$INTRO_DUR"
for i in "${!INPUTS[@]}"; do
  n=$((i+1))
  d="$(dur "${INPUTS[$i]}")"
  offset="$(awk -v t="$total" -v f="$FADE" 'BEGIN{printf "%.3f", t-f}')"
  FILTER+="[$prev_v][v$n]xfade=transition=fade:duration=$FADE:offset=$offset[xv$n];"
  FILTER+="[$prev_a][a$n]acrossfade=d=$FADE[xa$n];"
  prev_v="xv$n"; prev_a="xa$n"
  total="$(awk -v t="$total" -v d="$d" -v f="$FADE" 'BEGIN{printf "%.3f", t+d-f}')"
done

# Final audio fades: fade in 0.5s, fade out over last 1s.
fout="$(awk -v t="$total" 'BEGIN{printf "%.3f", t-1}')"
FILTER+="[$prev_a]afade=t=in:st=0:d=0.5,afade=t=out:st=$fout:d=1[aout];"
FILTER+="[$prev_v]format=yuv420p[vout]"

ffmpeg -y "${INPUT_ARGS[@]}" -filter_complex "$FILTER" \
  -map "[vout]" -map "[aout]" -c:v libx264 -preset veryfast -crf 18 \
  -c:a aac -b:a 192k -movflags +faststart "$OUT"
echo "wrote $OUT (approx ${total}s, ${#INPUTS[@]} clip(s) + intro)"
